#!/usr/bin/env node
// ============================================================
// Agent WebUI — Daemon Process
// Manages the main server process with graceful restart
// Features:
//   - Zero-downtime restart (start new before stop old)
//   - Health check before switching
//   - Rate-limited restart
//   - Frontend notification via control API
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
  controlPort: process.env.CONTROL_PORT || 13737,
  maxRestarts: 10,          // Maximum restarts in 10 minutes
  restartWindow: 10 * 60 * 1000, // 10 minutes
  restartDelay: 3000,       // Delay between restarts (3s)
  gracefulTimeout: 30000,   // Wait 30s for graceful shutdown
  healthCheckUrl: `http://127.0.0.1:${process.env.PORT || 3737}/api/health`,
  healthCheckTimeout: 5000,  // 5s timeout for health check
  startupTimeout: 15000,     // 15s for server to start
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
  if (level === 'error' || level === 'warn') {
    console[level === 'error' ? 'error' : 'warn'](line.trim());
  } else {
    console.log(line.trim());
  }
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
let serverPort = CONFIG.port;
let restartCount = 0;
let restartTimes = [];
let isShuttingDown = false;
let isRestarting = false;
let restartResolve = null;

// Zero-downtime restart: start new server, wait for health, then stop old
async function zeroDowntimeRestart() {
  if (isRestarting) {
    log('Zero-downtime restart already in progress');
    return false;
  }

  log('Initiating zero-downtime restart...');
  isRestarting = true;

  const oldProcess = serverProcess;
  let newProcess = null;

  try {
    // 1. Start new server process
    log('Starting new server process...');
    newProcess = spawn('node', [CONFIG.serverJs], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, no_proxy: 'localhost,127.0.0.1', NO_PROXY: 'localhost,127.0.0.1' },
    });
    newProcess.unref();

    // Pipe output to log file
    const logStream = fs.createWriteStream(CONFIG.serverLogFile, { flags: 'a' });
    newProcess.stdout.pipe(logStream, { end: false });
    newProcess.stderr.pipe(logStream, { end: false });

    log(`New server process started (PID: ${newProcess.pid})`);

    // 2. Wait for new server to be healthy
    log('Waiting for new server to become healthy...');
    const healthy = await waitForHealth(newProcess, CONFIG.startupTimeout);

    if (!healthy) {
      log('New server failed to become healthy, aborting restart', 'error');
      newProcess.kill('SIGTERM');
      isRestarting = false;
      return false;
    }

    log('New server is healthy, stopping old server...');

    // 3. Stop old server gracefully
    if (oldProcess && !isShuttingDown) {
      await stopServerGraceful(oldProcess);
    }

    // 4. Update serverProcess reference
    serverProcess = newProcess;
    isRestarting = false;

    // 5. Set up exit handler for new process
    setupExitHandler(newProcess);

    log('Zero-downtime restart completed successfully');
    return true;

  } catch (err) {
    log(`Zero-downtime restart failed: ${err.message}`, 'error');
    if (newProcess && !newProcess.killed) {
      newProcess.kill('SIGKILL');
    }
    isRestarting = false;
    return false;
  }
}

// Wait for server to become healthy
async function waitForHealth(process, timeoutMs) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    // Check if process is still running
    if (process.exitCode !== null || process.signalCode !== null) {
      log('Server process exited before becoming healthy', 'warn');
      return false;
    }

    // Try health check
    const healthy = await checkHealth();
    if (healthy) {
      log(`Server became healthy after ${Date.now() - startTime}ms`);
      return true;
    }

    // Wait 500ms before next check
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  log(`Server failed to become healthy within ${timeoutMs}ms`, 'warn');
  return false;
}

// Check server health
async function checkHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.healthCheckTimeout);

    const response = await fetch(CONFIG.healthCheckUrl, {
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);
    return response && response.ok;
  } catch {
    return false;
  }
}

// Stop server gracefully
async function stopServerGraceful(process) {
  return new Promise((resolve) => {
    if (!process || process.killed) {
      resolve();
      return;
    }

    log(`Stopping server gracefully (PID: ${process.pid})...`);

    // Set timeout for force kill
    const forceKillTimeout = setTimeout(() => {
      if (process && !process.killed) {
        log(`Server did not exit in time, force killing (PID: ${process.pid})`, 'warn');
        process.kill('SIGKILL');
      }
    }, CONFIG.gracefulTimeout);

    process.once('exit', () => {
      clearTimeout(forceKillTimeout);
      log(`Server stopped (PID: ${process.pid})`);
      resolve();
    });

    // Send SIGTERM for graceful shutdown
    process.kill('SIGTERM');
  });
}

