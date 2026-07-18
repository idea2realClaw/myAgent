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
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

import { LLMAdapter } from './llm-adapter.js';
import { SkillLoader } from './skill-loader.js';
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
    const openRoundStream = async function* (_roundNo, sendWire) {
      let frames = [];
      try {
        for await (const chunk of llm.stream(sendWire, supportsTools ? { tools: toolSchemas, temperature: 0.7 } : { temperature: 0.7 })) {
          if (chunk.type === 'text') frames.push({ type: 'chunk', text: chunk.content });
          else if (chunk.type === 'tool_call') frames.push({ type: 'tool_call', id: chunk.id, name: chunk.name, arguments: chunk.arguments });
        }
        frames.push({ type: 'end', payload: {} });
      } catch (e) {
        frames.push({ type: 'error', message: e.message });
      }
      for (const f of frames) yield f;
    };
    const buffered = [];
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
    return { content: text, buffered };
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

  // 写回历史
  history.push({ role: 'assistant', content: finalText });

  broadcast(ws, {
    type: 'done',
    content: finalText,
    subtasks: executedTools.map((t) => ({ id: t.id, title: t.title, status: t.status })),
  });

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
        return await runSkillTool(args, callId);
      }
      const result = await executeTool({ name, arguments: args });
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

// 主循环中 skill 工具：加载 skill 全文作为工具结果返回给模型遵循
async function runSkillTool(args, callId) {
  const start = Date.now();
  const name = args.name;
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

// 检测模型是否在「无工具可用」的简单路径下退化成输出了“未执行的工具/技能调用”JSON。
// 例如 { "invocation": "deep-search", "query": "..." } 或 { "tool": "...", "arguments": ... }。
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

// ============================================================
// Chat handler
// ============================================================

async function handleChat(sessionId, session, msg) {
  const { ws, history, config } = session;
  const userMessage = msg.content;
  const conversationId = msg.conversationId || 'unknown';

  // Log conversation information
  console.log(`[Conversation] sessionId=${sessionId}, conversationId=${conversationId}, message="${userMessage.substring(0, 100)}..."`);

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

  try {
    if (isSimple) {
      broadcast(ws, { type: 'thinking', message: '思考中...' });
      await runAgentLoop({ ws, session, llm, system, history, config: cfg, useTools: false });
    } else {
      broadcast(ws, { type: 'thinking', message: '🧠 正在规划并执行任务（含工具调用 / 子 Agent）...' });
      await runAgentLoop({ ws, session, llm, system, history, config: cfg, useTools: true });
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
