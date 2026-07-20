// ============================================================
// Main Server — Express + WebSocket
// Agent WebUI Backend
// Features: Multi-provider support (QGenie, Local, OpenAI, Anthropic)
// ============================================================

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);

import { LLMAdapter } from './llm-adapter.js';
import { SkillLoader } from './skill-loader.js';
import { SkillExecutor, extractExecutionCommand } from './skill-executor.js';
import { IdentityManager } from './identity-manager.js';
import { TaskOrchestrator } from './task-orchestrator.js';
import { executeTool, execStream, buildToolInstructions, TOOL_SCHEMAS, TOOL_SCHEMAS_OPENAI } from './tool-executor.js';
import { registry as toolRegistry } from './tool-registry.js';
import { SingleAgentTurnKernel, buildSendWire } from './agent-kernel.js';
import { SubAgentManager } from './subagent.js';
import { SubAgentSessionStore } from './subagent-session-store.js';
import { MCPClient, registerMCPTools } from './mcp-client.js';
import { AgentTemplateStore } from './agent-template-store.js';
import { RosterTemplateStore } from './roster-template-store.js';
import { ModeTemplateStore } from './mode-template-store.js';
import { runDiscussion } from './discussion-manager.js';
import { truncateToolResult, estimateWireTokens } from './context-manager.js';
import { SnapshotManager } from './snapshot-manager.js';
import { PermissionManager } from './permission-manager.js';
import { AgentsMdLoader } from './agents-md-loader.js';
import { feishuConfig, loadConfig as loadFeishuConfig, saveConfig as saveFeishuConfig, sendMessage as sendFeishuMessage, replyMessage as replyFeishuMessage, updateMessage as updateFeishuMessage, setMessageProcessor, setBroadcaster, createWebhookMiddleware, handleWebhookEvent, getStatus as getFeishuStatus, testConnection as testFeishuConnection } from './channels/feishu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const IDENTITY_DIR = path.join(ROOT_DIR, '.workbuddy', 'memory');
const SKILLS_DIR = ROOT_DIR;
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

// ============================================================
// Create required directories on startup (MUST be before logging setup)
// ============================================================
[IDENTITY_DIR, LOGS_DIR, path.join(ROOT_DIR, 'backend', 'logs')].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Startup] Created directory: ${dir}`);
  }
});

// ============================================================
// Logging to file (in addition to console)
// ============================================================
const logFile = fs.createWriteStream(path.join(LOGS_DIR, 'myagent.log'), { flags: 'a' });
const logFileError = fs.createWriteStream(path.join(LOGS_DIR, 'myagent-error.log'), { flags: 'a' });

// Add error handlers to log streams
logFile.on('error', (err) => {
  console.error('[Logging] Failed to write to log file:', err.message);
});
logFileError.on('error', (err) => {
  console.error('[Logging] Failed to write to error log file:', err.message);
});

function logToFile(level, ...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${timestamp}] [${level}] ${message}\n`;
  try {
    logFile.write(line);
    if (level === 'error') logFileError.write(line);
  } catch (err) {
    origError('[Logging] Failed to write to log file:', err.message);
  }
}

// Override console methods to also write to file
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args) => { origLog(...args); logToFile('info', ...args); };
console.warn = (...args) => { origWarn(...args); logToFile('warn', ...args); };
console.error = (...args) => { origError(...args); logToFile('error', ...args); };

