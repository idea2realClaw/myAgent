#!/usr/bin/env node
// ============================================================
// Agent WebUI — Daemon Process
// Manages the main server process with graceful restart
// ============================================================

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, '.agent-webui-daemon.pid');
const SERVER_JS = path.join(__dirname, 'server.js');
const LOG_DIR = path.join(ROOT_DIR, 'logs');

// ============================================================
// Configuration
// ============================================================

const CONFIG = {
  serverJs: SERVER_JS,
  port: process.env.PORT || 3737,
  maxRestarts: 10,          // Maximum restarts in 10 minutes
  restartWindow: 10 * 60 * 1000, // 10 minutes
  restartDelay: 3000,       // Delay between restarts (3s)
  gracefulTimeout: 30000,   // Wait 30s for graceful shutdown
  healthCheckUrl: `http://localhost:${process.env.PORT || 3737}/api/health`,
  logFile: path.join(LOG_DIR, 'agent-webui-daemon.log'),
  serverLogFile: path.join(LOG_DIR, 'agent-webui-server.log'),
};

// ============================================================
// Logger
// ============================================================

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  fs.appendFileSync(CONFIG.logFile, line);
  console.log(line.trim());
}

// ============================================================
// PID file management
// ============================================================

function writePid() {
  fs.writeFileSync(PID_FILE, process.pid.toString());
  log(`Daemon PID ${process.pid} written to ${PID_FILE}`);
}

function removePid() {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
    log(`PID file removed`);
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Server Process Management
// ============================================================

let serverProcess = null;
let restartCount = 0;
let restartTimes = [];
let isShuttingDown = false;
let isRestarting = false;

function startServer() {
  log(`Starting server: ${CONFIG.serverJs}`);

  const logStream = fs.openSync(CONFIG.serverLogFile, 'a');

  serverProcess = spawn('node', [CONFIG.serverJs], {
    cwd: __dirname,
    stdio: ['ignore', logStream, logStream],
    detached: false,
    env: { ...process.env },
  });

  log(`Server process started (PID: ${serverProcess.pid})`);

  serverProcess.on('exit', (code, signal) => {
    log(`Server process exited (PID: ${serverProcess.pid}, code: ${code}, signal: ${signal})`);
    serverProcess = null;

    if (isShuttingDown) {
      log('Daemon is shutting down, not restarting server');
      return;
    }

    if (isRestarting) {
      log('Graceful restart in progress, starting new server...');
      isRestarting = false;
      setTimeout(() => startServer(), 1000);
      return;
    }

    // Check restart rate
    const now = Date.now();
    restartTimes = restartTimes.filter(t => now - t < CONFIG.restartWindow);
    
    if (restartTimes.length >= CONFIG.maxRestarts) {
      log(`Too many restarts (${restartTimes.length} in ${CONFIG.restartWindow / 1000}s), stopping daemon`, 'error');
      process.exit(1);
    }

    restartCount++;
    restartTimes.push(now);
    log(`Restarting server (attempt ${restartCount})...`);
    setTimeout(() => startServer(), CONFIG.restartDelay);
  });

  serverProcess.on('error', (err) => {
    log(`Server process error: ${err.message}`, 'error');
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      log('No server process to stop');
      resolve();
      return;
    }

    log(`Stopping server (PID: ${serverProcess.pid})...`);

    // Set timeout for force kill
    const forceKillTimeout = setTimeout(() => {
      if (serverProcess) {
        log(`Server did not exit in time, force killing (PID: ${serverProcess.pid})`, 'warn');
        serverProcess.kill('SIGKILL');
      }
    }, CONFIG.gracefulTimeout);

    serverProcess.once('exit', () => {
      clearTimeout(forceKillTimeout);
      log('Server stopped');
      serverProcess = null;
      resolve();
    });

    // Send SIGTERM for graceful shutdown
    serverProcess.kill('SIGTERM');
  });
}

async function gracefulRestart() {
  if (isRestarting) {
    log('Graceful restart already in progress');
    return false;
  }

  log('Initiating graceful restart...');
  isRestarting = true;

  await stopServer();

  // startServer() will be called by the exit handler
  return true;
}

// ============================================================
// Health Check
// ============================================================

async function checkHealth() {
  if (!serverProcess) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(CONFIG.healthCheckUrl, {
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);
    return response && response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// Control Socket (Unix Domain Socket for local control)
// ============================================================

import { createServer as createTCPServer } from 'net';
import http from 'http';

const CONTROL_PORT = 13737; // Control port for daemon commands

function startControlServer() {
  const controlServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/status') {
      res.writeHead(200);
      res.end(JSON.stringify({
        daemon: { pid: process.pid, uptime: process.uptime() },
        server: serverProcess ? { pid: serverProcess.pid, running: true } : { running: false },
      }));
    } else if (req.url === '/restart' && req.method === 'POST') {
      gracefulRestart().then((success) => {
        res.writeHead(success ? 200 : 409);
        res.end(JSON.stringify({ success }));
      });
    } else if (req.url === '/stop' && req.method === 'POST') {
      isShuttingDown = true;
      stopServer().then(() => {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        process.exit(0);
      });
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
    log(`Control server listening on 127.0.0.1:${CONTROL_PORT}`);
  });

  return controlServer;
}

// ============================================================
// Signal Handlers
// ============================================================

process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down gracefully...');
  isShuttingDown = true;
  await stopServer();
  removePid();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('Received SIGINT, shutting down...');
  isShuttingDown = true;
  await stopServer();
  removePid();
  process.exit(0);
});

// ============================================================
// Main
// ============================================================

async function main() {
  // Check if daemon is already running
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
    if (isRunning(oldPid)) {
      log(`Daemon is already running (PID: ${oldPid})`, 'error');
      process.exit(1);
    }
    log(`Removing stale PID file (old PID: ${oldPid})`);
    fs.unlinkSync(PID_FILE);
  }

  writePid();

  log(`Agent WebUI Daemon starting...`);
  log(`Server: ${CONFIG.serverJs}`);
  log(`Log: ${CONFIG.logFile}`);

  // Start control server
  startControlServer();

  // Start server process
  startServer();

  // Periodically check health
  setInterval(async () => {
    if (serverProcess && !isRestarting && !isShuttingDown) {
      const healthy = await checkHealth();
      if (!healthy) {
        log('Health check failed, server may be unresponsive', 'warn');
      }
    }
  }, 60000); // Check every 60 seconds
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`, 'error');
  process.exit(1);
});
