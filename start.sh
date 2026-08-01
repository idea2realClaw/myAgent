#!/usr/bin/env bash
# ============================================================
# Agent WebUI — Start Script (Cross-platform: Windows / macOS / Linux)
# ============================================================
# Single-process design: there is NO separate daemon. The server process
# (backend/server.js) self-monitors and self-restarts (re-exec on restart
# request or after a fatal crash), so it needs only ONE port (3737) and no
# extra control port. This launcher just starts/stops that one process.

# ── OS Detection ─────────────────────────────────────────────
__OS_TYPE="$(uname -s 2>/dev/null || echo 'Unknown')"
case "$__OS_TYPE" in
  Darwin*) __OS="mac" ;;
  Linux*)  __OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) __OS="windows" ;;
  *)       __OS="unknown" ;;
esac
export __OS

# ── Node.js Discovery ───────────────────────────────────────
# Try to find node in common locations for current OS
if [ "$__OS" = "mac" ] || [ "$__OS" = "linux" ]; then
  for __node_dir in \
    "/usr/local/bin" \
    "/opt/homebrew/bin" \
    "$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin" \
    "$HOME/.volta/bin" \
    "/usr/bin"; do
    if [ -f "$__node_dir/node" ] && [ -x "$__node_dir/node" ]; then
      export PATH="$__node_dir:$PATH"
      break
    fi
  done
  # Also try nvm
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh" 2>/dev/null || true
  fi
else
  # Windows / Git Bash
  for __node_dir in \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2" \
    "$HOME/.workbuddy/binaries/node/versions/24.14.0" \
    "/c/Program Files/nodejs" \
    "$HOME/AppData/Local/Programs/nodejs"; do
    if [ -f "$__node_dir/node.exe" ]; then
      export PATH="$__node_dir:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install from https://nodejs.org"
  exit 1
fi

# ── Path helper ─────────────────────────────────────────────
# Cross-platform SCRIPT_DIR: always get a usable absolute path
if [ "$__OS" = "windows" ]; then
  # Convert Unix-style path (Git Bash) to Windows-style for Node.js
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SCRIPT_DIR_WIN="$(cygpath -w "$SCRIPT_DIR" 2>/dev/null || echo "$SCRIPT_DIR")"
  # If cygpath failed, do manual conversion
  if [ "$SCRIPT_DIR_WIN" = "$SCRIPT_DIR" ]; then
    SCRIPT_DIR_WIN="$(echo "$SCRIPT_DIR" | sed 's|^/\([a-zA-Z]\)/|\1:/|' | sed 's|/|\\\\|g')"
  fi
  BACKEND_DIR="$SCRIPT_DIR_WIN/backend"
  SERVER_JS="$BACKEND_DIR/server.js"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BACKEND_DIR="$SCRIPT_DIR/backend"
  SERVER_JS="$BACKEND_DIR/server.js"
fi
APP_PORT=3737

# ── Proxy avoidance ─────────────────────────────────────────
export no_proxy="${no_proxy:+$no_proxy,}localhost,127.0.0.1"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1"

set -e
echo "Node.js found: $(command -v node)"
echo "OS detected: $__OS"
echo ""

# ── Python Virtual Environment Setup ─────────────────────────
if [ "$__OS" = "mac" ] || [ "$__OS" = "linux" ]; then
  VENV_PYTHON="$SCRIPT_DIR/venv/bin/python3"
  if [ -f "$VENV_PYTHON" ]; then
    PY_VER="$("$VENV_PYTHON" --version 2>&1)"
    echo "Python venv: $PY_VER"
    export PATH="$SCRIPT_DIR/venv/bin:$PATH"
  else
    echo "No Python venv found. Run ./setup-mac.sh to create one."
  fi
elif [ "$__OS" = "windows" ]; then
  # ARM64 Windows: use bundled python-arm64
  for py_dir in \
    "$SCRIPT_DIR/python-arm64" \
    "$SCRIPT_DIR/venv/Scripts"; do
    if [ -f "$py_dir/python.exe" ]; then
      PY_VER="$("$py_dir/python.exe" --version 2>&1)"
      echo "Python: $PY_VER ($py_dir)"
      export PATH="$py_dir:$PATH"
      break
    fi
  done