// ============================================================
// Config persistence
// Default: QGenie provider
// ============================================================

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch { /* ignore */ }
  }
  return {
    provider: 'qgenie', // Default changed from openrouter to qgenie
    model: 'default',
    apiKey: '',
    baseURL: 'http://127.0.0.1:8910/v1', // Default to local GenieAPIService
    temperature: 0.7,
    // Per-provider configs
    providers: {
      qgenie: { apiKey: '', baseURL: 'https://qgenie.example.com/v1', model: 'default' },
      local: { apiKey: '', baseURL: 'http://127.0.0.1:8910/v1', model: 'default' },
      openai: { apiKey: '', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
      openrouter: { apiKey: '', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o' },
      anthropic: { apiKey: '', baseURL: '', model: 'claude-opus-4-20250514' },
    },
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ============================================================
// Status cache (for heartbeat)
// ============================================================

let statusCache = {
  backend: 'ok',
  backendVersion: '1.0.0',
  model: 'unknown',
  modelMessage: 'Not checked yet',
  lastChecked: null,
};

/**
 * Check model connection for multiple providers
 */
async function checkModelConnection(config) {
  const { provider, apiKey, baseURL } = config;

  // Local provider: check if GenieAPIService is running
  if (provider === 'local') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`${baseURL || 'http://127.0.0.1:8910/v1'}/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        return { status: 'ok', message: 'Local LLM (GenieAPIService) reachable' };
      }
      return { status: 'error', message: `Local LLM returned ${resp.status}` };
    } catch (err) {
      return { status: 'error', message: `Local LLM unreachable: ${err.message}. Please start GenieAPIService on port 8910.` };
    }
  }

  // QGenie: skip network check (intranet VPN environment)
  if (provider === 'qgenie') {
    if (!apiKey) {
      return { status: 'error', message: 'No API key configured for QGenie' };
    }
    return { status: 'ok', message: 'QGenie ready (intranet, skip network check)' };
  }

  // Cloud providers: check API endpoint
  if (!apiKey) {
    return { status: 'error', message: 'No API key configured' };
  }

  const url = `${baseURL || 'https://api.openai.com/v1'}/models`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (resp.ok) {
      return { status: 'ok', message: 'Model API reachable' };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { status: 'ok', message: 'Model API reachable (auth required)' };
    }
    return { status: 'error', message: `Model API returned ${resp.status}` };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { status: 'error', message: 'Model API timeout' };
    }
    return { status: 'error', message: `Model API unreachable: ${err.message}` };
  }
}

async function refreshStatus() {
  const cfg = loadConfig();
  const modelCheck = await checkModelConnection(cfg);
  statusCache = {
    backend: 'ok',
    backendVersion: '1.0.0',
    model: modelCheck.status,
    modelMessage: modelCheck.message,
    lastChecked: new Date().toISOString(),
  };
  return statusCache;
}

// ============================================================
// App init
// ============================================================

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT_DIR, 'frontend', 'dist')));

// ============================================================
// Singletons
// ============================================================

const identity = new IdentityManager(IDENTITY_DIR);
identity.load();

const skillLoader = new SkillLoader(ROOT_DIR);
skillLoader.load();

// 技能执行器：解析 SKILL.md 中的执行命令并真正运行（确保命令完整执行，而非只给计划）
const skillExecutor = new SkillExecutor(skillLoader, ROOT_DIR);

const snapshotManager = new SnapshotManager();
await snapshotManager.load();

const permissionManager = new PermissionManager();

const agentsMdLoader = new AgentsMdLoader();
await agentsMdLoader.load();

// ── Agent 能力层（移植自 qaimodelbuilder） ──
// 共享回合内核（main / 子 agent 共用）
const agentKernel = new SingleAgentTurnKernel();

// 子 Agent 会话持久化库（JSON 文件，替代 qaimodelbuilder 的 SQLite chat_subagent_session）
const subAgentSessionStore = new SubAgentSessionStore();

// 子 Agent 会话状态变化 → 广播给所有客户端（多客户端 fan-out）
function broadcastSubAgentSession(summary) {
  const msg = JSON.stringify(summary);
  if (typeof wss !== 'undefined' && wss && wss.clients) {
    wss.clients.forEach((c) => {
      if (c.readyState === c.OPEN) c.send(msg);
    });
  }
}

// 通用广播：把任意对象帧发给所有 WS 客户端（resume 实时进度用）
function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  if (typeof wss !== 'undefined' && wss && wss.clients) {
    wss.clients.forEach((c) => {
      if (c.readyState === c.OPEN) c.send(msg);
    });
  }
}

// 子 Agent 管理器：主 Agent 通过 `agent` 工具派生子 Agent（深度限制 + 并行 + profile）
const subAgentManager = new SubAgentManager({
  createLLM: (cfg) => new LLMAdapter(cfg),
  toolRunner: (call) => executeTool(call),
  getToolSchemas: () => getAllOpenAIToolSchemas(),
  skillLoader,
  agentsMdLoader,
  llmConfig: { provider: 'openrouter', apiKey: '', model: '', baseURL: 'https://openrouter.ai/api/v1' },
  sessionStore: subAgentSessionStore,
  onSessionUpdate: broadcastSubAgentSession,
});

// ── 子 Agent 唤醒/续跑（resume/wake）共享执行器 ──
// 设置子 Agent 同源 LLM 配置后，迭代 resumeEvents 并把每个 subagent_* 事件
// （已带 session_id）广播给所有客户端，供前端实时续显。
async function runResume(sessionId, prompt, ownerTabId) {
  const cfg = loadConfig();
  subAgentManager.llmConfig = {
    provider: cfg.provider || 'openrouter',
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL:
      cfg.provider === 'openrouter'
        ? (cfg.baseURL || 'https://openrouter.ai/api/v1')
        : (cfg.baseURL || undefined),
  };
  for await (const ev of subAgentManager.resumeEvents({ sessionId, prompt, ownerTabId })) {
    broadcastToAll(ev);
  }
}

// ── 用户接管后续跑（user take-over：手动发消息）共享执行器 ──
// 与 runResume 同源，仅把 resumeEvents 的 mode 置为 'user_message'，
// 完成后会话保持 USER_OWNED，支持用户在面板里持续对话。
async function runUserMessage(sessionId, prompt, ownerTabId) {
  const cfg = loadConfig();
  subAgentManager.llmConfig = {
    provider: cfg.provider || 'openrouter',
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL:
      cfg.provider === 'openrouter'
        ? (cfg.baseURL || 'https://openrouter.ai/api/v1')
        : (cfg.baseURL || undefined),
  };
  for await (const ev of subAgentManager.resumeEvents({ sessionId, prompt, ownerTabId, mode: 'user_message' })) {
    broadcastToAll(ev);
  }
}

// MCP 客户端集合（按需从配置连接；默认无 → 不连接）
const mcpClients = new Map(); // name -> MCPClient

// 默认 LLM 配置（子 Agent / 内核同源路由用，运行时由 handleChat 用会话配置覆盖）
function defaultLlmConfig() {
  const cfg = loadConfig();
  return {
    provider: cfg.provider || 'openrouter',
    apiKey: cfg.apiKey || '',
    model: cfg.model || '',
    baseURL: cfg.provider === 'openrouter' ? (cfg.baseURL || 'https://openrouter.ai/api/v1') : (cfg.baseURL || undefined),
  };
}
subAgentManager.llmConfig = defaultLlmConfig();

// Agent 模板库（JSON 文件持久化，替代 qaimodelbuilder 的 SQLite chat_agent_template）
const agentTemplateStore = new AgentTemplateStore();

// 讨论模式 / 多 Agent 编排模板库（roster=谁参与, mode=怎么协作）
const rosterTemplateStore = new RosterTemplateStore();
const modeTemplateStore = new ModeTemplateStore();

// 动态构建完整的 OpenAI 函数调用工具 schema（含本地工具 + agent + skill + mcp）
function toOpenAIParams(parameters) {
  const props = {};
  const required = [];
  for (const [k, v] of Object.entries(parameters || {})) {
    props[k] = { type: v.type || 'string', description: v.description || '' };
    if (v.required) required.push(k);
  }
  return { type: 'object', properties: props, required };
}

function getAllOpenAIToolSchemas() {
  const tools = toolRegistry.getAllTools().map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: toOpenAIParams(t.parameters) },
  }));
  // agent 工具（派生子 Agent）
  tools.push(subAgentManager.buildAgentToolSchema());
  // skill 工具（按需加载 skill 全文）
  const skillSchema = skillLoader.toToolSchema();
  if (skillSchema.function.parameters.properties.name.enum.length > 0) {
    tools.push(skillSchema);
  }
  return tools;
}

// 启动配置的 MCP servers（若有），把远端工具注册进 registry
async function initMCP() {
  const cfg = loadConfig();
  const servers = Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [];
  for (const s of servers) {
    if (!s || !s.name || !s.command) continue;
    try {
      const client = new MCPClient(s);
      await client.connect();
      const registered = await registerMCPTools(client, toolRegistry, `mcp_${s.name}_`);
      mcpClients.set(s.name, client);
      console.log(`[MCP] Connected '${s.name}', registered ${registered.length} tools`);
    } catch (err) {
      console.error(`[MCP] Failed to connect '${s.name}': ${err.message}`);
    }
  }
}
// 延迟连接，不阻塞启动
initMCP().catch((e) => console.error('[MCP] init error:', e.message));

// ============================================================
// Agent Templates REST API（移植自 qaimodelbuilder _agent.py）
// 轻量级 JSON 持久化，与前端 Agent 模板面板对接
// ============================================================

app.get('/api/chat/agent-templates', (_req, res) => {
  try {
    const items = agentTemplateStore.list().map((r) => agentTemplateStore.toWire(r));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat/agent-templates', (req, res) => {
  try {
    const rec = agentTemplateStore.create(req.body);
    res.status(201).json(agentTemplateStore.toWire(rec));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/chat/agent-templates/:id', (req, res) => {
  try {
    const rec = agentTemplateStore.update(req.params.id, req.body);
    res.json(agentTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else if (err.message.includes('built-in')) res.status(400).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.delete('/api/chat/agent-templates/:id', (req, res) => {
  try {
    agentTemplateStore.delete(req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else if (err.message.includes('built-in')) res.status(400).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.post('/api/chat/agent-templates/:id/clone', (req, res) => {
  try {
    const rec = agentTemplateStore.clone(req.params.id);
    res.status(201).json(agentTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.post('/api/chat/agent-templates/:id/reset', (req, res) => {
  try {
    const rec = agentTemplateStore.reset(req.params.id);
    res.json(agentTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.post('/api/chat/agent-templates/:id/apply', (req, res) => {
  try {
    const applied = agentTemplateStore.apply(req.params.id);
    res.json({ applied });
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

// ============================================================
// Sub-Agent Sessions REST API（子 Agent 会话持久化 + 独立中断）
// ============================================================
// 列表：可按 root_conversation_id（= 主会话/父 tab id）过滤，缺省返回全部
app.get('/api/chat/subagents', (req, res) => {
  try {
    const root = req.query.root_conversation_id || req.query.session_id;
    const items = root
      ? subAgentSessionStore.listByRootConversation(root)
      : subAgentSessionStore.listAll();
    // 摘要列表不含完整 messages（详情端点才带 transcript）
    res.json({ items: items.map((s) => subAgentSessionStore.toSummary(s)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 详情：带完整结构化 transcript（messages）
app.get('/api/chat/subagents/:id', (req, res) => {
  try {
    const session = subAgentSessionStore.get(req.params.id);
    res.json({ session: subAgentSessionStore.toDetail(session) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') res.status(404).json({ error: err.message });
    else res.status(500).json({ error: err.message });
  }
});

// 独立中断某条子 Agent 会话（只停它自己，不影响主 Agent/其他子 Agent）
app.post('/api/chat/subagents/:id/interrupt', (req, res) => {
  try {
    // 解析会话（404 on miss，幂等）
    subAgentSessionStore.get(req.params.id);
    const aborted = subAgentManager._abortRegistry.abort(req.params.id);
    res.json({ ok: true, aborted });
  } catch (err) {
    if (err.code === 'NOT_FOUND') res.status(404).json({ error: err.message });
    else res.status(500).json({ error: err.message });
  }
});

// 设置子 Agent 自己的模型（预算分母真值源；不影响主 Agent）
app.patch('/api/chat/subagents/:id', (req, res) => {
  try {
    const session = subAgentSessionStore.get(req.params.id);
    const { model_id, model_provider } = req.body || {};
    subAgentSessionStore.setModel(session, model_id ?? null, model_provider ?? null);
    subAgentSessionStore.save(session);
    res.json({ session: subAgentSessionStore.toDetail(session) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

// 删除单条子 Agent 会话
app.delete('/api/chat/subagents/:id', (req, res) => {
  try {
    subAgentSessionStore.delete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'NOT_FOUND') res.status(404).json({ error: err.message });
    else res.status(500).json({ error: err.message });
  }
});

// 唤醒/续跑（resume/wake）：从已持久化的 transcript 断点继续。
// 立即返回受理状态，实际续跑在后台进行，进度经 WS 广播 subagent_* 事件。
app.post('/api/chat/subagents/:id/resume', (req, res) => {
  try {
    const session = subAgentManager._sessionStore.find(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'sub-agent session not found' });
    }
    const { prompt } = req.body || {};
    res.json({ ok: true, session_id: req.params.id, status: 'resuming' });
    // 后台续跑（不 await：进度经 WS 广播；异常兜底广播 error 帧）
    runResume(req.params.id, prompt || '', session.root_conversation_id || null).catch((e) => {
      broadcastToAll({ type: 'subagent_error', message: e.message, session_id: req.params.id });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 用户接管（user take-over）：把会话翻转为 USER_OWNED，允许用户在面板里手动发消息
app.post('/api/chat/subagents/:id/takeover', (req, res) => {
  try {
    const summary = subAgentManager.takeOver(req.params.id);
    if (!summary) return res.status(404).json({ error: 'sub-agent session not found' });
    res.json({ ok: true, session: summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 用户接管后续跑（手动发消息）：在 USER_OWNED（或可续跑）状态下，用户直接给子 Agent 发一条消息
app.post('/api/chat/subagents/:id/message', (req, res) => {
  try {
    const session = subAgentManager._sessionStore.find(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'sub-agent session not found' });
    }
    const { prompt } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    res.json({ ok: true, session_id: req.params.id, status: 'responding' });
    // 后台续跑（不 await：进度经 WS 广播；异常兜底广播 error 帧）
    runUserMessage(req.params.id, String(prompt).trim(), session.root_conversation_id || null).catch((e) => {
      broadcastToAll({ type: 'subagent_error', message: e.message, session_id: req.params.id });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Roster Templates REST API（讨论团队：谁参与）
// ============================================================
app.get('/api/chat/roster-templates', (_req, res) => {
  try {
    const items = rosterTemplateStore.list().map((r) => rosterTemplateStore.toWire(r));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat/roster-templates', (req, res) => {
  try {
    const rec = rosterTemplateStore.create(req.body);
    res.status(201).json(rosterTemplateStore.toWire(rec));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/chat/roster-templates/:id', (req, res) => {
  try {
    const rec = rosterTemplateStore.update(req.params.id, req.body);
    res.json(rosterTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.delete('/api/chat/roster-templates/:id', (req, res) => {
  try {
    rosterTemplateStore.delete(req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.post('/api/chat/roster-templates/:id/clone', (req, res) => {
  try {
    const rec = rosterTemplateStore.clone(req.params.id);
    res.status(201).json(rosterTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.post('/api/chat/roster-templates/:id/reset', (req, res) => {
  try {
    const rec = rosterTemplateStore.reset(req.params.id);
    res.json(rosterTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

// ============================================================
// Mode Templates REST API（协作模式：怎么协作）
// ============================================================
app.get('/api/chat/mode-templates', (_req, res) => {
  try {
    const items = modeTemplateStore.list().map((r) => modeTemplateStore.toWire(r));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat/mode-templates', (req, res) => {
  try {
    const rec = modeTemplateStore.create(req.body);
    res.status(201).json(modeTemplateStore.toWire(rec));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/chat/mode-templates/:id', (req, res) => {
  try {
    const rec = modeTemplateStore.update(req.params.id, req.body);
    res.json(modeTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.delete('/api/chat/mode-templates/:id', (req, res) => {
  try {
    modeTemplateStore.delete(req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.post('/api/chat/mode-templates/:id/clone', (req, res) => {
  try {
    const rec = modeTemplateStore.clone(req.params.id);
    res.status(201).json(modeTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

app.post('/api/chat/mode-templates/:id/reset', (req, res) => {
  try {
    const rec = modeTemplateStore.reset(req.params.id);
    res.json(modeTemplateStore.toWire(rec));
  } catch (err) {
    if (err.message.includes('not found')) res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});

// ============================================================
// WebSocket sessions
// ============================================================

const sessions = new Map(); // sessionId -> { ws, history, config }

function broadcast(ws, data) {
  // 统计本轮发出的工具调用/结果事件，供"透明性安全网"判断是否真调了工具
  if (data && (data.type === 'tool_call' || data.type === 'tool_result')) {
    try { ws.__toolCallsThisTurn = (ws.__toolCallsThisTurn || 0) + 1; } catch { /* ignore */ }
  }
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Set up Feishu log broadcaster — sends Feishu logs to all WebSocket clients
setBroadcaster((level, message, data) => {
  const logMsg = JSON.stringify({
    type: 'log',
    level,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      ws.send(logMsg);
    }
  });
});

/**
 * Build system prompt (parameterized by provider)
 * - Local provider: use XML format for skills
 * - Cloud provider: use Markdown format
 * - Native function calling: inject short prompt
 */
function buildSystemPrompt(provider = 'openai') {
  const parts = [];

  // Identity block (injected but output is filtered)
  const identBlock = identity.buildSystemBlock();
  if (identBlock) parts.push(identBlock);

  // Skills (format depends on provider)
  const useXML = provider === 'local';
  const skillsSnippet = skillLoader.toSystemPromptSnippet(useXML);
  if (skillsSnippet) parts.push(skillsSnippet);

  // AGENTS.md project rules (injected if exists)
  const agentsMdSnippet = agentsMdLoader.toSystemPromptSnippet();
  if (agentsMdSnippet) parts.push(agentsMdSnippet);

  // Base instructions
  const useNativeFunctionCalling = ['openai', 'openrouter', 'qgenie', 'local'].includes(provider);
  parts.push(`You are a powerful AI Agent.
- When a user loads a skill by name, inject the skill's full content and follow its instructions.
- Decompose complex tasks into parallel subtasks when beneficial.
- Be direct, thorough, and resourceful.
- 当技能或工具返回结构化数据（JSON、表格、原始 API 输出等）时，必须先用自然语言向用户做总结：先给关键结论，再列出重要数字（如价格、涨跌幅、成交量、更新时间等），绝不要直接把原始 JSON 或原始数据原样粘贴给用户。
  - 透明性铁律（最高优先级，必须严格遵守）：
  (a) 只有当工具【真实执行】后，才可在回答中点出「我调用了 <工具名> 工具（数据来源：<真实来源>）」并简述取到了什么。**严禁凭空/想象声称调用了任何工具、或声称某数据来自某来源（如"数据来源：Google/Bing/百度"）**；若你实际上并未调用工具，就【绝不】写任何"我调用了 XX"或"数据来源：YY"的措辞——宁可少说，不可编造。
  (b) 凡本次回答全程未调用任何工具、仅依靠模型已有知识/训练经验作答，必须在回答最开头显式声明，例如：「我根据经验认为：…」或「（以下为基于我已有知识的回答，未经实时工具核实）…」。即使只是闲聊或常识性问题也要照此声明，绝不能把未经验证的内容伪装成已通过工具核实的事实。诚实永远优先于语句流畅。
  (c) 可用工具提示：联网搜索请用 web_search 工具（数据源 DuckDuckGo，**不是** Google/Bing）；deep-search 只是一个【技能/方法名】，**不是**可直接返回数据的工具，不要声称"调用了 deep-search 工具"或"数据来源：Google/Bing"。
- 股票历史/区间查询（如"过去五天""近一周""历史走势"）：调用 stock_price 工具时务必传入 range 参数（"5d"=过去5天、"1mo"=过去1月、"3mo"、"1y"），工具会返回 history 数组（每日 开盘/最高/最低/收盘/成交量），据此归纳趋势。绝不要用默认的"当前快照"冒充历史数据。
- Current date: ${new Date().toISOString().split('T')[0]}`);

  // Append tool usage instructions (parameterized)
  parts.push(buildToolInstructions(useNativeFunctionCalling));

  return parts.join('\n\n');
}

// ============================================================
// REST API
// ============================================================

// Health check (lightweight, no external calls)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Detailed status check (includes model connectivity)
app.get('/api/status', async (req, res) => {
  // If cache is fresh (< 30s), return it
  if (statusCache.lastChecked) {
    const age = Date.now() - new Date(statusCache.lastChecked).getTime();
    if (age < 30000) {
      return res.json(statusCache);
    }
  }
  // Otherwise refresh
  const status = await refreshStatus();
  res.json(status);
});

// Get config (API keys masked)
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  const providers = {};
  for (const [name, pcfg] of Object.entries(cfg.providers || {})) {
    providers[name] = {
      ...pcfg,
      apiKey: pcfg.apiKey ? '***' : '',
      hasApiKey: Boolean(pcfg.apiKey),
    };
  }
  res.json({
    provider: cfg.provider,
    model: cfg.model,
    hasApiKey: Boolean(cfg.apiKey),
    baseURL: cfg.baseURL || '',
    temperature: cfg.temperature ?? 0.7,
    providers,
  });
});

// Update config
app.post('/api/config', (req, res) => {
  const existing = loadConfig();
  const updated = { ...existing, ...req.body };
  // Mask API key if '***'
  if (req.body.apiKey === '***') {
    updated.apiKey = existing.apiKey;
  }
  saveConfig(updated);
  res.json({ success: true });
});

// List skills
app.get('/api/skills', (req, res) => {
  skillLoader.load(); // Reload fresh
  res.json(skillLoader.getAll());
});

// Get skill content
app.get('/api/skills/:name', (req, res) => {
  const content = skillLoader.getContent(req.params.name);
  if (!content) return res.status(404).json({ error: 'Skill not found' });
  res.json({ name: req.params.name, content });
});

// Get skill icon
app.get('/api/skills/:name/icon', (req, res) => {
  const iconPath = skillLoader.getIconPath(req.params.name);
  if (!iconPath || !fs.existsSync(iconPath)) {
    return res.status(404).json({ error: 'Icon not found' });
  }
  res.sendFile(iconPath);
});

// Get common skill directories (for folder browser)
app.get('/api/skills/paths', (req, res) => {
  const paths = skillLoader.getSearchPaths();
  res.json({ paths });
});

// Enable a skill
app.post('/api/skills/:name/enable', (req, res) => {
  skillLoader.enable(req.params.name);
  res.json({ success: true, enabled: true });
});

// Disable a skill
app.post('/api/skills/:name/disable', (req, res) => {
  skillLoader.disable(req.params.name);
  res.json({ success: true, enabled: false });
});

// Update skill mode (off/cloud/local/both)
app.post('/api/skills/:name/mode', (req, res) => {
  const { mode } = req.body;
  if (!['off', 'cloud', 'local', 'both'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode. Use: off, cloud, local, both' });
  }
  skillLoader.setMode(req.params.name, mode);
  res.json({ success: true, mode });
});

// Scan directory for skills
app.post('/api/skills/scan', (req, res) => {
  try {
    const { directory } = req.body;
    if (!directory) {
      return res.status(400).json({ error: 'directory required' });
    }
  
    console.log(`[API] Scanning directory: ${directory}`);
    const result = skillLoader.scanDirectory(directory);
    console.log(`[API] Scan result:`, result);
    res.json(result);
  } catch (err) {
    console.error(`[API] Error scanning directory:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Add skill from directory
app.post('/api/skills/add', (req, res) => {
  try {
    const { sourcePath, targetDir } = req.body;
    if (!sourcePath || !targetDir) {
      return res.status(400).json({ error: 'sourcePath and targetDir required' });
    }
  
    console.log(`[API] Adding skill from ${sourcePath} to ${targetDir}`);
    const result = skillLoader.addSkillFromPath(sourcePath, targetDir);
    console.log(`[API] Add result:`, result);
    res.json(result);
  } catch (err) {
    console.error(`[API] Error adding skill:`, err);
    res.status(500).json({ error: err.message });
  }
});

// 执行技能（/skill-name 的 REST 形态）：解析 SKILL.md 命令并真正运行
app.post('/api/skills/:name/run', async (req, res) => {
  const skillName = req.params.name;
  const { input = '', execute = true } = req.body || {};
  const skill = skillLoader.get(skillName);
  if (!skill) {
    return res.status(404).json({ error: `Skill not found: ${skillName}` });
  }
  const skillDir = path.dirname(skill.path);
  const execCmd = extractExecutionCommand(skill.content, skillDir);
  if (!execCmd) {
    return res.status(422).json({
      error: `Skill "${skillName}" has no directly executable command. It is instruction-only; invoke it in chat via /${skillName} to run through the agent loop.`,
    });
  }
  const safeInput = String(input == null ? '' : input).replace(/"/g, '\\"');
  const fullCmd = execCmd.replace(/\$1|\$INPUT|\{\{input\}\}/g, `"${safeInput}"`);
  try {
    const { stdout, stderr } = await execAsync(fullCmd, {
      cwd: skillDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
    });
    if (stderr) console.warn(`[Skill API] ${skillName} stderr:`, stderr);
    res.json({ success: true, skill: skillName, command: fullCmd, output: stdout || '' });
  } catch (err) {
    res.status(500).json({ success: false, skill: skillName, command: fullCmd, error: err.message });
  }
});

// Identity status
app.get('/api/identity', (req, res) => {
  res.json(identity.getSummary());
});

// Update Soul.md
app.post('/api/identity/soul', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  identity.updateSoul(content);
  res.json({ success: true });
});

// Get identity file content
app.get('/api/identity/file', (req, res) => {
  const { name } = req.query;
  const validFiles = ['ID.md', 'DNA.md', 'Soul.md'];
  if (!validFiles.includes(name)) {
    return res.status(400).json({ error: `Invalid file name. Valid: ${validFiles.join(', ')}` });
  }
  const filePath = path.join(IDENTITY_DIR, name);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ name, content });
  } catch {
    res.status(404).json({ error: `${name} not found` });
  }
});

// Save identity file content
app.post('/api/identity/file', (req, res) => {
  const { name, content } = req.body;
  const validFiles = ['ID.md', 'DNA.md', 'Soul.md'];
  if (!validFiles.includes(name)) {
    return res.status(400).json({ error: `Invalid file name. Valid: ${validFiles.join(', ')}` });
  }
  if (content === undefined || content === null) {
    return res.status(400).json({ error: 'content required' });
  }
  const filePath = path.join(IDENTITY_DIR, name);
  fs.writeFileSync(filePath, content, 'utf8');
  // Reload identity if it's the active identity file
  if (identity.files[name]) {
    identity.files[name.replace('.md', '').toLowerCase()] = null;
  }
  identity.load();
  res.json({ success: true, name });
});

// ============================================================
// File browser API
// ============================================================

// List directories at the given path
app.get('/api/files/list', (req, res) => {
  try {
    const dirPath = req.query.path || '/';
    
    // Security: only allow absolute paths
    if (!path.isAbsolute(dirPath)) {
      return res.status(400).json({ error: 'Absolute path required' });
    }
    
    if (!fs.existsSync(dirPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }
    
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const directories = entries
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        name: entry.name,
        path: path.join(dirPath, entry.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    res.json({
      currentPath: dirPath,
      parent: path.dirname(dirPath),
      directories
    });
  } catch (err) {
    console.error('[API] Error listing files:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Feishu Channel API
// ============================================================

// Feishu webhook endpoint
app.post('/api/channels/feishu/webhook', createWebhookMiddleware());

// Get Feishu config
app.get('/api/channels/feishu/config', (req, res) => {
  const status = getFeishuStatus();
  res.json({
    enabled: feishuConfig.enabled,
    appId: feishuConfig.appId || '',  // Don't mask App ID (not a secret)
    hasAppSecret: !!feishuConfig.appSecret,
    hasCredentials: !!(feishuConfig.appId && feishuConfig.appSecret),  // Add hasCredentials for frontend
    verificationToken: feishuConfig.verificationToken || '',  // Don't mask (not a secret)
    hasEncryptKey: !!feishuConfig.encryptKey,
    domain: feishuConfig.domain,
    status,
  });
});

// Update Feishu config
app.post('/api/channels/feishu/config', async (req, res) => {
  const { enabled, appId, appSecret, verificationToken, encryptKey, domain } = req.body;
  
  const updates = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (appId !== undefined) updates.appId = appId;
  if (appSecret !== undefined && appSecret !== '***') updates.appSecret = appSecret;
  if (verificationToken !== undefined) updates.verificationToken = verificationToken;
  if (encryptKey !== undefined && encryptKey !== '***') updates.encryptKey = encryptKey;
  if (domain !== undefined) updates.domain = domain;
  
  saveFeishuConfig(updates);
  
  // Re-initialize if needed
  if (updates.enabled) {
    loadFeishuConfig();
  }
  
  res.json({ success: true, status: getFeishuStatus() });
});

// Test Feishu connection
app.post('/api/channels/feishu/test', async (req, res) => {
  try {
    const result = await testFeishuConnection();
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============================================================
// WebSocket handler
// ============================================================

wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, { ws, history: [], config: loadConfig() });

  broadcast(ws, { type: 'session_init', sessionId });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) return;

    if (msg.type === 'chat') {
      await handleChat(sessionId, session, msg);
    } else if (msg.type === 'config_update') {
      session.config = { ...session.config, ...msg.config };
      saveConfig(session.config);
      broadcast(ws, { type: 'config_saved' });
    } else if (msg.type === 'clear_history') {
      session.history = [];
      broadcast(ws, { type: 'history_cleared' });
    } else if (msg.type === 'restore_history') {
      // Restore history from client
      if (msg.history && Array.isArray(msg.history)) {
        session.history = msg.history;
        broadcast(ws, { type: 'history_restored', count: msg.history.length });
      }
    } else if (msg.type === 'reload_skills') {
      skillLoader.load();
      broadcast(ws, { type: 'skills_reloaded', skills: skillLoader.getAll() });
    } else if (msg.type === 'stop') {
      // Set stop flag for this session
      session.stopRequested = true;
      // 级联取消：显式 signal 该会话派生出的所有运行中子 Agent（State-Truth-First）
      const cascaded = subAgentManager._abortRegistry.abortByOwnerTab(session.id);
      broadcast(ws, { type: 'stopped', message: 'Task stopped by user' });
      if (cascaded.length > 0) {
        broadcast(ws, { type: 'subagents_cascaded_abort', ids: cascaded });
      }
    } else if (msg.type === 'restart') {
      // Request graceful restart (daemon will handle this)
      broadcast(ws, { type: 'restarting', message: 'Server restarting...' });
      // Send SIGUSR1 to self (daemon will detect and restart)
      process.kill(process.pid, 'SIGUSR1');
    } else if (msg.type === 'exec_stream') {
      // Real-time streaming execution
      await handleExecStream(ws, session, msg);
    } else if (msg.type === 'undo') {
      // Undo last file edit
      const result = await snapshotManager.undo();
      broadcast(ws, { type: 'undo_result', ...result });
      if (result.success) {
        await snapshotManager.save();
      }
    } else if (msg.type === 'redo') {
      // Redo last undone action
      const result = await snapshotManager.redo();
      broadcast(ws, { type: 'redo_result', ...result });
      if (result.success) {
        await snapshotManager.save();
      }
    } else if (msg.type === 'approval_response') {
      // User responded to approval request
      const { id, approved } = msg;
      const handled = permissionManager.respondToApproval(id, approved);
      if (!handled) {
        broadcast(ws, { type: 'error', message: `Approval request ${id} not found` });
      }
    } else if (msg.type === 'apply_agent_template') {
      // 将某个 Agent 模板注入当前会话（作为追加 system prompt）
      try {
        const applied = agentTemplateStore.apply(msg.template_id);
        const roleText = applied.display_name || applied.name;
        const persona = applied.persona || '';
        const systemAddendum = `Applied agent role: ${roleText}${persona ? '\n\n' + persona : ''}`;
        session.history.push({ role: 'system', content: systemAddendum });
        broadcast(ws, { type: 'agent_template_applied', applied });
      } catch (err) {
        broadcast(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'init_agents_md') {
      // Initialize AGENTS.md template
      const result = await agentsMdLoader.init();
      broadcast(ws, { type: 'agents_md_init_result', ...result });
    } else if (msg.type === 'reload_agents_md') {
      // Reload AGENTS.md from disk
      await agentsMdLoader.load();
      broadcast(ws, { type: 'agents_md_reloaded', summary: agentsMdLoader.getSummary() });
    } else if (msg.type === 'start_discussion') {
      // 启动一次多 Agent 讨论（移植自 qaimodelbuilder 讨论编排）
      await handleStartDiscussion(ws, session, msg);
    } else if (msg.type === 'resume_subagent') {
      // 唤醒/续跑一个已持久化的子 Agent 会话（断点续跑）
      const { session_id, prompt } = msg;
      if (!session_id) {
        broadcast(ws, { type: 'error', message: 'resume_subagent requires session_id' });
      } else {
        // 后台续跑：进度经 WS 广播给所有客户端（不阻塞当前消息处理）
        runResume(session_id, prompt || '', session.id || null).catch((e) => {
          broadcastToAll({ type: 'subagent_error', message: e.message, session_id });
        });
      }
    } else if (msg.type === 'take_over_subagent') {
      // 用户接管：把子 Agent 会话翻转为 USER_OWNED（同步状态翻转）
      const { session_id } = msg;
      if (!session_id) {
        broadcast(ws, { type: 'error', message: 'take_over_subagent requires session_id' });
      } else {
        try {
          const summary = subAgentManager.takeOver(session_id);
          if (!summary) {
            broadcast(ws, { type: 'error', message: 'sub-agent session not found' });
          } else {
            // takeOver 已通过 _emitSessionUpdate 广播 subagent_session_updated
            broadcast(ws, { type: 'take_over_ack', session_id, session: summary });
          }
        } catch (e) {
          broadcast(ws, { type: 'error', message: e.message });
        }
      }
    } else if (msg.type === 'user_message_subagent') {
      // 用户手动发消息（user take-over 续跑）：用户在面板里直接给子 Agent 发指令
      const { session_id, prompt } = msg;
      if (!session_id || !prompt || !String(prompt).trim()) {
        broadcast(ws, { type: 'error', message: 'user_message_subagent requires session_id and non-empty prompt' });
      } else {
        // 后台续跑：进度经 WS 广播给所有客户端（不阻塞当前消息处理）
        runUserMessage(session_id, String(prompt).trim(), session.id || null).catch((e) => {
          broadcastToAll({ type: 'subagent_error', message: e.message, session_id });
        });
      }
    }
  });

  ws.on('close', () => {
    sessions.delete(sessionId);
  });
});

// ============================================================
// Direct tool/command execution (no LLM needed)
// ============================================================

async function handleDirectExecution(ws, session, toolCall, rawInput) {
  const { history } = session;

  // Add user message to history
  history.push({ role: 'user', content: rawInput });

  const toolName = toolCall.name || 'shell_execute';
  broadcast(ws, { type: 'tool_call', tool: toolName, args: toolCall.arguments });

  const result = await executeTool(toolCall);

  broadcast(ws, {
    type: 'tool_result',
    success: result.success,
    output: result.output,
  });

  const answer = `## Execution Result\n\n${result.output}`;
  history.push({ role: 'assistant', content: answer });

  broadcast(ws, {
    type: 'done',
    content: answer,
    subtasks: [],
  });
}

// ============================================================
// Skill Execution — /skill-name input 直接执行（解析 SKILL.md 中的命令并真跑）
// 移植自旧 main 的 handleSkillExecution，确保技能命令完整执行而非只给计划
// ============================================================

async function handleSkillExecution(ws, session, userMessage) {
  const { history } = session;
  // 记录用户消息到历史（slash 命令本身也作为一轮对话）
  history.push({ role: 'user', content: userMessage });

  const match = userMessage.trim().match(/^\/([^\s{]+)\s*([\s\S]*)/);
  if (!match) {
    const err = '无效的 skill 调用格式。请使用: /skill-name input';
    broadcast(ws, { type: 'error', message: err });
    history.push({ role: 'assistant', content: err });
    broadcast(ws, { type: 'done', content: err, subtasks: [] });
    return;
  }

  const skillName = match[1];
  const input = match[2].trim();
  let parsedInput = input;
  let cmdInput = input;
  try {
    parsedInput = JSON.parse(input);
    cmdInput = typeof parsedInput === 'object'
      ? (parsedInput.question || parsedInput.input || parsedInput.query || JSON.stringify(parsedInput))
      : input;
  } catch { /* 纯文本输入，cmdInput 保持原文 */ }

  const skill = skillLoader.get(skillName);
  if (!skill) {
    const available = skillLoader.getAll().map(s => s.name).join(', ');
    const msgText = `Skill 未找到: ${skillName}\n\n可用的 skills: ${available}`;
    broadcast(ws, { type: 'tool_call', tool: 'skill', args: { skill: skillName } });
    broadcast(ws, { type: 'tool_result', success: false, output: msgText });
    history.push({ role: 'assistant', content: msgText });
    broadcast(ws, { type: 'done', content: msgText, subtasks: [] });
    return;
  }

  broadcast(ws, { type: 'thinking', message: `🔧 执行 Skill: ${skillName}...` });
  broadcast(ws, {
    type: 'tool_call',
    tool: 'skill',
    args: { skill: skillName, input: typeof cmdInput === 'string' ? cmdInput : JSON.stringify(cmdInput) },
  });

  const skillDir = path.dirname(skill.path);
  const execCmd = extractExecutionCommand(skill.content, skillDir);

  // 无直接可执行命令 → 转交 Agent 循环，按 SKILL.md 指引用工具真正执行（而非只出计划）
  if (!execCmd) {
    broadcast(ws, {
      type: 'tool_result',
      success: true,
      output: `Skill "${skillName}" 无直接可执行命令，转交 Agent 循环按指引执行...`,
    });
    await runSkillViaAgentLoop(ws, session, skillName);
    return;
  }

  const safeInput = String(cmdInput == null ? '' : cmdInput).replace(/"/g, '\\"');
  const fullCmd = execCmd.replace(/\$1|\$INPUT|\{\{input\}\}/g, `"${safeInput}"`);

  broadcast(ws, { type: 'thinking', message: `⚙️ 运行中: ${fullCmd}` });

  try {
    const { stdout, stderr } = await execAsync(fullCmd, {
      cwd: skillDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
    });
    if (stderr) console.warn(`[Skill] ${skillName} stderr:`, stderr);
    const output = stdout || 'Skill 执行完成（无输出）';
    broadcast(ws, { type: 'tool_result', success: true, output: truncateToolResult(output) });

    // 用 LLM 把原始执行结果转成自然语言总结，作为最终回答（原始结果已在 tool_result 透明展示）
    let answer = `## Skill 执行结果: ${skillName}\n\n${output}`;
    try {
      const llm = buildLlmFromSession(session);
      broadcast(ws, { type: 'thinking', message: '✍️ 正在生成自然语言总结...' });
      const summary = await summarizeSkillResult(llm, userMessage, output);
      answer = summary;
    } catch (sumErr) {
      console.warn('[Skill] 自然语言总结生成失败，回退原始结果:', sumErr.message);
    }

    history.push({ role: 'assistant', content: answer });
    broadcast(ws, {
      type: 'done',
      content: answer,
      subtasks: [{ id: `skill_${skillName}`, title: `执行 ${skillName}`, status: 'done' }],
    });
  } catch (err) {
    const msgText = `Skill 执行失败: ${err.message}`;
    console.error(`[Skill] Error executing ${skillName}:`, err);
    broadcast(ws, { type: 'tool_result', success: false, output: msgText });
    history.push({ role: 'assistant', content: msgText });
    broadcast(ws, { type: 'done', content: msgText, subtasks: [] });
  }
}

// 根据 session 配置构造 LLM（与 runSkillViaAgentLoop 保持一致）
function buildLlmFromSession(session) {
  const cfg = { ...loadConfig(), ...(session && session.config) };
  return new LLMAdapter({
    provider: cfg.provider || 'qgenie',
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL: cfg.provider === 'openrouter'
      ? (cfg.baseURL || 'https://openrouter.ai/api/v1')
      : cfg.baseURL || undefined,
  });
}

// 用 LLM 把技能的原始执行结果转成自然语言总结（失败则调用方回退到原始结果）
async function summarizeSkillResult(llm, userQuestion, rawOutput) {
  const sys = [
    '你是一名数据助手的总结员。用户用自然语言提出了一个问题，某个技能返回了结构化或原始数据。',
    '请用与用户相同的语言（中文用户用中文），写一段简洁、口语化、直接回答用户问题的自然语言总结。',
    '要点：先给关键结论，再列出重要数字（例如价格、涨跌幅、成交量、更新时间等），必要时补充一句简短说明。',
    '不要原样重复原始 JSON 或大段结构化数据，不要用代码块包裹原始输出。控制在 3-5 句话。',
  ].join('\n');
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: `用户问题：${userQuestion}\n\n技能返回的原始结果：\n${rawOutput}` },
  ];
  const summary = await llm.chat(messages, { temperature: 0.3, maxTokens: 500 });
  return (summary || '').trim() || rawOutput;
}

// 指令型技能：交给统一 Agent 循环执行（模型会按 SKILL.md 指引调用工具真正干活）
async function runSkillViaAgentLoop(ws, session, skillName) {
  const { history, config } = session;
  const cfg = { ...loadConfig(), ...config };
  const llmConfig = {
    provider: cfg.provider || 'qgenie',
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL: cfg.provider === 'openrouter'
      ? (cfg.baseURL || 'https://openrouter.ai/api/v1')
      : cfg.baseURL || undefined,
  };
  const llm = new LLMAdapter(llmConfig);
  const system = buildSystemPrompt(cfg.provider);
  broadcast(ws, { type: 'thinking', message: `🧠 正在按 ${skillName} 技能指引执行任务（含工具调用）...` });
  try {
    await runAgentLoop({ ws, session, llm, system, history, config: cfg, useTools: true });
  } catch (err) {
    broadcast(ws, { type: 'error', message: err.message });
  }
}

// ============================================================
// execStream — Real-time streaming execution
// ============================================================

async function handleExecStream(ws, session, msg) {
  const { command, workdir } = msg;

  broadcast(ws, { type: 'exec_start', command });

  try {
    const stream = execStream({ command, workdir });
    
    for await (const event of stream) {
      if (event.type === 'stdout' || event.type === 'stderr') {
        broadcast(ws, {
          type: 'exec_output',
          stream: event.type === 'stdout' ? 'stdout' : 'stderr',
          data: event.data,
        });
      } else if (event.type === 'done') {
        broadcast(ws, {
          type: 'exec_done',
          exitCode: event.exitCode,
          success: event.success,
        });
      }
    }
  } catch (err) {
    broadcast(ws, {
      type: 'exec_error',
      error: err.message,
    });
  }
}

// ============================================================
// Question Analysis — simple vs complex (LLM-based)
// ============================================================

async function classifyQuestion(llm, userMessage) {
  const trimmed = userMessage.trim().toLowerCase();

  // ① 含 URL → 必然需要联网/工具（web_fetch / web_search / shell），直接判 complex，跳过 LLM
  if (/https?:\/\//i.test(trimmed)) return 'complex';

  // Action words that always trigger complex decomposition (even if short)
  const actionWords = [
    '搜索', '查找', '找', '查', '读', '写', '改', '删', '创建',
    '执行', '运行', '安装', '下载', '上传',
    '分析', '统计', '对比', '比较', '列出', '显示', '打开', '查看', '看看', '浏览',
    'github', '分支', 'branches', 'branch', '仓库', 'repo', 'api', '网页', '网站',
    'search', 'find', 'read', 'write', 'edit', 'delete', 'create',
    'run', 'exec', 'install', 'download', 'upload',
    'analyze', 'list', 'grep', 'glob', 'fetch', 'curl', 'browse', 'open',
    // 实时金融 / 行情查询：必须走带工具路径去真实拉取数据
    '价格', '股价', '行情', '市值', '指数', '汇率', '基金', '涨跌', '多少', '报价',
    'etf', 'stock', 'price', 'quote', 'ticker',
    // 实时 / 新闻 / 当前信息：必须走带工具路径，避免模型凭记忆编造
    '最新', '新闻', '消息', '比赛', '赛果', '比分', '今日', '今天', '昨天', '现在', '当前', '实时', '天气',
    'news', 'latest', 'result', 'score', 'today', 'weather', 'live', 'update', 'current',
  ];
  for (const aw of actionWords) {
    if (trimmed.includes(aw)) return 'complex';
  }

  // 5 characters or less → simple (only if not an action word — already checked above)
  if (trimmed.length <= 5) return 'simple';

  // Obvious greetings → skip LLM call
  const greetings = ['你好','您好','hi','hello','谢谢','thanks','再见','拜拜','好的','好','行','ok','OK'];
  for (const g of greetings) {
    if (trimmed === g || trimmed.startsWith(g)) return 'simple';
  }

  // Use LLM to classify: cheap single-token completion
  try {
    const messages = [
      { role: 'system', content: 'You are a classifier. Respond with exactly one word: "simple" for a question that can be answered directly with general knowledge, greetings, opinions, or simple explanations. Respond "complex" if the question requires file operations, web research, code execution, searching, shell commands, multi-step analysis, or modifying files. Do NOT include any other text.' },
      { role: 'user', content: trimmed },
    ];
    const result = await llm.chat(messages, { temperature: 0, maxTokens: 10 });
    const classification = result.trim().toLowerCase();
    if (classification.includes('complex')) return 'complex';
    return 'simple';
  } catch {
    // Fallback: if LLM call fails, default to complex (safe choice)
    return 'complex';
  }
}

// ============================================================
// 股票价格硬路由 —— 识别"X 价格/行情"类查询，强制调真实工具再总结，杜绝编造
// ============================================================

// 常见非股票代码词（避免把普通英文词误当代码）
const STOCK_STOP_WORDS = new Set([
  'ETF', 'AI', 'API', 'US', 'CN', 'HK', 'UK', 'OK', 'THE', 'AND', 'FOR', 'WEB', 'APP', 'GET',
  'SET', 'NEW', 'TOP', 'LOW', 'HIGH', 'OPEN', 'CLOSE', 'BUY', 'SELL', 'PRICE', 'FIELD', 'FILE',
  'CODE', 'DATA', 'TYPE', 'NAME', 'TEXT', 'JSON', 'HTML', 'URL', 'HTTP', 'SHELL', 'QUERY', 'TEST',
  'TRUE', 'FALSE', 'NULL', 'NONE', 'ALL', 'RMB', 'USD', 'CNY', 'HKD', 'EUR', 'JPY', 'BTC', 'ETH',
  'STOCK', 'QUOTE', 'TICKER', 'NASDAQ', 'PRICES', 'ETF',
]);
// 中文股票名 → 代码
const STOCK_NAME_MAP = {
  '腾讯': '0700.HK', '腾讯控股': '0700.HK',
  '阿里': '9988.HK', '阿里巴巴': '9988.HK',
  '美团': '3690.HK', '小米': '1810.HK', '京东': '9618.HK', '网易': '9999.HK', '百度': '9888.HK',
  '苹果': 'AAPL', '微软': 'MSFT', '谷歌': 'GOOGL', '亚马逊': 'AMZN', '特斯拉': 'TSLA',
  '英伟达': 'NVDA', '高通': 'QCOM', 'Meta': 'META', '脸书': 'META',
  '贵州茅台': '600519.SS', '宁德时代': '300750.SZ', '招商银行': '600036.SS',
  '平安银行': '000001.SZ', '万科': '000002.SZ',
};
// 含这些词 → 问题超出"当前快照"工具能力（需历史序列 / 时间区间 / 深度分析），
// 不再硬调 stock_price，交给 Agent 循环理解并分解任务
const STOCK_LOOP_WORDS = [
  // 深度分析
  '分析', '为什么', '原因', '对比', '比较', '报告', '预测', '推荐', '该买', '该卖', '怎么看', '如何', '估值', '分红',
  // 历史 / 时间区间 / 序列（如"过去五天""近一周""历史价格"）
  '历史', 'k线', '走势', '过去', '近期', '最近', '几天', '一周', '两周', '一个月', '两个月', '一年', '半年',
  '本周', '本月', '今年', '上周', '上月', '以来', '区间', '每日', '每天', '趋势', '表现',
  // 英文
  'history', 'historical', 'past', 'last', 'recent', 'since', 'from', 'trend', 'weekly', 'daily', 'monthly', 'yearly',
];

function detectStockPriceQuery(text) {
  const t = (text || '').trim();
  if (!t) return null;
  // 剥离 "/stock-price" 命令前缀，避免把 stock/price 误当成代码
  let work = t;
  const cmdMatch = work.match(/^\/stock[-_]?price\b\s*/i);
  if (cmdMatch) work = work.slice(cmdMatch[0].length).trim();
  const lower = work.toLowerCase();
  const isPriceIntent = /(价格|股价|行情|报价|涨跌|市值|多少|实时|净值|基金)/.test(lower)
    || /\b(price|quote|stock|etf|ticker|nasdaq)\b/.test(lower)
    || cmdMatch != null;
  // 1) 中文名映射
  let symbol = null, raw = null;
  for (const [cn, code] of Object.entries(STOCK_NAME_MAP)) {
    if (lower.includes(cn.toLowerCase())) { symbol = code; raw = cn; break; }
  }
  // 2) 带市场后缀代码：0700.HK / 600519.SS / TLT.US
  if (!symbol) {
    const m = work.match(/\b(\d{4,6}\.(?:HK|SS|SZ))\b/i) || work.match(/\b([A-Za-z]{1,6}\.(?:HK|US|L|O|PA|N))\b/i);
    if (m) { symbol = m[1].toUpperCase(); raw = m[1]; }
  }
  // 3) 纯字母代码（2-5 字母，排除常见非代码词）
  if (!symbol) {
    const codes = work.match(/\b[A-Za-z]{2,5}\b/g) || [];
    for (const c of codes) {
      const up = c.toUpperCase();
      if (STOCK_STOP_WORDS.has(up)) continue;
      if (/^[A-Z]+$/.test(up)) { symbol = up; raw = c; break; }
    }
  }
  if (!symbol) return null;
  // 数字/中文数字 + 时间单位（如"5日""近五个交易日""3个月""two weeks"）→ 视作历史/区间查询
  const numTimePattern = /(\d+|[一二三四五六七八九十两半]+)\s*(个)?\s*(天|日|周|星期|月|季度|年|交易日|days?|weeks?|months?|years?|trading\s*days?)/i;
  const hasLoop = STOCK_LOOP_WORDS.some((w) => lower.includes(w.toLowerCase())) || numTimePattern.test(lower);
  // 必须含价格意图词或历史/分析词，才视作股票查询（避免把普通英文句里的缩写误判为股票）
  if (!isPriceIntent && !hasLoop) return null;
  // 含历史/时间区间/深度分析词 → 标记为 history，交由 Agent 循环理解并分解
  // （如"过去五天""历史价格""走势"）：循环会调 stock_price(range=...) 取时间序列
  return { symbol, raw, history: hasLoop };
}

// 硬路由执行：调真实工具拿数据 → 让模型基于真实数据做自然语言总结（无权编造）
async function handleStockPriceQuery(ws, session, history, llm, cfg, q, userMessage) {
  broadcast(ws, { type: 'tool_call', tool: 'stock_price', args: { symbol: q.symbol } });
  let res;
  try {
    res = await toolRegistry.execute({ name: 'stock_price', arguments: { symbol: q.symbol } });
  } catch (e) {
    res = { success: false, error: e.message };
  }
  const data = res.success ? res.result : null;
  const errMsg = !res.success ? (res.error || '执行失败') : (data && data.error ? data.error : null);

  if (errMsg) {
    const out = `抱歉，暂时无法获取 ${q.symbol} 的实时行情数据（${errMsg}）。请稍后重试或检查网络连通性。`;
    broadcast(ws, { type: 'tool_result', success: false, output: out });
    history.push({ role: 'assistant', content: out });
    broadcast(ws, { type: 'done', content: out, subtasks: [{ id: 'stock_price', title: `查询 ${q.symbol} 行情`, status: 'done' }] });
    return;
  }

  // 透明展示真实原始结果
  broadcast(ws, { type: 'tool_result', success: true, output: JSON.stringify(data, null, 2) });

  // 用 LLM 基于【真实数据】做自然语言总结；prompt 强制"原样使用数字、严禁编造、说明数据来源工具"
  const summaryPrompt = [
    '你是行情播报助手。下面是从 Yahoo Finance 获取到的【真实】行情数据（JSON）。',
    '请用简体中文写成一段自然语言总结，必须包含：标的名称与代码、最新价、涨跌额与涨跌幅、',
    '今开/最高/最低（若有）、成交量、货币、交易所、更新时间。',
    '所有数字必须原样使用，严禁修改、严禁编造或补充任何数据里没有的数字。不要把原始 JSON 再贴一遍。',
    '必须在总结中明确说明：以上数据是通过 stock_price 工具（数据源：Yahoo Finance）实时获取的。',
    '',
    JSON.stringify(data, null, 2),
  ].join('\n');

  let summary = null;
  try {
    summary = await llm.chat([{ role: 'user', content: summaryPrompt }], { temperature: 0.3 });
  } catch (e) {
    summary = null;
  }

  let answer;
  if (summary && summary.trim()) {
    answer = summary.trim();
  } else {
    const sign = (data.change >= 0 ? '+' : '');
    answer = `${data.name || data.symbol}（${data.symbol}）最新价 ${data.price} ${data.currency}，` +
      `涨跌 ${sign}${data.change}（${sign}${data.change_percent}%）。` +
      (data.open != null ? `今开 ${data.open}，` : '') +
      (data.high != null ? `最高 ${data.high}，` : '') +
      (data.low != null ? `最低 ${data.low}。` : '') +
      `成交量 ${data.volume || 'N/A'}，交易所 ${data.exchange || 'N/A'}。更新时间 ${data.market_time || 'N/A'}。数据来源：${data.source}。`;
  }

  history.push({ role: 'assistant', content: answer });
  broadcast(ws, { type: 'done', content: answer, subtasks: [{ id: 'stock_price', title: `查询 ${q.symbol} 行情`, status: 'done' }] });
}

function buildLLMMessages(system, history) {
  return [
    { role: 'system', content: system },
    ...history.slice(-10),
  ];
}

// ============================================================
// Unified Agent Loop — 移植自 qaimodelbuilder 的共享回合内核驱动
// 用 SingleAgentTurnKernel 统一驱动 main agent（替代原来的分裂式
// 简单流 / TaskOrchestrator 分解流），原生支持工具调用、子 Agent 派发、
// skill 加载、上下文压缩。保持 WebSocket 事件协议兼容前端。
// ============================================================

async function runAgentLoop({ ws, session, llm, system, history, config, useTools }) {
  const llmConfig = {
    provider: config.provider || 'openrouter',
    apiKey: config.apiKey,
    model: config.model,
    baseURL: config.provider === 'openrouter' ? (config.baseURL || 'https://openrouter.ai/api/v1') : (config.baseURL || undefined),
  };
  subAgentManager.llmConfig = llmConfig;

  // 1) 播种 wire（system + 历史），内核会原地增长它
  const wire = [{ role: 'system', content: system }, ...history.slice(-10)];

  // 2) toolExecutor / buildToolMetas 不依赖是否带工具，复用
  const toolExecutor = (roundNo, toolMetas) => makeMainToolExecutor(roundNo, toolMetas, { ws, session, llmConfig });
  const buildToolMetas = (rawToolCalls, roundNo) =>
    rawToolCalls.map((tc, i) => {
      const name = tc.name || (tc.function && tc.function.name) || 'unknown';
      const args = tc.arguments || (tc.function && tc.function.arguments) || {};
      const callId = tc.id || `call_${roundNo}_${i}`;
      return [name, typeof args === 'string' ? safeParseArgs(args) : args, callId];
    });

  const executedTools = [];
  let finalText = '';

  // 单趟内核运行：withTools 决定是否带工具 schema；buffer=true 时不把事件推给前端（仅缓存），
  // 用于 simple 路径“先探后发”，避免把模型退化出的 invocation 垃圾文本刷给前端。
  const runPass = async (withTools, buffer) => {
    const toolSchemas = withTools ? getAllOpenAIToolSchemas() : [];
    const supportsTools = llm.supportsFunctionCalling() && toolSchemas.length > 0;
    const openRoundStream = makeOpenRoundStream(llm, supportsTools, toolSchemas);
    const buffered = [];
    const toolResultsText = [];
    try {
      for await (const kev of agentKernel.run({
        wireMessages: wire,
        openRoundStream,
        toolExecutor,
        buildToolMetas,
        maxRounds: config.maxRounds || 16,
        abortCheck: () => session.stopRequested === true,
        modelHint: llmConfig.model,
      })) {
        if (kev.kind === 'tool_result') toolResultsText.push(kev.resultText);
        const mapped = adaptKernelEventToWs(kev, { ws: buffer ? null : ws, executedTools });
        if (!mapped) continue;
        if (mapped.__record) { executedTools.push(mapped.__record); continue; }
        if (buffer) buffered.push(mapped);
        else broadcast(ws, mapped);
      }
    } catch (err) {
      broadcast(ws, { type: 'error', message: err.message });
      return { content: '', error: err.message };
    }
    const text = identity.filterOutput(wireToFinalText(wire));
    const tr = toolResultsText.filter(Boolean).join('\n');
    // 若模型未写总结只调了工具（如退化成 JSON 文本调用），用工具真实结果兜底，避免空白答案
    return { content: text && text.trim() ? text : tr, buffered };
  };

  // 3) 先按分类跑一趟；simple 路径先缓冲（不刷给前端）
  const firstPass = await runPass(useTools, /* buffer */ !useTools);
  if (firstPass.error) return { content: '' };

  // 4) 兜底安全网：simple 路径下模型若退化成输出“未执行的工具调用”JSON，升级为 complex 重跑
  if (!useTools && looksLikeInvocation(firstPass.content)) {
    broadcast(ws, { type: 'thinking', message: '🔧 检测到需要调用工具，切换为 agentic 模式重新执行...' });
    const secondPass = await runPass(true, /* buffer */ false);
    if (secondPass.error) return { content: '' };
    finalText = secondPass.content;
  } else {
    finalText = firstPass.content;
    // 把缓冲的 simple 路径输出补发给前端
    for (const f of firstPass.buffered) broadcast(ws, f);
  }

  // 5) 空响应兜底：模型在带工具场景下可能返回空响应（免费档限流 / 工具调用支持不稳定）。
  // 避免前端收到空白答案，给出明确提示而非静默空内容。
  if (!finalText || finalText.trim() === '') {
    if (executedTools.length > 0) {
      finalText = '[模型在工具执行后未返回总结文本（可能是当前模型对工具调用支持不稳定或触发限流）。工具已执行：' +
        executedTools.map((t) => t.title).join('、') + '。请重试或更换模型。]';
    } else {
      finalText = '[模型未返回有效内容（可能是当前模型触发限流或临时不可用）。请稍后重试或更换模型。]';
    }
  }

  // 真实性闸门：校验"调用了某工具/数据来源"等声明是否真实发生，剥离虚构声明（如声称调用 deep-search / 数据来源 Google/Bing）
  finalText = enforceToolClaimHonesty(finalText, session.__realToolNames);

  // 透明性安全网：本轮未调用任何工具时，若答案未声明，则补一句诚实说明
  // （LLM 不一定每次都自觉声明，这里后端兜底，与系统提示的"透明性铁律"双保险）
  // 用 ws.__toolCallsThisTurn（broadcast 层统计的本轮 tool_call/tool_result 次数）判断，
  // 比 executedTools 更可靠——skill 执行（tool:'skill'）等路径不会写入 executedTools。
  const NO_TOOL_HINTS = ['我根据经验认为', '未经实时工具核实', '未经工具核实', '基于我的知识', '基于已有知识', '以下为我的', '未经核实', '调用了'];
  if ((ws.__toolCallsThisTurn || 0) === 0 && !NO_TOOL_HINTS.some((h) => finalText.includes(h))) {
    finalText += '\n\n（我根据经验认为：以上内容基于我的已有知识作答，未经实时工具核实。）';
  }

  // 写回历史
  history.push({ role: 'assistant', content: finalText });

  broadcast(ws, {
    type: 'done',
    content: finalText,
    subtasks: executedTools.map((t) => ({ id: t.id, title: t.title, status: t.status })),
  });

  return { content: finalText };
}

// ============================================================
// Planned Loop —— 规划分解 → 逐项执行(打勾) → 自检 → 不满足则再分解循环 → 报告遗留
// 用户要求：面对复杂问题不要一上来就调工具，而是：
//   ① 先输出任务分解（plan 卡片，逐项 pending）
//   ② 逐个执行子任务（agentKernel 带工具），完成一个划掉一个（subtask_done 打勾）
//   ③ 汇总后自检：结果是否真正回答了原问题
//   ④ 若未满足 → 针对缺口再分解、再执行（循环，最多 N 轮）
//   ⑤ 最终总结；仍无法解决的部分显式列为「遗留问题」
// ============================================================

// 宽松解析 LLM 返回的 JSON（容忍 ```json 围栏、前后杂字）
function parseJsonLoose(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 直接尝试
  try { return JSON.parse(s); } catch { /* fallthrough */ }
  // 提取第一个 { ... } 或 [ ... ]
  const objMatch = s.match(/[[{][\s\S]*[\]}]/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { /* ignore */ }
  }
  return null;
}

// ① 任务分解：把问题拆成 1-5 个可独立执行的子任务
async function planDecompose(llm, question, priorContext, iteration, researchHint) {
  const sys = [
    '你是任务规划助手。把用户问题拆解为完成回答所必需的、可独立执行的子任务清单。',
    '每个子任务是一个简短、具体、可执行的步骤（例如「获取 TLT 近5个交易日的每日收盘价」）。',
    '原子问题可以只返回 1 个子任务；复杂/研究问题最多 5 个。',
    '只返回 JSON 数组，格式：[{"title":"..."}]。不要输出任何解释文字。',
    '子任务标题使用与用户问题相同的语言。',
  ];
  if (researchHint) {
    sys.push('⚠️ 该问题需要【最新/外部真实资料】，禁止让模型凭记忆直接作答。请拆成 2–4 个【检索角度不同而互补】的子任务（每个子任务对应一次独立的 web_search 检索，使用不同关键词/维度），例如分别检索「事件概况」「最新进展/赛果」「背景/对比」。不要把「直接回答用户」当作子任务。');
  }
  const sysText = sys.join('\n');
  let user = `原始问题：${question}`;
  if (priorContext && iteration > 1) {
    user += `\n\n已有结果（可能不完整）：\n${priorContext.slice(-2500)}\n\n请只列出为补全答案【还缺少】的子任务；若已足够可返回空数组 []。`;
  }
  const raw = await llm.chat([{ role: 'system', content: sysText }, { role: 'user', content: user }], { temperature: 0.2, maxTokens: 600 });
  const parsed = parseJsonLoose(raw);
  let arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.subtasks) ? parsed.subtasks : null);
  if (!arr) {
    // 兜底：无法解析则把整个问题当作单一子任务
    return iteration === 1 ? [{ title: question }] : [];
  }
  return arr
    .map((x) => (typeof x === 'string' ? { title: x } : { title: x && (x.title || x.task || x.name) }))
    .filter((x) => x.title && String(x.title).trim())
    .slice(0, 5);
}

// ③ 自检：结果是否真正回答了原问题
async function planSelfCheck(llm, question, context) {
  const sys = [
    '你是严格的审查员。给你原始问题与已收集到的结果，判断结果是否【完整回答】了问题。',
    '只返回 JSON：{"satisfied": true 或 false, "missing": ["缺失点1", "..."], "reason": "简短理由"}。',
    '若未完整回答，请在 missing 中列出具体、可执行的缺失项；若已完整，missing 为空数组。',
    '特别注意：若原始问题需要实时或外部信息（如最新新闻、比赛结果、具体数据、特定事件），但已收集结果中【没有】任何 web_search 等工具的真实检索内容（仅为模型自身陈述），则 satisfied 必须为 false，并在 missing 中明确写"通过 web_search 检索真实资料"。',
  ].join('\n');
  const user = `原始问题：${question}\n\n已收集结果：\n${(context || '').slice(-4000)}`;
  const raw = await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0, maxTokens: 400 });
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed.satisfied !== 'boolean') return { satisfied: true, missing: [], reason: '' };
  return { satisfied: parsed.satisfied, missing: Array.isArray(parsed.missing) ? parsed.missing : [], reason: parsed.reason || '' };
}

// ⑤ 汇总：基于真实结果写最终答案；仍未解决的列为「遗留问题」
async function planSynthesize(llm, question, context, remaining) {
  const sys = [
    '你是总结助手。请【仅依据】已收集的结果，用简体中文写出对原始问题的最终回答。',
    '严禁编造数据；所有数字/事实必须来自已收集结果。',
    '若有未能解决的部分，请在结尾单列一节「⚠️ 遗留问题」，逐条说明还有哪些没能解决、原因、以及建议的下一步。',
    '若已完整解决则无需该节。回答要条理清晰、直接。',
  ].join('\n');
  let user = `原始问题：${question}\n\n已收集结果：\n${(context || '').slice(-6000)}`;
  if (remaining && remaining.length) {
    user += `\n\n经自检仍未解决的缺口：\n- ${remaining.join('\n- ')}`;
  }
  return await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.4 });
}

