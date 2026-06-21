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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const IDENTITY_DIR = path.join(ROOT_DIR, 'identity');
const SKILLS_DIR = ROOT_DIR;
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

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

  const system = buildSystemPrompt(cfg.provider);
  const context = { system, history: history.slice(-10) };

  broadcast(ws, { type: 'thinking', message: 'Analyzing your request...' });

  const orchestrator = new TaskOrchestrator(llm, (event) => {
    broadcast(ws, event);
  }, () => session.stopRequested);

  try {
    // Step 1: Decompose task
    broadcast(ws, { type: 'decomposing' });
    const plan = await orchestrator.decompose(userMessage, system);
    broadcast(ws, {
      type: 'plan',
      plan: {
        title: plan.title,
        subtaskCount: plan.subtasks.length,
        subtasks: plan.subtasks.map(t => ({
          id: t.id,
          title: t.title,
          type: t.type,
          status: 'pending',
        })),
      },
    });

    // Step 2: Execute subtasks (parallel where possible)
    const results = await orchestrator.executeAll(plan, context, (taskId, chunk) => {
      // chunk events already sent via onProgress
    });

    // Step 3: Synthesize if multiple subtasks
    let finalAnswer;
    if (results.length === 1) {
      finalAnswer = results[0].result;
    } else {
      broadcast(ws, { type: 'synthesizing' });
      finalAnswer = await orchestrator.synthesize(userMessage, results, context);
    }

    // Filter identity leakage
    finalAnswer = identity.filterOutput(finalAnswer);

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
  for (const [sessionId, session] of sessions) {
    try {
      session.ws.close(1001, 'Server restarting');
    } catch { /* ignore */ }
  }
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

// Handle restart request from daemon
process.on('SIGUSR1', () => {
  console.log('\n[Restart] Received SIGUSR1, initiating graceful restart...');
  gracefulShutdown('SIGUSR1').then(() => {
    // Daemon will restart us
  });
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
