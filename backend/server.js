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
import { feishuConfig, loadConfig as loadFeishuConfig, saveConfig as saveFeishuConfig, sendMessage as sendFeishuMessage, replyMessage as replyFeishuMessage, updateMessage as updateFeishuMessage, setMessageProcessor, createWebhookMiddleware, handleWebhookEvent, getStatus as getFeishuStatus } from './channels/feishu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const IDENTITY_DIR = path.join(ROOT_DIR, 'identity');
const SKILLS_DIR = ROOT_DIR;
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const MODELS_FILE = path.join(ROOT_DIR, 'backend', 'models.json');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

// Create required directories on startup
[IDENTITY_DIR, LOGS_DIR, path.join(ROOT_DIR, 'backend', 'logs')].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Startup] Created directory: ${dir}`);
  }
});

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

// ============================================================
// WebSocket sessions
// ============================================================

const sessions = new Map(); // sessionId -> { ws, history, config }

function broadcast(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

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
  // Prevent empty apiKey from overwriting existing key
  if (!req.body.apiKey && existing.apiKey) {
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

// ============================================================
// Log helper — sends log events to WebSocket client
// ============================================================
function sendLog(ws, level, message, data) {
  const log = {
    type: 'log',
    level,
    message,
    timestamp: new Date().toISOString(),
    data: data || null,
  };
  try { ws.send(JSON.stringify(log)); } catch { /* ignore */ }
}

// ============================================================
// WebSocket handler
// ============================================================

wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, { ws, history: [], config: loadConfig() });

  // ── 发送启动日志 ──────────────────────────────────────
  const cfg = loadConfig();
  sendLog(ws, 'info', '🟢 WebUI 已连接', { session: sessionId.slice(0, 8) });
  sendLog(ws, 'info', '⚙️ 配置加载完成', { provider: cfg.provider, model: cfg.model });
  sendLog(ws, 'info', `📦 技能已加载: ${skillLoader.getAll().length} 个`);

  // 异步检查 LLM 连接
  (async () => {
    sendLog(ws, 'info', '🔌 开始测试 LLM 连接...', { provider: cfg.provider, url: cfg.baseURL || '默认' });
    const status = await refreshStatus();
    if (status.model === 'ok') {
      sendLog(ws, 'info', `✅ LLM 连接测试通过`, { message: status.modelMessage });
    } else {
      sendLog(ws, 'error', `❌ LLM 连接测试失败`, { message: status.modelMessage });
    }
  })();

  // 异步检查飞书连接
  (async () => {
    const fStatus = getFeishuStatus();
    if (fStatus?.enabled) {
      sendLog(ws, 'info', `🔌 飞书通道已启用`);
      if (fStatus.hasCredentials) {
        sendLog(ws, 'info', `✅ 飞书凭据已配置${fStatus.hasToken ? '，连接正常' : '，等待获取 Token'}`);
      } else {
        sendLog(ws, 'warn', `⚠️ 飞书已启用但凭据未完全配置`);
      }
    } else {
      sendLog(ws, 'info', `⏸️ 飞书通道未启用（可在 Settings 中配置）`);
    }
  })();

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
      const existing = loadConfig();
      const merged = { ...existing, ...msg.config };
      // Mask API key if '***' (same protection as HTTP POST)
      if (msg.config && msg.config.apiKey === '***') {
        merged.apiKey = existing.apiKey;
      }
      // Prevent empty apiKey from overwriting existing key
      if (msg.config && !msg.config.apiKey && existing.apiKey) {
        merged.apiKey = existing.apiKey;
      }
      session.config = merged;
      saveConfig(merged);

      // Auto-add model to models.json if not already present
      try {
        const model = merged.model;
        const provider = merged.provider;
        if (model && provider) {
          const data = loadModels();
          if (!data[provider]) data[provider] = [];
          if (!data[provider].includes(model)) {
            data[provider].push(model);
            saveModels(data);
            console.log(`[Models] Auto-added ${model} to ${provider} list`);
          }
        }
      } catch (e) {
        console.error('[Models] Failed to auto-add model:', e.message);
      }

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
      broadcast(ws, { type: 'stopped', message: 'Task stopped by user' });
    } else if (msg.type === 'restart') {
      // Request graceful restart (daemon will handle this)
      broadcast(ws, { type: 'restarting', message: 'Server restarting...' });
      // Send SIGUSR1 to self (daemon will detect and restart)
      process.kill(process.pid, 'SIGUSR1');
    } else if (msg.type === 'exec_stream') {
      // Real-time streaming execution
      await handleExecStream(ws, session, msg);
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
// Simple command detection
// ============================================================

function isSimpleCommand(input) {
  const trimmed = input.trim();

  // Common Chinese/English greetings and short phrases
  const greetings = [
    '你好', '您好', '早上好', '上午好', '下午好', '晚上好',
    '好吗', '好不好', '怎么样', '如何',
    '谢谢', '感谢', '多谢',
    '再见', '拜拜', '拜拜了',
    '是的', '对的', '没错', 'ok', 'OK', 'Ok',
    '好的', '好', '行', '可以', '没问题',
    'hi', 'Hi', 'hello', 'Hello', 'hey', 'Hey',
    'thanks', 'Thank you', 'Bye', 'Goodbye',
  ];

  // Check if input is a greeting (exact match or starts with greeting)
  for (const g of greetings) {
    if (trimmed === g || (trimmed.startsWith(g) && trimmed.length <= g.length + 5)) {
      return true;
    }
  }

  // Check length (<10 Chinese characters)
  const charCount = Array.from(trimmed).length;
  if (charCount < 10) {
    return true;
  }

  return false;
}

// ============================================================
// Chat handler
// ============================================================

async function handleChat(sessionId, session, msg) {
  const { ws, history, config } = session;
  const userMessage = msg.content;

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

  sendLog(ws, 'info', `收到用户消息`, { content: userMessage.slice(0, 100) });

  const system = buildSystemPrompt(cfg.provider);
  const context = { system, history: history.slice(-10) };

  const isSimple = isSimpleCommand(userMessage);

  if (isSimple) {
    sendLog(ws, 'info', `简单指令，跳过任务分解`, { charCount: userMessage.trim().length });

    // 直接调用 LLM，不用子任务 Panel
    broadcast(ws, { type: 'thinking', message: '思考中...' });

    try {
      // 构造 API 请求信息并打印日志
      const apiUrl = llmConfig.baseURL || (llmConfig.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
      const apiModel = llmConfig.model || 'gpt-4o';
      
      // 构造完整的请求 messages
      const requestMessages = [
        { role: 'system', content: system },
        ...history.slice(-10),
      ];
      
      // 打印请求体（双向日志 - 请求）
      sendLog(ws, 'info', `🤖 发送 LLM 请求`, {
        provider: llmConfig.provider,
        model: apiModel,
        url: `${apiUrl}/chat/completions`,
        messageCount: requestMessages.length,
      });
      
      // 打印每条 message 的摘要（避免日志过长）
      requestMessages.forEach((msg, idx) => {
        const contentPreview = (msg.content || '').slice(0, 200).replace(/\n/g, ' ');
        sendLog(ws, 'info', `  [请求] Message ${idx + 1}`, {
          role: msg.role,
          contentPreview: contentPreview + (msg.content && msg.content.length > 200 ? '...' : ''),
        });
      });
      
      // 直接创建 Assistant 气泡，流式输出
      const currentBubble = true;
      let fullResponse = '';

      for await (const chunk of llm.stream(requestMessages)) {
        if (chunk.type === 'text') {
          fullResponse += chunk.content;
          broadcast(ws, { type: 'synthesis_chunk', chunk: chunk.content });
        } else if (chunk.type === 'tool_call') {
          sendLog(ws, 'warn', `🔧 简单问题触发工具调用`, { tool: chunk.name, args: JSON.stringify(chunk.args).slice(0, 100) });
        }
      }

      sendLog(ws, 'info', `✅ LLM 返回成功`, { contentLength: fullResponse.length });

      // 打印响应体（双向日志 - 响应）
      const responsePreview = fullResponse.slice(0, 500).replace(/\n/g, ' ');
      sendLog(ws, 'info', `  [响应] LLM 返回内容`, {
        preview: responsePreview + (fullResponse.length > 500 ? '...' : ''),
        fullLength: fullResponse.length,
      });

      // 过滤身份泄露
      const filteredAnswer = identity.filterOutput(fullResponse);

      // 添加到历史
      history.push({ role: 'assistant', content: filteredAnswer });

      broadcast(ws, { type: 'synthesis_done' });
      broadcast(ws, { type: 'done', content: filteredAnswer, subtasks: [] });

    } catch (err) {
      sendLog(ws, 'error', `❌ LLM API 请求失败`, { error: err.message });
      broadcast(ws, { type: 'error', message: `LLM 请求失败: ${err.message}` });
    }

    return;
  }

  // 复杂指令：执行任务分解
  sendLog(ws, 'info', `复杂指令，开始任务分解`, { contentLength: userMessage.length });
  broadcast(ws, { type: 'thinking', message: '分析中...' });

  const orchestrator = new TaskOrchestrator(llm, (event) => {
    broadcast(ws, event);
  }, () => session.stopRequested);

  try {
    // Step 1: Decompose task
    sendLog(ws, 'info', `开始任务分解`);
    
    // 计算 API URL
    const decompApiUrl = llmConfig.baseURL || (llmConfig.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : llmConfig.provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
    const decompApiModel = llmConfig.model || 'default';
    
    // 打印分解请求（双向日志 - 请求）
    const decompMessages = [
      { role: 'system', content: system },
      { role: 'user', content: `请分解任务：${userMessage}` },
    ];
    sendLog(ws, 'info', `🤖 发送 LLM 分解请求`, {
      provider: llmConfig.provider,
      model: decompApiModel,
      url: `${decompApiUrl}/chat/completions`,
      task: userMessage.slice(0, 60),
      messageCount: decompMessages.length,
    });
    
    decompMessages.forEach((msg, idx) => {
      const contentPreview = (msg.content || '').slice(0, 200).replace(/\n/g, ' ');
      sendLog(ws, 'info', `  [分解请求] Message ${idx + 1}`, {
        role: msg.role,
        contentPreview: contentPreview + (msg.content && msg.content.length > 200 ? '...' : ''),
      });
    });
    
    broadcast(ws, { type: 'decomposing' });
    const plan = await orchestrator.decompose(userMessage, system);
    
    // 打印分解响应（双向日志 - 响应）
    sendLog(ws, 'info', `✅ 任务分解完成`, { title: plan.title, subtaskCount: plan.subtasks.length });
    const planPreview = JSON.stringify(plan).slice(0, 500);
    sendLog(ws, 'info', `  [分解响应] 分解计划`, {
      planPreview: planPreview + (JSON.stringify(plan).length > 500 ? '...' : ''),
    });

    // 打印每个子任务的工具调用指令
    sendLog(ws, 'info', `📋 分解计划:`);
    plan.subtasks.forEach((t, i) => {
      sendLog(ws, 'info', `  ${i + 1}. [${t.id}] ${t.title}`, {
        tool: t.tool,
        args: JSON.stringify(t.args).slice(0, 100),
        depends_on: (t.depends_on || []).join(',') || '-',
      });
    });

    broadcast(ws, {
      type: 'plan',
      plan: {
        title: plan.title,
        subtaskCount: plan.subtasks.length,
        subtasks: plan.subtasks.map(t => ({
          id: t.id,
          title: t.title,
          tool: t.tool,
          args: t.args,
          depends_on: t.depends_on || [],
          status: 'pending',
        })),
      },
    });

    // Step 2: Execute subtasks (parallel where possible)
    sendLog(ws, 'info', `🚀 开始执行子任务`);
    const results = await orchestrator.executeAll(plan, context, (taskId, chunk) => {
      // chunk events already sent via onProgress
    });

    // 打印每个子任务的执行结果摘要
    results.forEach(r => {
      const preview = (r.result || '').slice(0, 80).replace(/\n/g, ' ');
      sendLog(ws, r.status === 'done' ? 'info' : 'warn', `  ${r.id} ${r.title} → ${r.status}`, { preview: preview + '...' });
    });
    sendLog(ws, 'info', `✅ 所有子任务执行完成`, { count: results.length });

    // Step 3: Synthesize if multiple subtasks
    let finalAnswer;
    if (results.length === 1) {
      finalAnswer = results[0].result;
    } else {
      sendLog(ws, 'info', `开始综合多个子任务结果`, { count: results.length });
      broadcast(ws, { type: 'synthesizing' });
      finalAnswer = await orchestrator.synthesize(userMessage, results, context);
    }

    // Filter identity leakage
    finalAnswer = identity.filterOutput(finalAnswer);

    sendLog(ws, 'info', `任务完成，返回给用户`, { contentLength: finalAnswer.length });

    // Add to history
    history.push({ role: 'assistant', content: finalAnswer });

    broadcast(ws, {
      type: 'done',
      content: finalAnswer,
      subtasks: results.map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
      })),
    });

  } catch (err) {
    sendLog(ws, 'error', `聊天处理异常`, { error: err.message });
    broadcast(ws, { type: 'error', message: err.message });
  }
}

// ============================================================
// Model List Management (models.json)
// ============================================================

function loadModels() {
  if (fs.existsSync(MODELS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    } catch { /* ignore */ }
  }
  // Default structure
  return {
    qgenie: ['default'],
    local: ['default'],
    openai: ['gpt-4o', 'gpt-4o-mini'],
    anthropic: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514'],
    openrouter: ['nvidia/nemotron-3-super-120b-a12b:free'],
  };
}

function saveModels(data) {
  try {
    fs.writeFileSync(MODELS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Models] Failed to save models.json:', e.message);
  }
}

// Get models for a provider
app.get('/api/models/:provider', (req, res) => {
  const { provider } = req.params;
  const data = loadModels();
  const models = data[provider] || [];
  res.json({ provider, models });
});

// Add a model to a provider's list
app.post('/api/models/:provider', express.json(), (req, res) => {
  const { provider } = req.params;
  const { model } = req.body;
  if (!model || !provider) {
    return res.status(400).json({ error: 'Missing provider or model' });
  }
  const data = loadModels();
  if (!data[provider]) data[provider] = [];
  if (!data[provider].includes(model)) {
    data[provider].push(model);
    saveModels(data);
    console.log(`[Models] Added ${model} to ${provider} list`);
  }
  res.json({ provider, models: data[provider] });
});

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
  }, () => false);
  
  try {
    const plan = await orchestrator.decompose(message, system);
    const results = await orchestrator.executeAll(plan, { system, history: [] }, (taskId, chunk) => {});
    
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
});

export { app, server };