// 执行单个子任务：agentKernel 带工具跑一趟，转发 tool_call/tool_result（不发 chunk/done），返回文本
// 退化兜底：若子任务明显需要联网（搜索/新闻/最新/比赛/价格…）但模型没有真正调用任何工具（退化成凭记忆编造），
// 则强制重试一次（在提示中要求必须调用 web_search 获取真实数据），避免把编造内容当真实结果汇总。
const NEED_NET_RE = /搜索|搜|查|新闻|最新|比赛|赛果|比分|价格|行情|天气|汇率|结果|result|news|latest|search|price|score|today|weather|live|fetch|查询/i;
async function runSubtaskKernel({ ws, session, llm, wireMessages, config }) {
  const llmConfig = {
    provider: config.provider || 'openrouter',
    apiKey: config.apiKey,
    model: config.model,
    baseURL: config.provider === 'openrouter' ? (config.baseURL || 'https://openrouter.ai/api/v1') : (config.baseURL || undefined),
  };
  subAgentManager.llmConfig = llmConfig;
  const toolSchemas = getAllOpenAIToolSchemas();
  const supportsTools = llm.supportsFunctionCalling() && toolSchemas.length > 0;
  const openRoundStream = makeOpenRoundStream(llm, supportsTools, toolSchemas);
  const buildToolMetas = (rawToolCalls, roundNo) =>
    rawToolCalls.map((tc, i) => {
      const name = tc.name || (tc.function && tc.function.name) || 'unknown';
      const args = tc.arguments || (tc.function && tc.function.arguments) || {};
      const callId = tc.id || `call_${roundNo}_${i}`;
      return [name, typeof args === 'string' ? safeParseArgs(args) : args, callId];
    });

  // 单次执行：返回 { content, executedTools, error }
  async function runOnce(wire) {
    const toolExecutor = (roundNo, toolMetas) => makeMainToolExecutor(roundNo, toolMetas, { ws, session, llmConfig });
    const executedTools = [];
    const toolResultsText = [];
    try {
      for await (const kev of agentKernel.run({
        wireMessages: wire,
        openRoundStream,
        toolExecutor,
        buildToolMetas,
        maxRounds: config.maxRounds || 12,
        abortCheck: () => session.stopRequested === true,
        modelHint: llmConfig.model,
      })) {
        // 只转发工具事件；子任务的思考流(chunk)不推给前端，避免污染最终答案气泡
        if (kev.kind === 'tool_calls_issued') {
          for (const [name, , callId] of kev.toolMetas) {
            if (name === 'agent') continue;
            const args = kev.toolMetas.find((m) => m[2] === callId)?.[1] || {};
            broadcast(ws, { type: 'tool_call', tool: name, args });
            executedTools.push({ id: callId, title: `${name}`, status: 'running' });
          }
        } else if (kev.kind === 'tool_result') {
          broadcast(ws, { type: 'tool_result', success: kev.ok, output: kev.resultText });
          toolResultsText.push(kev.resultText || '');
        } else if (kev.kind === 'error') {
          return { content: '', executedTools, error: kev.message };
        }
      }
    } catch (err) {
      return { content: '', executedTools, error: err.message };
    }
    const text = identity.filterOutput((wireToFinalText(wire) + '\n' + toolResultsText.filter(Boolean).join('\n')).trim());
    return { content: text, executedTools };
  }

  let res = await runOnce([...wireMessages]);
  console.log(`[SubtaskKernel] 首次执行: 工具=[${res.executedTools.map((t) => t.title).join(', ') || '无'}]${res.error ? ' 错误=' + res.error : ''}`);

  // 强制联网重试：子任务需联网但模型退化没调任何工具 → 再跑一次并强制调用 web_search
  const wireText = JSON.stringify(wireMessages);
  if (!res.error && res.executedTools.length === 0 && NEED_NET_RE.test(wireText)) {
    const forcedWire = [...wireMessages];
    const last = forcedWire[forcedWire.length - 1];
    if (last && last.role === 'user') {
      last.content += '\n\n【强制要求】本子任务必须调用 web_search 工具获取真实数据，严禁凭记忆编造任何事实、比分、日期或数据来源。若 web_search 无结果，请明确说明"未检索到相关信息"。';
    }
    res = await runOnce(forcedWire);
    console.log(`[SubtaskKernel] 强制联网重试后: 工具=[${res.executedTools.map((t) => t.title).join(', ') || '无'}]`);
  }

  return res;
}