// Set up exit handler for server process
function setupExitHandler(process) {
  process.on('exit', (code, signal) => {
    log(`Server process exited (PID: ${process.pid}, code: ${code}, signal: ${signal})`);
    serverProcess = null;

    if (isShuttingDown) {
      log('Daemon is shutting down, not restarting server');
      return;
    }

    if (isRestarting) {
      // This shouldn't happen with zero-downtime restart
      log('Server exited during restart, this shouldn\'t happen', 'warn');
      isRestarting = false;
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

  process.on('error', (err) => {
    log(`Server process error: ${err.message}`, 'error');
  });
}

function startServer() {
  log(`Starting server: ${CONFIG.serverJs}`);

  serverProcess = spawn('node', [CONFIG.serverJs], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, no_proxy: 'localhost,127.0.0.1', NO_PROXY: 'localhost,127.0.0.1' },
  });
  serverProcess.unref();

  // Pipe output to log file
  const logStream = fs.createWriteStream(CONFIG.serverLogFile, { flags: 'a' });
  serverProcess.stdout.pipe(logStream, { end: false });
  serverProcess.stderr.pipe(logStream, { end: false });

  log(`Server process started (PID: ${serverProcess.pid})`);

  setupExitHandler(serverProcess);
}

async function gracefulRestart() {
  return await zeroDowntimeRestart();
}

// ============================================================
// Control Server
// ============================================================

import http from 'http';

function startControlServer() {
  const controlServer = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/status') {
      const status = {
        daemon: { pid: process.pid, uptime: process.uptime() },
        server: serverProcess ? { pid: serverProcess.pid, running: true } : { running: false },
        restarting: isRestarting,
      };
      res.writeHead(200);
      res.end(JSON.stringify(status));
    } else if (req.url === '/restart' && req.method === 'POST') {
      if (isRestarting) {
        res.writeHead(409);
        res.end(JSON.stringify({ success: false, error: 'Restart already in progress' }));
        return;
      }
      gracefulRestart().then((success) => {
        res.writeHead(success ? 200 : 500);
        res.end(JSON.stringify({ success }));
      });
    } else if (req.url === '/stop' && req.method === 'POST') {
      isShuttingDown = true;
      stopServerGraceful(serverProcess).then(() => {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        removePid();
        process.exit(0);
      });
    } else if (req.url === '/health') {
      checkHealth().then((healthy) => {
        res.writeHead(healthy ? 200 : 503);
        res.end(JSON.stringify({ healthy }));
      });
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  controlServer.listen(CONFIG.controlPort, '127.0.0.1', () => {
    log(`Control server listening on 127.0.0.1:${CONFIG.controlPort}`);
  });

  return controlServer;
}

// ============================================================
// Signal Handlers
// ============================================================

process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down gracefully...');
  isShuttingDown = true;
  await stopServerGraceful(serverProcess);
  removePid();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('Received SIGINT, shutting down...');
  isShuttingDown = true;
  await stopServerGraceful(serverProcess);
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

  const daemonStartTime = Date.now();
  log(`Agent WebUI Daemon starting...`);
  log(`Server: ${CONFIG.serverJs}`);
  log(`Log: ${CONFIG.logFile}`);

  // Start control server
  startControlServer();

  // Start server process
  startServer();

  // ── Heartbeat Logger ─────────────────────────────────
  // Log heartbeat every 60 seconds to show daemon is alive
  const HEARTBEAT_INTERVAL = 60 * 1000; // 60 seconds

  const heartbeatTimer = setInterval(() => {
    const uptime = Date.now() - daemonStartTime;
    const uptimeMinutes = Math.floor(uptime / 60000);
    const uptimeSeconds = Math.floor((uptime % 60000) / 1000);
    
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    const serverStatus = serverProcess ? `Running (PID: ${serverProcess.pid})` : 'Stopped';
    
    log(`♥ Heartbeat | Uptime: ${uptimeMinutes}m ${uptimeSeconds}s | Memory: ${memMB}MB | Server: ${serverStatus}`, 'info');
  }, HEARTBEAT_INTERVAL);

  log(`Heartbeat logger started (interval: ${HEARTBEAT_INTERVAL / 1000}s)`, 'info');

  // Store timer reference for cleanup
  process._heartbeatTimer = heartbeatTimer;

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

// Cleanup heartbeat on shutdown
process.on('exit', () => {
  if (process._heartbeatTimer) {
    clearInterval(process._heartbeatTimer);
  }
});

main().catch((err) => {
  log(`Fatal error: ${err.message}`, 'error');
  process.exit(1);
});