fi
echo ""

echo "=============================================="
echo "       Agent WebUI Launcher (MyAgent)"
echo "=============================================="
echo ""

# ── Install deps if needed ────────────────────────────────
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  cd "$BACKEND_DIR" && npm install
  cd "$SCRIPT_DIR"
fi

# ── Cross-platform process check ───────────────────────────
check_process() {
  local pid="$1"
  if [ -z "$pid" ] || ! [ "$pid" -gt 0 ] 2>/dev/null; then
    return 1
  fi
  if [ "$__OS" = "windows" ]; then
    # Windows: use tasklist.exe
    tasklist.exe /FI "PID eq $pid" 2>/dev/null | grep -q "$pid"
  else
    # Mac/Linux: use kill -0
    kill -0 "$pid" 2>/dev/null
  fi
}

# ── Cross-platform kill ────────────────────────────────────
kill_process() {
  local pid="$1"
  if ! check_process "$pid"; then
    return 0   # already not running
  fi
  if [ "$__OS" = "windows" ]; then
    taskkill.exe /F /PID "$pid" 2>/dev/null || true
  else
    kill "$pid" 2>/dev/null || true
    sleep 2
    if check_process "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  # Wait briefly and confirm
  sleep 1
  if check_process "$pid"; then
    echo "   Process $pid may still be running"
  fi
  return 0
}

# ── PID file (single server process, no daemon) ───────────
PID_FILE="$SCRIPT_DIR/.agent-webui.pid"
LOG_FILE="$SCRIPT_DIR/logs/agent-webui-server.log"

# ── Check if server is running ────────────────────────────
check_server() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || echo '')"
    if check_process "$pid"; then
      return 0
    fi
  fi
  return 1
}

# ── Stop server ────────────────────────────────────────────
stop_server() {
  if check_server; then
    local pid
    pid="$(cat "$PID_FILE")"
    echo "Stopping MyAgent (PID: $pid)..."
    kill_process "$pid"
    rm -f "$PID_FILE"
    echo "MyAgent stopped"
  else
    echo "MyAgent is not running"
  fi
}

# ── Restart server ─────────────────────────────────────────
restart_server() {
  if check_server; then
    echo "Restarting MyAgent..."
    local pid
    pid="$(cat "$PID_FILE")"
    # server.js handles SIGUSR1 by re-executing itself (self-restart)
    kill -USR1 "$pid" 2>/dev/null || true
    echo "Restart signal sent (process re-executes itself)"
  else
    echo "MyAgent is not running, starting..."
    start_server
  fi
}

# ── Start server (background, self-monitoring) ───────────
start_server() {
  if check_server; then
    local pid
    pid="$(cat "$PID_FILE")"
    echo "MyAgent is already running (PID: $pid)"
    echo "   URL: http://localhost:$APP_PORT"
    return 0
  fi

  mkdir -p "$SCRIPT_DIR/identity"
  mkdir -p "$SCRIPT_DIR/logs"
  mkdir -p "$SCRIPT_DIR/backend/logs"

  echo "Starting MyAgent (single process, self-monitoring)..."
  echo "   Logs: $LOG_FILE"
  echo ""

  # Launch server detached from this terminal (the process self-heals /
  # self-restarts, no daemon needed):
  # - < /dev/null so the server does not hold this terminal's stdin
  # - Linux/mac: setsid creates a new session; Windows Git Bash: nohup
  if [ "$__OS" = "windows" ]; then
    nohup node "$SERVER_JS" > "$LOG_FILE" 2>&1 < /dev/null &
  else
    if command -v setsid >/dev/null 2>&1; then
      setsid node "$SERVER_JS" > "$LOG_FILE" 2>&1 < /dev/null &
    else
      nohup node "$SERVER_JS" > "$LOG_FILE" 2>&1 < /dev/null &
    fi
  fi

  local server_pid=$!
  echo "$server_pid" > "$PID_FILE"
  echo "   Launched (PID: $server_pid), waiting for server to be ready..."

  # Success check: probe /api/health on 3737 (200 means the server is ready)
  local waited=0
  local use_curl=0
  command -v curl >/dev/null 2>&1 && use_curl=1
  while [ $waited -lt 20 ]; do
    local up=0
    if [ $use_curl -eq 1 ]; then
      if curl -s -m 2 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
        up=1
      fi
    else
      if check_process "$server_pid"; then up=1; fi
    fi
    if [ $up -eq 1 ]; then
      echo "MyAgent started (PID: $server_pid)"
      echo "   URL: http://localhost:$APP_PORT"
      echo "   Restart: POST http://localhost:$APP_PORT/api/restart (or: $0 restart)"
      echo ""
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "MyAgent may have failed - last 20 lines of log:"
  tail -20 "$LOG_FILE" 2>/dev/null || true
  echo ""
  echo "   Full log: $LOG_FILE"
  exit 1
}

