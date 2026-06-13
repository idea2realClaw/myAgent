// ============================================================
// Main Server — Express + WebSocket
// Agent WebUI Backend
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
import { executeTool, buildToolInstructions } from './tool-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const IDENTITY_DIR = path.join(ROOT_DIR, 'identity');
const SKILLS_DIR = ROOT_DIR;
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

// ── Config persistence ──────────────────────────────
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch { /* ignore */ }
  }
  return {
    provider: 'openrouter',
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    apiKey: '',
    baseURL: 'https://openrouter.ai/api/v1',
    temperature: 0.7,
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── App init ─────────────────────────────────────────
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT_DIR, 'frontend', 'dist')));

// ── Singletons ───────────────────────────────────────
const identity = new IdentityManager(IDENTITY_DIR);
identity.load();

const skillLoader = new SkillLoader(ROOT_DIR);
skillLoader.load();

// ── WebSocket sessions ─────────────────────────────────
const sessions = new Map(); // sessionId -> { ws, history, config }

function broadcast(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── Build system prompt ──────────────────────────────
function buildSystemPrompt() {
  const parts = [];

  // Identity block (injected but output is filtered)
  const identBlock = identity.buildSystemBlock();
  if (identBlock) parts.push(identBlock);

  // Skills
  const skillsSnippet = skillLoader.toSystemPromptSnippet();
  if (skillsSnippet) parts.push(skillsSnippet);

  // Base instructions + tool instructions
  parts.push(`You are a powerful AI Agent.
- When a user loads a skill by name, inject the skill's full content and follow its instructions.
- Decompose complex tasks into parallel subtasks when beneficial.
- Be direct, thorough, and resourceful.
- Current date: ${new Date().toISOString().split('T')[0]}`);

  // Append tool usage instructions
  parts.push(buildToolInstructions());

  return parts.join('\n\n');
}

// ── REST API ─────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Get config (API keys masked)
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    provider: cfg.provider,
    model: cfg.model,
    hasApiKey: Boolean(cfg.apiKey),
    baseURL: cfg.baseURL || '',
    temperature: cfg.temperature ?? 0.7,
  });
});

// Update config
app.post('/api/config', (req, res) => {
  const existing = loadConfig();
  const updated = { ...existing, ...req.body };
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

// ── WebSocket handler ─────────────────────────────────
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
    } else if (msg.type === 'reload_skills') {
      skillLoader.load();
      broadcast(ws, { type: 'skills_reloaded', skills: skillLoader.getAll() });
    } else if (msg.type === 'stop') {
      // Set stop flag for this session
      session.stopRequested = true;
      broadcast(ws, { type: 'stopped', message: 'Task stopped by user' });
    }
  });

  ws.on('close', () => {
    sessions.delete(sessionId);
  });
});

// ── Direct tool/command execution (no LLM needed) ───────
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

// ── Chat handler ──────────────────────────────────────
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

  // Check API key
  const cfg = { ...loadConfig(), ...config };
  if (!cfg.apiKey) {
    broadcast(ws, {
      type: 'error',
      message: 'No API key configured. Please set your API key in Settings.',
    });
    return;
  }

  // Build LLM adapter
  const llmConfig = {
    provider: cfg.provider || 'openai',
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL: cfg.provider === 'openrouter'
      ? (cfg.baseURL || 'https://openrouter.ai/api/v1')
      : cfg.baseURL || undefined,
  };
  const llm = new LLMAdapter(llmConfig);

  // Add user message to history
  history.push({ role: 'user', content: userMessage });

  const system = buildSystemPrompt();
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

// ── SPA fallback ──────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(ROOT_DIR, 'frontend', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built yet.');
  }
});

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3737;
server.listen(PORT, () => {
  console.log(`\n🚀 Agent WebUI Backend running at http://localhost:${PORT}`);
  console.log(`   Identity: ${JSON.stringify(identity.getSummary())}`);
  console.log(`   Skills loaded: ${skillLoader.getAll().length}`);
  console.log(`   Config: ${CONFIG_FILE}\n`);
});

export { app, server };
