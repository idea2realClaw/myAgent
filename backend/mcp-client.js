// ============================================================
// MCP Client — 移植自 qaimodelbuilder mcp_client.py（stdio / sse / http）
//
// 通过子进程 stdio 启动 MCP server，走 JSON-RPC 2.0 协议：
//   initialize → (await) → notifications/initialized → tools/list / tools/call
//
// 默认实现 stdio 传输（最常见的 MCP 部署形态）；sse / http 留作扩展点。
// 远端工具通过 registerMCPTools() 动态注册进 MyAgent 的 tool-registry，
// 使 LLM 能像调用本地工具一样调用 MCP server 提供的工具。
//
// 设计边界（与 qaimodelbuilder 一致）：
//  - 客户端是无状态的请求/响应 + 通知；不托管 MCP server 的生命周期以外逻辑。
//  - 所有远端调用带超时，避免挂死。
// ============================================================

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const DEFAULT_TIMEOUT_MS = 30000;

export class MCPClient extends EventEmitter {
  /**
   * @param {object} config
   *   name     - 服务器标识
   *   command  - 启动命令（stdio 模式，如 npx / python）
   *   args?    - 命令参数数组
   *   env?     - 额外环境变量
   *   cwd?     - 工作目录
   *   transport? - 'stdio' | 'sse' | 'http'（当前仅 stdio 完整实现）
   *   url?     - sse/http 模式地址
   *   timeout? - 单次调用超时(ms)
   */
  constructor(config) {
    super();
    this.name = config.name || 'mcp';
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.cwd = config.cwd || undefined;
    this.transport = config.transport || 'stdio';
    this.url = config.url || null;
    this.timeout = config.timeout || DEFAULT_TIMEOUT_MS;

    this.proc = null;
    this._reqId = 0;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._buf = '';
    this.connected = false;
    this.serverInfo = null;
    this._closed = false;
  }

  // ── 连接并初始化 ──
  async connect() {
    if (this.transport !== 'stdio') {
      throw new Error(`MCP transport '${this.transport}' not implemented yet (only 'stdio')`);
    }
    await this._startStdio();
    // initialize
    const initResult = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'MyAgent', version: '1.0.0' },
    });
    this.serverInfo = initResult.serverInfo || null;
    // 通知 initialized
    this._notify('notifications/initialized', {});
    this.connected = true;
    return this;
  }

  _startStdio() {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.command, this.args, {
          env: { ...process.env, ...this.env },
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true, // 隐藏 MCP 子进程（如 npx 启动的 cmd 包装）控制台窗口
        });
      } catch (err) {
        return reject(err);
      }

      this.proc.on('error', (err) => {
        this.emit('error', err);
        this._failAllPending(err);
      });
      this.proc.on('exit', (code) => {
        this.connected = false;
        this.emit('exit', code);
        this._failAllPending(new Error(`MCP server '${this.name}' exited (code ${code})`));
      });
      if (this.proc.stderr) {
        this.proc.stderr.on('data', (d) => {
          const s = d.toString();
          if (s.trim()) this.emit('stderr', s.trim());
        });
      }
      this.proc.stdout.on('data', (d) => this._onStdout(d.toString()));

      // 给进程一点启动时间；initialize 请求会验证连通性
      this.proc.on('spawn', () => resolve());
      // 兜底：若 spawn 事件未触发，短延时后 resolve
      setTimeout(resolve, 300).unref?.();
    });
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行忽略
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    // 响应（有 id）
    if (msg.id !== undefined && msg.id !== null) {
      const pend = this._pending.get(msg.id);
      if (!pend) return;
      clearTimeout(pend.timer);
      this._pending.delete(msg.id);
      if (msg.error) pend.reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
      else pend.resolve(msg.result);
      return;
    }
    // 通知（无 id）：忽略或转发
    if (msg.method) {
      this.emit('notification', msg);
    }
  }

  _request(method, params) {
    if (!this.proc) return Promise.reject(new Error('MCP not connected'));
    const id = ++this._reqId;
    const payload = { jsonrpc: '2.0', id, method, params: params || {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${this.timeout}ms`));
      }, this.timeout);
      this._pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  _notify(method, params) {
    if (!this.proc) return;
    const payload = { jsonrpc: '2.0', method, params: params || {} };
    try {
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    } catch { /* ignore */ }
  }

  _failAllPending(err) {
    for (const [, pend] of this._pending) {
      clearTimeout(pend.timer);
      pend.reject(err);
    }
    this._pending.clear();
  }

  // ── 列出远端工具 ──
  async listTools() {
    if (!this.connected) await this.connect();
    const res = await this._request('tools/list', {});
    return (res.tools || []).map((t) => this._normalizeTool(t));
  }

  _normalizeTool(t) {
    return {
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    };
  }

  // ── 调用远端工具 ──
  async callTool(name, args = {}) {
    if (!this.connected) await this.connect();
    const res = await this._request('tools/call', { name, arguments: args });
    const content = Array.isArray(res.content)
      ? res.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
      : JSON.stringify(res);
    return {
      success: !res.isError,
      output: content,
      isError: !!res.isError,
    };
  }

  async close() {
    this._closed = true;
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = null;
    }
    this.connected = false;
  }
}

// ── 把 MCP server 的工具动态注册进 MyAgent 的 ToolRegistry ──
// @param {MCPClient} client
// @param {ToolRegistry} registry  - MyAgent registry 实例（含 register 方法）
// @param {string} prefix?         - 工具名前缀（避免与本地工具冲突），默认 'mcp_<server>_'
export async function registerMCPTools(client, registry, prefix) {
  const tools = await client.listTools();
  const pfx = prefix || `mcp_${client.name}_`;
  const registered = [];
  for (const t of tools) {
    const toolName = `${pfx}${t.name}`;
    // 把 JSON schema 的 properties 简化成 registry 需要的 {type, description, required}
    const props = t.inputSchema?.properties || {};
    const required = t.inputSchema?.required || [];
    const params = {};
    for (const [k, v] of Object.entries(props)) {
      params[k] = {
        type: typeof v.type === 'string' ? v.type : 'string',
        description: v.description || '',
        required: required.includes(k),
      };
    }
    registry.register({
      name: toolName,
      description: `[MCP:${client.name}] ${t.description}`,
      parameters: params,
      handler: async (args) => {
        const r = await client.callTool(t.name, args || {});
        return { stdout: r.output, exitCode: r.success ? 0 : 1, isError: !r.success };
      },
    });
    registered.push(toolName);
  }
  return registered;
}

export default MCPClient;