// 判断是否需要外部真实资料的「非常见/研究型」问题（需多次联网检索，不可凭记忆作答）
const RESEARCH_RE = /最新|新闻|消息|比赛|赛果|比分|今日|今天|昨天|本周|本月|今年|实时|当前|现在|天气|汇率|政策|发布|上市|夺冠|冠军|排名|榜单|趋势|分析|如何|怎么|为什么|对比|比较|研究|报告|数据|事件|谁|哪个|哪支|几比|20\d\d|世界杯|奥运|选举|财报|gdp|news|latest|today|result|score|weather|report|analysis|compare|why|how|who|when/i;
function isResearchQuestion(q) {
  return RESEARCH_RE.test(q || '');
}

// 主编排：规划 → 执行(打勾) → 自检 → 循环 → 汇总+遗留
async function runPlannedLoop({ ws, session, llm, system, history, config }) {
  const question = history[history.length - 1]?.content || '';
  const research = isResearchQuestion(question);
  console.log(`[PlannedLoop] 原始问题: ${question}`);
  console.log(`[PlannedLoop] 研究型问题(需多次联网检索): ${research}`);
  const MAX_ITER = config.maxPlanIterations || 3;
  const allExecuted = [];
  let context = '';
  let remaining = [];

  for (let iter = 1; iter <= MAX_ITER; iter++) {
    if (session.stopRequested) break;
    broadcast(ws, { type: 'thinking', message: iter === 1 ? '🧠 正在分解任务...' : `🔁 第 ${iter} 轮：针对缺口再分解...` });

    let subtasks = [];
    try {
      subtasks = await planDecompose(llm, question, context, iter, research);
    } catch (e) {
      subtasks = iter === 1 ? [{ title: question }] : [];
    }
    if (!subtasks || subtasks.length === 0) break;
    console.log(`[PlannedLoop] 第${iter}轮分解(${subtasks.length}项): ${subtasks.map((s) => s.title).join(' | ')}`);

    const planItems = subtasks.map((s, i) => ({ id: `st_${iter}_${i}`, title: String(s.title).trim() }));
    broadcast(ws, {
      type: 'plan',
      plan: {
        title: iter === 1 ? '任务分解' : `补充任务（第 ${iter} 轮）`,
        subtaskCount: planItems.length,
        subtasks: planItems.map((p) => ({ id: p.id, title: p.title, type: 'general' })),
      },
    });

    for (const item of planItems) {
      if (session.stopRequested) { broadcast(ws, { type: 'subtask_error', taskId: item.id, title: item.title, message: '已停止' }); break; }
      broadcast(ws, { type: 'subtask_start', taskId: item.id, title: item.title });
      console.log(`[PlannedLoop] 子任务[${item.id}] 开始: ${item.title}`);
      const wire = [
        { role: 'system', content: system },
        ...history.slice(-6),
        {
          role: 'user',
          content: `请完成以下子任务并直接给出结果（可调用工具获取真实数据，禁止编造）：\n【子任务】${item.title}\n\n这是为回答原始问题「${question}」而分解出的一步。` +
            (research
              ? '\n\n本子任务需要外部真实资料：请主动调用 web_search 工具检索；若一条结果不足以回答，请用【不同关键词】再检索 1–2 次，综合多来源后再作答，严禁凭记忆编造任何事实、日期、比分或数据来源。'
              : '') +
            (context ? `\n\n已有上下文（供参考，勿重复）：\n${context.slice(-2000)}` : ''),
        },
      ];
      const res = await runSubtaskKernel({ ws, session, llm, wireMessages: wire, config });
      const out = (res.content || '').trim() || '(该子任务未产生有效输出)';
      allExecuted.push({ id: item.id, title: item.title, status: res.error ? 'error' : 'done' });
      context += `\n### ${item.title}\n${out}\n`;
      const toolsUsed = res.executedTools.map((t) => t.title).join(', ') || '(无)';
      console.log(`[PlannedLoop] 子任务[${item.id}] 完成: 工具=[${toolsUsed}] 输出长度=${out.length}${res.error ? ' 错误=' + res.error : ''}`);
      if (res.error) broadcast(ws, { type: 'subtask_error', taskId: item.id, title: item.title, message: res.error });
      else broadcast(ws, { type: 'subtask_done', taskId: item.id, title: item.title });
    }

    // 自检：结果是否回答了原问题
    if (session.stopRequested) break;
    broadcast(ws, { type: 'thinking', message: '🔎 自检：结果是否回答了问题...' });
    let check = { satisfied: true, missing: [] };
    try {
      check = await planSelfCheck(llm, question, context);
    } catch (e) { check = { satisfied: true, missing: [] }; }
    console.log(`[PlannedLoop] 自检: satisfied=${check.satisfied} missing=${JSON.stringify(check.missing)} reason=${check.reason || ''}`);
    if (check.satisfied) { remaining = []; break; }
    remaining = check.missing || [];
    if (iter === MAX_ITER) break; // 达到最大轮次仍未满足 → 下面汇总时报告遗留
  }

  // 汇总最终答案（含遗留问题）
  broadcast(ws, { type: 'thinking', message: '✨ 汇总最终答案...' });
  let finalText = '';
  try {
    finalText = await planSynthesize(llm, question, context, remaining);
  } catch (e) { finalText = ''; }
  finalText = identity.filterOutput((finalText || '').trim());
  finalText = enforceToolClaimHonesty(finalText, session.__realToolNames);
  console.log(`[PlannedLoop] 汇总完成: 答案长度=${finalText.length} 本轮真实工具=${[...session.__realToolNames].join(',') || '(无)'}`);
  if (!finalText) {
    finalText = context.trim() || '抱歉，本轮未能获取有效结果，请重试或更换模型。';
    if (remaining.length) finalText += `\n\n⚠️ 遗留问题：\n- ${remaining.join('\n- ')}`;
  }

  // 透明性安全网：全程未调用任何工具时补一句诚实说明
  const NO_TOOL_HINTS = ['未经实时工具核实', '未经工具核实', '基于我的知识', '基于已有知识', '未经核实'];
  if ((ws.__toolCallsThisTurn || 0) === 0 && !NO_TOOL_HINTS.some((h) => finalText.includes(h))) {
    finalText += '\n\n（我根据经验认为：以上内容基于我的已有知识作答，未经实时工具核实。）';
  }

  history.push({ role: 'assistant', content: finalText });
  broadcast(ws, { type: 'done', content: finalText, subtasks: allExecuted });
  return { content: finalText };
}