# ── Show status ────────────────────────────────────────────
show_status() {
  if check_server; then
    local pid
    pid="$(cat "$PID_FILE")"
    echo "MyAgent is running (PID: $pid)"
    echo "   URL: http://localhost:$APP_PORT"
    if command -v curl >/dev/null 2>&1; then
      echo ""
      echo "Status:"
      curl -s "http://127.0.0.1:$APP_PORT/api/status" 2>/dev/null | \
        node -e "
          const chunks = [];
          process.stdin.on('data', c => chunks.push(c));
          process.stdin.on('end', () => {
            try {
              const d = JSON.parse(Buffer.concat(chunks).toString());
              const u = d.uptime ? Math.floor(d.uptime / 60) + ' minutes' : 'n/a';
              const p = d.provider || (d.llm && d.llm.provider) || 'n/a';
              console.log('   Uptime:', u);
              console.log('   Provider:', p);
            } catch { console.log('   (Unable to get detailed status)'); }
          });
        " 2>/dev/null || true
    fi
  else
    echo "MyAgent is not running"
  fi
}

# ── View recent logs ───────────────────────────────────────
view_logs() {
  if [ -f "$LOG_FILE" ]; then
    echo "Recent logs (last 50 lines):"
    echo "   Log file: $LOG_FILE"
    echo "---------------------------------------------------"
    tail -50 "$LOG_FILE"
  else
    echo "No log file found at $LOG_FILE"
    echo "   Start MyAgent first: $0 start"
  fi
}

# ── Follow logs ────────────────────────────────────────────
follow_logs() {
  if [ -f "$LOG_FILE" ]; then
    echo "Following logs (Ctrl+C to stop)..."
    echo "   Log file: $LOG_FILE"
    echo ""
    tail -f "$LOG_FILE"
  else
    echo "No log file found at $LOG_FILE"
    echo "   Start MyAgent first: $0 start"
  fi
}

# ── Run in foreground (development mode) ─────────────────
run_foreground() {
  echo "Starting MyAgent in development mode..."
  echo "   Server logs will be displayed in this terminal"
  echo "   Press Ctrl+C to stop the server"
  echo ""

  mkdir -p "$SCRIPT_DIR/logs"

  if check_server; then
    echo "MyAgent is running in background. Stopping it first..."
    stop_server
    sleep 2
  fi

  echo "Starting server in foreground..."
  echo "   Log file: $LOG_FILE"
  echo "---------------------------------------------------"
  echo ""

  node "$SERVER_JS" 2>&1 | tee -a "$LOG_FILE"
}

# ── Parse command line arguments ────────────────────────────
case "${1:-start}" in
  start)
    start_server
    sleep 1
    show_status
    echo ""
    echo "To view logs: $0 logs"
    echo "   Or: tail -f $LOG_FILE"
    ;;
  stop)
    stop_server
    ;;
  restart)
    restart_server
    ;;
  status)
    show_status
    ;;
  logs)
    view_logs
    ;;
  log)
    follow_logs
    ;;
  dev|foreground)
    run_foreground
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs|log|dev}"
    echo ""
    echo "  start      - Start MyAgent (default, single process, self-monitoring)"
    echo "  stop       - Stop MyAgent"
    echo "  restart    - Restart MyAgent (graceful self re-exec)"
    echo "  status     - Show MyAgent status"
    echo "  logs       - View recent logs (last 50 lines)"
    echo "  log        - Follow logs in real-time (Ctrl+C to stop)"
    echo "  dev        - Run in foreground mode (see logs in terminal)"
    exit 1
    ;;
esac