// ── 主循环工具执行器（并行） ──
async function* makeMainToolExecutor(roundNo, toolMetas, { ws, session, llmConfig }) {
  const tasks = toolMetas.map(async ([name, args, callId]) => {
    const start = Date.now();
    try {
      if (name === 'agent') {
        return await runMainAgentTool(args, { ws, session, llmConfig, callId });
      }
      if (name === 'skill') {
        return await runSkillTool(args, callId, { ws, session });
      }
      const result = await executeTool({ name, arguments: args });
      if (session && session.__realToolNames) session.__realToolNames.add(name);
      const ok = result.success !== false;
      const raw = result.output != null ? String(result.output) : (result.error || '');
      return { partial: false, callId, toolName: name, resultText: truncateToolResult(raw), ok, durationMs: Date.now() - start };
    } catch (err) {
      return { partial: false, callId, toolName: name, resultText: truncateToolResult(`Error: ${err.message}`), ok: false, durationMs: Date.now() - start };
    }
  });
  const results = await Promise.all(tasks);
  for (const r of results) yield r;
}

// 主循环中 agent 工具：派生子 Agent（深度=1），实时转发进度为 tool 卡片
async function runMainAgentTool(args, { ws, session, llmConfig, callId }) {
  const start = Date.now();
  const description = args.description || args.prompt || '';
  // 立即给出"派生子 Agent"卡片
  broadcast(ws, { type: 'tool_call', tool: 'agent', args: { description: description.slice(0, 200), name: args.name || null } });
  let final = '[sub-agent produced no output]';
  let ok = true;
  try {
    for await (const ev of subAgentManager.iterEvents({ arguments: args }, {
      modelHint: llmConfig.model,
      allowSpawn: args.allow_spawn === true,
      spawnDepth: 1,
      parentTabId: session.id || 'main',
      parentAbortCheck: () => session.stopRequested === true,
    })) {
      if (ev.type === 'subagent_done') final = String(ev.result || '');
      else if (ev.type === 'subagent_error') { final = `[sub-agent error: ${ev.message}]`; ok = false; }
      // subagent_start / output / tool / tool_result 不单独转发（前端无对应处理，避免噪音）
    }
  } catch (e) {
    final = `[sub-agent error: ${e.message}]`;
    ok = false;
  }
  const resultText = truncateToolResult(identity.filterOutput(final));
  broadcast(ws, { type: 'tool_result', success: ok, output: resultText });
  return { partial: false, callId, toolName: 'agent', resultText, ok, durationMs: Date.now() - start };
}

// 主循环中 skill 工具：优先真正执行 SKILL.md 中的命令（确保完整执行而非只给计划）；
// 若无直接可执行命令，则回退为加载指令全文供模型遵循（agentic 路径会进一步调用工具执行）。
async function runSkillTool(args, callId, { ws, session }) {
  const start = Date.now();
  const name = args.name;
  const skill = skillLoader.get(name);
  if (!skill || !skill.enabled) {
    return { partial: false, callId, toolName: 'skill', resultText: `Skill '${name}' not found or disabled.`, ok: false, durationMs: Date.now() - start };
  }

  // 若技能含可执行命令，且调用方请求执行（带 input 或显式 execute=true）→ 真实运行
  const skillDir = path.dirname(skill.path);
  const execCmd = extractExecutionCommand(skill.content, skillDir);
  const wantExec = args.execute === true || (args.input !== undefined && args.input !== '');
  if (execCmd && wantExec) {
    let cmdInput = typeof args.input === 'string'
      ? args.input
      : (args.question || args.query || (args.input && typeof args.input === 'object' ? JSON.stringify(args.input) : ''));
    const safeInput = String(cmdInput == null ? '' : cmdInput).replace(/"/g, '\\"');
    const fullCmd = execCmd.replace(/\$1|\$INPUT|\{\{input\}\}/g, `"${safeInput}"`);
    try {
      const { stdout, stderr } = await execAsync(fullCmd, {
        cwd: skillDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120000,
      });
      if (stderr) console.warn(`[skill tool] ${name} stderr:`, stderr);
      const output = stdout || 'Skill 执行完成（无输出）';
      let resultText = `## Skill 执行结果: ${name}\n\n${output}`;
      try {
        const llm = buildLlmFromSession(session);
        const summary = await summarizeSkillResult(llm, args.question || args.query || name, output);
        resultText = summary;
      } catch (sumErr) {
        console.warn('[skill tool] 自然语言总结生成失败，回退原始结果:', sumErr.message);
      }
      return {
        partial: false,
        callId,
        toolName: 'skill',
        resultText,
        ok: true,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return {
        partial: false,
        callId,
        toolName: 'skill',
        resultText: `Skill 执行失败: ${e.message}`,
        ok: false,
        durationMs: Date.now() - start,
      };
    }
  }

  // 否则返回指令全文（原行为）
  const injected = skillLoader.getSkillContentForInjection(name, { page: args.page || 0 });
  if (!injected) {
    return { partial: false, callId, toolName: 'skill', resultText: `Skill '${name}' not found or disabled.`, ok: false, durationMs: Date.now() - start };
  }
  const body = `--- SKILL: ${injected.name} ---\n${injected.content}` +
    (injected.hasMore ? `\n\n[This skill has more pages; call skill with page=${injected.page + 1} to continue]` : '');
  return { partial: false, callId, toolName: 'skill', resultText: body, ok: true, durationMs: Date.now() - start };
}

// ── 讨论启动（多 Agent 编排入口） ──
async function handleStartDiscussion(ws, session, msg) {
  const topic = (msg.topic || '').trim();
  if (!topic) {
    broadcast(ws, { type: 'error', message: 'Discussion requires a topic' });
    return;
  }

  // 解析 roster（优先内联 members，否则从 roster_template_id 取）
  let roster = null;
  if (Array.isArray(msg.roster) && msg.roster.length > 0) {
    roster = msg.roster.map((m) => ({
      display_name: m.display_name || m.name || 'Speaker',
      model_id: m.model_id || null,
      persona: m.persona || null,
      config: m.config || {},
    }));
  } else if (msg.roster_template_id) {
    try {
      const tpl = rosterTemplateStore.get(msg.roster_template_id);
      roster = tpl.members.map((m) => ({
        display_name: m.display_name,
        model_id: m.model_id,
        persona: m.persona,
        config: m.config || {},
      }));
    } catch (err) {
      broadcast(ws, { type: 'error', message: `roster template: ${err.message}` });
      return;
    }
  }

  if (!roster || roster.length === 0) {
    broadcast(ws, { type: 'error', message: 'Discussion requires a roster (members or roster_template_id)' });
    return;
  }

  // 解析 mode（优先内联 mode，否则从 mode_template_id 取）
  let mode = null;
  if (msg.mode && typeof msg.mode === 'object') {
    mode = {
      name: msg.mode.name || 'custom',
      framing: msg.mode.framing || '',
      tool_policy: msg.mode.tool_policy || { default: 'allow', tools: {} },
      flow_policy: msg.mode.flow_policy || { speaker_strategy: 'round_robin', max_rounds: 8, judge_enabled: true },
      hard_constraints: msg.mode.hard_constraints || { max_chars_per_turn: null, max_seconds_per_turn: null },
    };
  } else if (msg.mode_template_id) {
    try {
      const tpl = modeTemplateStore.get(msg.mode_template_id);
      mode = {
        name: tpl.name,
        framing: tpl.framing,
        tool_policy: tpl.tool_policy,
        flow_policy: tpl.flow_policy,
        hard_constraints: tpl.hard_constraints,
      };
    } catch (err) {
      broadcast(ws, { type: 'error', message: `mode template: ${err.message}` });
      return;
    }
  }

  if (!mode) {
    broadcast(ws, { type: 'error', message: 'Discussion requires a mode (mode or mode_template_id)' });
    return;
  }

  // 允许前端覆盖 max_rounds
  if (msg.max_rounds) {
    const mr = parseInt(msg.max_rounds, 10);
    if (!Number.isNaN(mr) && mr > 0) mode.flow_policy = { ...mode.flow_policy, max_rounds: mr };
  }

  const cfg = { ...loadConfig(), ...session.config };
  if (cfg.provider !== 'local' && !cfg.apiKey) {
    broadcast(ws, { type: 'error', message: 'No API key configured. Please set your API key in Settings.' });
    return;
  }

  const llmConfig = {
    provider: cfg.provider || 'qgenie',
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL: cfg.provider === 'openrouter'
      ? (cfg.baseURL || 'https://openrouter.ai/api/v1')
      : cfg.baseURL || undefined,
  };
  const llm = new LLMAdapter(llmConfig);

  try {
    await runDiscussion({
      ws,
      session,
      llm,
      topic,
      roster,
      mode,
      config: cfg,
      broadcast: (data) => broadcast(ws, data),
    });
  } catch (err) {
    broadcast(ws, { type: 'error', message: err.message });
  }
}

// ── KernelEvent → WebSocket 帧 ──
function adaptKernelEventToWs(kev, { ws, executedTools }) {
  switch (kev.kind) {
    case 'round_started':
      return null;
    case 'chunk':
      return { type: 'chat_chunk', content: kev.text };
    case 'tool_calls_issued':
      // 为每个工具发一张 tool_call 卡片（agent 已由 runMainAgentTool 发过，跳过避免重复）
      for (const [name, , callId] of kev.toolMetas) {
        if (name === 'agent') continue;
        const args = kev.toolMetas.find((m) => m[2] === callId)?.[1] || {};
        if (ws) broadcast(ws, { type: 'tool_call', tool: name, args });
        executedTools.push({ id: callId, title: `${name}(${JSON.stringify(args).slice(0, 80)})`, status: 'running' });
      }
      return null;
    case 'tool_result':
      return { type: 'tool_result', success: kev.ok, output: kev.resultText };
    case 'finished':
      return null; // 由 done 收尾
    case 'max_rounds_reached':
      if (ws) broadcast(ws, { type: 'thinking', message: `⚠️ 达到最大回合(${kev.maxRounds})，停止以避免无限循环` });
      return null;
    case 'aborted':
      return null;
    case 'error':
      return { type: 'error', message: kev.message };
    default:
      return null;
  }
}

function safeParseArgs(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
function wireToFinalText(wire) {
  for (let i = wire.length - 1; i >= 0; i--) {
    const m = wire[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content && m.content !== '[tool_calls]') {
      return m.content;
    }
  }
  return '';
}

// 真实性闸门：校验最终答案里"调用了某工具 / 数据来源"等声明是否真实发生。
// 若模型声称调用了某工具或某数据来源，但本轮并未真实执行该工具，则剥离虚假声明并加诚实提示，
// 避免把"我调用了 deep-search（数据来源：Google/Bing）"这类编造当作事实呈现给用户。
function enforceToolClaimHonesty(finalText, realToolNames) {
  if (!finalText || typeof finalText !== 'string') return finalText || '';
  const real = realToolNames instanceof Set ? realToolNames : new Set(Array.isArray(realToolNames) ? realToolNames : []);
  let text = finalText;

  // 1) 检测"我调用了 X 工具（数据来源：Y）"等整句声明；仅当声明的工具 X 不在真实集合里才剔除
  const claimRe = /我(?:调用|使用|运行|执行)了?\s*([A-Za-z0-9_\-]+)\s*工具?(?:\s*[（(]?\s*数据来源[：:]\s*[^）)\n]+[）)])?/g;
  text = text.replace(claimRe, (m, tool) => {
    const t = String(tool);
    if (real.has(t) || real.has(t.toLowerCase())) return m; // 真实调用过 → 保留
    if (['工具', '搜索', 'web', 'search', 'tool'].includes(t.toLowerCase())) return m; // 泛指词 → 保留
    return ''; // 虚构工具 → 删除该声明
  });

  // 2) 删除独立的虚假来源标注（本系统 web_search 数据源是 DuckDuckGo，不是下列来源）
  text = text.replace(/数据来源[：:]\s*(Google|Bing|谷歌|百度|Baidu|维基|Wikipedia|百度百科)\b[^。\n]*/gi, '');

  // 3) 本轮无任何真实工具调用时，删除"根据检索/搜索/查询结果"等暗示已真实检索的措辞
  if (real.size === 0) {
    text = text.replace(/根据(?:\s*我)?\s*(?:检索|搜索|查询|抓取|联网)[^，。\n]*?结果/g, '');
  }

  // 4) deep-search 非工具，统一改述，避免残留"调用了 deep-search 工具"的误导
  text = text.replace(/调用了\s*deep-?search\s*(?:工具)?/gi, '进行了深度检索尝试');
  text = text.replace(/\bdeep-?search\b/gi, '深度检索');

  // 5) 若原始文本声称调用了工具/来源、但本轮真实无任何工具调用 → 开头加诚实提示（内容由模型凭记忆生成，不可信）
  const claimed = /我(?:调用|使用|运行|执行)了?\s*[A-Za-z0-9_\-]+\s*工具|数据来源[：:]/i.test(finalText);
  if (claimed && real.size === 0) {
    text = '⚠️ 提示：以下内容由模型基于已有知识生成，未经实时工具核实；其中提及的"工具调用/数据来源"并非真实工具返回，请谨慎参考。\n\n' + text;
  }

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// 检测模型是否在「无工具可用」的简单路径下退化成输出了“未执行的工具调用”JSON。
// 例如 { "tool": "web_search", "arguments": { "query": "..." } }。
// 命中则说明本应走带工具的 complex 路径，需要升级重跑。
function looksLikeInvocation(text) {
  if (!text || typeof text !== 'string') return false;
  return (
    /\{\s*"invocation"/i.test(text) ||
    /\{\s*"tool"\s*:/i.test(text) ||
    /\{\s*"command"\s*:/i.test(text) ||
    /\{\s*"name"\s*:\s*"(web_fetch|web_search|shell_execute|python_execute|http_request|file_read|file_write|file_edit|file_list|file_glob|file_grep|agent|skill)"/i.test(text)
  );
}

// 从模型吐出的文本中解析「工具调用 JSON」。
// 支持格式：{"tool":"x","arguments":{...}} / {"name":"x"} / {"invocation":"x"} / {"function":{"name":"x"}}，
// 容许 ```json 围栏与前后杂字。仅当 JSON 占文本主体且工具名为已知工具时才返回，
// 避免把“举例说明”类文本误判为工具调用。
function parseInvocation(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  if (m[0].length < s.length * 0.6) return null; // JSON 须占文本主体
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const name = obj.tool || obj.name || obj.invocation || (obj.function && obj.function.name);
  if (!name || typeof name !== 'string') return null;
  const known = new Set([...toolRegistry.getAllTools().map((t) => t.name), 'agent', 'skill']);
  if (!known.has(name)) return null;
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  return { name, args };
}

// 把 LLM 原始流包装为 SingleAgentTurnKernel 所需的 Frame 流（text / tool_call / end / error）。
// 关键兜底：当模型未返回结构化 tool_call、却把工具调用以 JSON 文本吐出时
// （如 Nemotron 3 在 web_search 上偶发退化成 {"tool":"web_search","arguments":{...}}），
// 解析并合成 tool_call 帧，使内核真正执行该工具，而不是把 JSON 当成最终答案、工具静默不执行。
function makeOpenRoundStream(llm, supportsTools, toolSchemas) {
  return async function* (_roundNo, sendWire) {
    let frames = [];
    let textBuf = '';
    let sawToolCall = false;
    try {
      for await (const chunk of llm.stream(sendWire, supportsTools ? { tools: toolSchemas, temperature: 0.7 } : { temperature: 0.7 })) {
        if (chunk.type === 'text') { textBuf += chunk.content || ''; frames.push({ type: 'chunk', text: chunk.content }); }
        else if (chunk.type === 'tool_call') { sawToolCall = true; frames.push({ type: 'tool_call', id: chunk.id, name: chunk.name, arguments: chunk.arguments }); }
      }
      // 退化兜底：本应走工具却只吐了 JSON 文本
      if (!sawToolCall && looksLikeInvocation(textBuf)) {
        const inv = parseInvocation(textBuf);
        if (inv) frames = [{ type: 'tool_call', id: `call_${_roundNo}_0`, name: inv.name, arguments: inv.args }];
      }
      frames.push({ type: 'end', payload: {} });
    } catch (e) {
      frames.push({ type: 'error', message: e.message });
    }
    for (const f of frames) yield f;
  };
}

// ============================================================
// Chat handler
// ============================================================

async function handleChat(sessionId, session, msg) {
  const { ws, history, config } = session;
  ws.__toolCallsThisTurn = 0; // 重置本轮工具调用计数（透明性安全网用）
  session.__realToolNames = new Set(); // 重置本轮真实执行的工具名集合（真实性闸门用）
  const userMessage = msg.content;
  const conversationId = msg.conversationId || 'unknown';

  // Log conversation information
  console.log(`[Chat] 收到用户消息: ${userMessage}`);

  // ── Direct tool/command execution (skip LLM) ──────────
  // If user sends JSON with "command" or "tool" field, execute directly
  let directExec = null;
  try {
    const parsed = JSON.parse(userMessage.trim());
    if (parsed.command) {
      // Shell command direct execution
      directExec = { name: 'shell_execute', arguments: { command: parsed.command, workdir: parsed.workdir || '' } };
    } else if (parsed.tool && parsed.arguments) {
      // Tool call direct execution
      directExec = { name: parsed.tool, arguments: parsed.arguments };
    } else if (parsed.url && !parsed.tool) {
      // URL fetch direct execution
      directExec = { name: 'web_fetch', arguments: { url: parsed.url, prompt: parsed.prompt || '' } };
    }
  } catch {
    // Not JSON, proceed with normal LLM chat
  }

  if (directExec) {
    await handleDirectExecution(ws, session, directExec, userMessage);
    return;
  }

  // ── 技能直接执行（/skill-name input） ──
  // 用户在消息里以「/技能名」开头 → 解析 SKILL.md 中的执行命令并真跑（优先级高于 LLM 循环）
  if (userMessage.trim().startsWith('/')) {
    // stock-price 放行到下方硬路由（保证真实数据 + 自然语言总结），其余技能走原执行路径
    if (!/^\/stock[-_]?price\b/i.test(userMessage.trim())) {
      await handleSkillExecution(ws, session, userMessage);
      return;
    }
  }

  // Check API key (skip for local provider)
  const cfg = { ...loadConfig(), ...config };
  if (cfg.provider !== 'local' && !cfg.apiKey) {
    broadcast(ws, {
      type: 'error',
      message: 'No API key configured. Please set your API key in Settings.',
    });
    return;
  }

  // Build LLM adapter
  const llmConfig = {
    provider: cfg.provider || 'qgenie',
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL: cfg.provider === 'openrouter'
      ? (cfg.baseURL || 'https://openrouter.ai/api/v1')
      : cfg.baseURL || undefined,
  };
  const llm = new LLMAdapter(llmConfig);

  // Add user message to history
  history.push({ role: 'user', content: userMessage });

  const system = buildSystemPrompt(cfg.provider);

  // ── 股票价格硬路由：仅处理"当前快照"类查询（如"TLT 股价"）→ 直接调真实工具再总结，杜绝编造 ──
  // ── 历史/区间/分析类（如"过去五天""走势"）标记 history:true，不硬抢，交 Agent 循环理解并分解 ──
  const priceQuery = detectStockPriceQuery(userMessage);
  if (priceQuery && !priceQuery.history) {
    await handleStockPriceQuery(ws, session, history, llm, cfg, priceQuery, userMessage);
    return;
  }
  // 历史/区间类股票查询 → 强制走「带工具」循环，确保循环能调 stock_price(range=...) 取时间序列
  const forceStockComplex = !!(priceQuery && priceQuery.history);

  // ── 统一 Agent 循环（移植自 qaimodelbuilder 共享回合内核） ──
  // 简单问题 → 纯文本循环（无工具）；复杂问题 → 带工具的 agentic 循环
  // （原生工具调用 + 子 Agent 派发 + skill 加载 + 上下文压缩）
  broadcast(ws, { type: 'thinking', message: '🧠 分析问题难度...' });
  let isSimple = false;
  try {
    const questionType = await classifyQuestion(llm, userMessage);
    isSimple = (questionType === 'simple');
  } catch (err) {
    console.warn('[handleChat] classify failed, defaulting to complex:', err.message);
  }
  if (forceStockComplex) isSimple = false; // 股票历史/区间查询必须有工具可用
  // 非常见/研究型问题（需最新或外部真实资料）→ 强制走带工具规划环，禁止纯文本凭记忆作答
  if (isResearchQuestion(userMessage)) isSimple = false;
  console.log(`[Chat] 问题分类: ${isSimple ? 'simple(纯文本无工具)' : 'complex(带工具规划环)'}${forceStockComplex ? ' [股票历史/区间]' : ''}${isResearchQuestion(userMessage) ? ' [研究型强制complex]' : ''}`);

  try {
    if (isSimple) {
      broadcast(ws, { type: 'thinking', message: '思考中...' });
      await runAgentLoop({ ws, session, llm, system, history, config: cfg, useTools: false });
    } else {
      // 复杂问题：先分解任务 → 逐项执行(打勾) → 自检 → 不满足则再分解循环 → 汇总并报告遗留
      broadcast(ws, { type: 'thinking', message: '🧠 正在规划并执行任务...' });
      await runPlannedLoop({ ws, session, llm, system, history, config: cfg });
    }
  } catch (err) {
    broadcast(ws, { type: 'error', message: err.message });
  }
}

// ============================================================
// SPA fallback
// ============================================================

app.get('*', (req, res) => {
  const indexPath = path.join(ROOT_DIR, 'frontend', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built yet.');
  }
});

// ============================================================
// Graceful Shutdown
// ============================================================

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(`[Shutdown] Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  console.log(`\n[Shutdown] Received ${signal}, starting graceful shutdown...`);

  // Notify all clients
  const shutdownMsg = { type: 'server_shutdown', message: 'Server is restarting, please wait...' };
  for (const [sessionId, session] of sessions) {
    try {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(JSON.stringify(shutdownMsg));
      }
    } catch { /* ignore */ }
  }

  // Close WebSocket server (stop accepting new connections)
  wss.close(() => {
    console.log('[Shutdown] WebSocket server closed');
  });

  // Close all WebSocket connections
  let closedCount = 0;
  for (const [sessionId, session] of sessions) {
    try {
      session.ws.close(1001, 'Server restarting');
      closedCount++;
    } catch { /* ignore */ }
  }
  console.log(`[Shutdown] Closed ${closedCount} WebSocket connections`);
  sessions.clear();

  // Close HTTP server
  server.close(() => {
    console.log('[Shutdown] HTTP server closed');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    console.log('[Shutdown] Force exiting after timeout');
    process.exit(1);
  }, 30000);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle restart request from daemon (zero-downtime restart)
// Daemon will start new process before stopping this one
process.on('SIGUSR1', () => {
  console.log('\n[Restart] Received SIGUSR1, initiating graceful restart...');
  gracefulShutdown('SIGUSR1');
});

// ============================================================
// Feishu Channel Initialization
// ============================================================

// feishuConfig is imported as live binding from feishu.js
// It will auto-update when saveFeishuConfig() is called
if (feishuConfig?.enabled) {
  console.log('[Feishu] Channel enabled, client will be initialized when needed');
}

// Set up message processor for Feishu
setMessageProcessor(async (message, context) => {
  console.log('[Feishu] Processing message:', message);
  
  const config = loadConfig();
  const llmConfig = {
    provider: config.provider || 'qgenie',
    apiKey: config.apiKey,
    model: config.model,
    baseURL: config.baseURL || undefined,
  };
  
  const llm = new LLMAdapter(llmConfig);
  const system = buildSystemPrompt(config.provider);
  
  const orchestrator = new TaskOrchestrator(llm, (event) => {
    console.log('[Feishu] Orchestrator event:', event.type);
  }, () => false, { permissionManager, snapshotManager });
  
  try {
    const plan = await orchestrator.decompose(message, system);
    const executionResult = await orchestrator.executeAll(plan, { system, history: [] }, (taskId, chunk) => {});
    const results = executionResult.results || [];
    
    let finalAnswer;
    if (results.length === 1) {
      finalAnswer = results[0].result;
    } else {
      finalAnswer = await orchestrator.synthesize(message, results, { system, history: [] });
    }
    
    return finalAnswer;
  } catch (err) {
    console.error('[Feishu] Error processing message:', err);
    return `处理失败: ${err.message}`;
  }
});

// ============================================================
// Start
// ============================================================

const PORT = process.env.PORT || 3737;
server.listen(PORT, () => {
  console.log(`\n🚀 Agent WebUI Backend running at http://localhost:${PORT}`);
  console.log(`   Identity: ${JSON.stringify(identity.getSummary())}`);
  console.log(`   Skills loaded: ${skillLoader.getAll().length}`);
  console.log(`   Config: ${CONFIG_FILE}\n`);

  // ── Heartbeat Logger ─────────────────────────────────────
  // Log heartbeat every 60 seconds to show server is alive
  const HEARTBEAT_INTERVAL = 15 * 1000; // 15 seconds
  const startTime = Date.now();

  const heartbeatTimer = setInterval(() => {
    const uptime = Date.now() - startTime;
    const uptimeMinutes = Math.floor(uptime / 60000);
    const uptimeSeconds = Math.floor((uptime % 60000) / 1000);
    
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    const activeConnections = sessions.size;
    
    const timestamp = new Date().toISOString();
    console.log(`[Heartbeat] ${timestamp} | Uptime: ${uptimeMinutes}m ${uptimeSeconds}s | Memory: ${memMB}MB | Active Connections: ${activeConnections}`);
  }, HEARTBEAT_INTERVAL);

  // Store timer reference for cleanup
  server._heartbeatTimer = heartbeatTimer;

  console.log(`[Heartbeat] Logger started (interval: ${HEARTBEAT_INTERVAL / 1000}s)\n`);
});

// Cleanup heartbeat on server close
server.on('close', () => {
  if (server._heartbeatTimer) {
    clearInterval(server._heartbeatTimer);
    console.log('[Heartbeat] Logger stopped');
  }
});

export { app, server };
