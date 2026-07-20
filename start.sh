#!/usr/bin/env bash
# ============================================================
# Agent WebUI â Start Script (Cross-platform: Windows / macOS / Linux)
# ============================================================

# ââ OS Detection âââââââââââââââââââââââââââââââââââââââââââââ
__OS_TYPE="$(uname -s 2>/dev/null || echo 'Unknown')"
case "$__OS_TYPE" in
  Darwin*) __OS="mac" ;;
  Linux*)  __OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) __OS="windows" ;;
  *)       __OS="unknown" ;;
esac
export __OS

# ââ Node.js Discovery âââââââââââââââââââââââââââââââââââââââ
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
  echo "â Node.js is required. Install from https://nodejs.org"
  exit 1
fi

# ââ Path helper âââââââââââââââââââââââââââââââââââââââââââââ
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
  DAEMON_JS="$BACKEND_DIR/daemon.js"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BACKEND_DIR="$SCRIPT_DIR/backend"
  DAEMON_JS="$BACKEND_DIR/daemon.js"
fi
CONTROL_PORT=13737

# ââ Proxy avoidance âââââââââââââââââââââââââââââââââââââââââ
export no_proxy="${no_proxy:+$no_proxy,}localhost,127.0.0.1"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1"

set -e
echo "â Node.js found: $(command -v node)"
echo "â OS detected: $__OS"
echo ""

# ââ Python Virtual Environment Setup âââââââââââââââââââââââââ
if [ "$__OS" = "mac" ] || [ "$__OS" = "linux" ]; then
  VENV_PYTHON="$SCRIPT_DIR/venv/bin/python3"
  if [ -f "$VENV_PYTHON" ]; then
    PY_VER="$("$VENV_PYTHON" --version 2>&1)"
    echo "â Python venv: $PY_VER"
    export PATH="$SCRIPT_DIR/venv/bin:$PATH"
  else
    echo "â¹ï¸   No Python venv found. Run ./setup-mac.sh to create one."
  fi
elif [ "$__OS" = "windows" ]; then
  # ARM64 Windows: use bundled python-arm64
  for py_dir in \
    "$SCRIPT_DIR/python-arm64" \
    "$SCRIPT_DIR/venv/Scripts"; do
    if [ -f "$py_dir/python.exe" ]; then
      PY_VER="$("$py_dir/python.exe" --version 2>&1)"
      echo "â Python: $PY_VER ($py_dir)"
      export PATH="$py_dir:$PATH"
      break
    fi
  done
fi
echo ""

echo "âââââââââââââââââââââââââââââââââââââââââââââââ"
echo "â          Agent WebUI Launcher                 â"
echo "âââââââââââââââââââââââââââââââââââââââââââââââ"
echo ""

# ââ Install deps if needed ââââââââââââââââââââââââââââââââ
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "ð¦ Installing dependencies..."
  cd "$BACKEND_DIR" && npm install
  cd "$SCRIPT_DIR"
fi

# ââ Cross-platform process check âââââââââââââââââââââââââââ
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

# ââ Cross-platform kill ââââââââââââââââââââââââââââââââââââ
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
    echo "   â ï¸  Process $pid may still be running"
  fi
  return 0
}

# ââ Check if daemon is running ââââââââââââââââââââââââââââ
check_daemon() {
  if [ -f "$SCRIPT_DIR/.agent-webui-daemon.pid" ]; then
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid" 2>/dev/null || echo '')"
    if check_process "$pid"; then
      return 0
    fi
  fi
  return 1
}

# ââ Stop daemon ââââââââââââââââââââââââââââââââââââââââââââ
stop_daemon() {
  if check_daemon; then
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")"
    echo "ð  Stopping daemon (PID: $pid)..."
    kill_process "$pid"
    rm -f "$SCRIPT_DIR/.agent-webui-daemon.pid"
    echo "â Daemon stopped"
  else
    echo "â¹ï¸   Daemon is not running"
  fi
}

# ââ Restart daemon âââââââââââââââââââââââââââââââââââââââââ
restart_daemon() {
  if check_daemon; then
    echo "ð Restarting daemon..."
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")"
    kill -USR1 "$pid" 2>/dev/null || true
    echo "â Restart signal sent"
  else
    echo "â ï¸  Daemon is not running, starting..."
    start_daemon
  fi
}

# ââ Start daemon âââââââââââââââââââââââââââââââââââââââââââ
start_daemon() {
  if check_daemon; then
    echo "â ï¸  Daemon is already running"
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")"
    echo "   PID: $pid"
    echo "   URL: http://localhost:3737"
    return 0
  fi

  mkdir -p "$SCRIPT_DIR/identity"
  mkdir -p "$SCRIPT_DIR/logs"
  mkdir -p "$SCRIPT_DIR/backend/logs"

  echo "ð Starting Agent WebUI Daemon..."
  echo "   Identity files: $SCRIPT_DIR/identity/"
  echo "   Skills: Add to .claude/skills/ or ~/.claude/skills/"
  echo "   Logs: $SCRIPT_DIR/logs/"
  echo ""

  # Cross-platform nohup
  if [ "$__OS" = "mac" ] || [ "$__OS" = "linux" ]; then
    nohup node "$DAEMON_JS" > "$SCRIPT_DIR/logs/daemon-stdout.log" 2>&1 &
  else
    # Windows: use nohup (Git Bash) or start
    nohup node "$DAEMON_JS" > "$SCRIPT_DIR/logs/daemon-stdout.log" 2>&1 &
  fi

  local daemon_pid=$!
  echo "   Launched (launcher PID: $daemon_pid), waiting for daemon to be ready..."

  # Wait for PID file (retry every 1s, up to 10s)
  local waited=0
  while [ $waited -lt 10 ]; do
    if [ -f "$SCRIPT_DIR/.agent-webui-daemon.pid" ]; then
      local pid
      pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid" 2>/dev/null || echo '')"
      if check_process "$pid"; then
        echo "â Daemon started (PID: $pid)"
        echo "   URL: http://localhost:3737"
        echo "   Control: http://localhost:$CONTROL_PORT"
        echo ""
        echo "   Press Ctrl+C to detach (daemon will keep running)"
        echo ""
        return 0
      fi
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # If we get here, failed to start - show log tail
  echo "â Daemon may have failed â last 20 lines of log:"
  tail -20 "$SCRIPT_DIR/logs/daemon-stdout.log" 2>/dev/null || true
  echo ""
  echo "   Full log: $SCRIPT_DIR/logs/daemon-stdout.log"
  exit 1
}

# ââ Show status ââââââââââââââââââââââââââââââââââââââââââââ
show_status() {
  if check_daemon; then
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")"
    echo "â Daemon is running (PID: $pid)"

    if command -v curl >/dev/null 2>&1; then
      echo ""
      echo "ð Status:"
      curl -s "http://127.0.0.1:$CONTROL_PORT/status" 2>/dev/null | \
        node -e "
          const chunks = [];
          process.stdin.on('data', c => chunks.push(c));
          process.stdin.on('end', () => {
            try {
              const d = JSON.parse(Buffer.concat(chunks).toString());
              console.log('   Daemon PID:', d.daemon.pid);
              console.log('   Daemon Uptime:', Math.floor(d.daemon.uptime / 60), 'minutes');
              console.log('   Server:', d.server.running ? 'Running (PID: ' + d.server.pid + ')' : 'Stopped');
            } catch {
              console.log('   (Unable to get detailed status)');
            }
          });
        " 2>/dev/null || true
    fi
  else
    echo "â Daemon is not running"
  fi
}

# ââ View recent logs âââââââââââââââââââââââââââââââââââââââ
view_logs() {
  local log_file="$SCRIPT_DIR/logs/agent-webui-daemon.log"
  if [ -f "$log_file" ]; then
    echo "ð Recent logs (last 50 lines):"
    echo "   Log file: $log_file"
    echo "âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ"
    tail -50 "$log_file"
  else
    echo "â¹ï¸   No log file found at $log_file"
    echo "   Start the daemon first: $0 start"
  fi
}

# ââ Follow logs ââââââââââââââââââââââââââââââââââââââââââââ
follow_logs() {
  local log_file="$SCRIPT_DIR/logs/agent-webui-daemon.log"
  if [ -f "$log_file" ]; then
    echo "ð Following logs (Ctrl+C to stop)..."
    echo "   Log file: $log_file"
    echo ""
    tail -f "$log_file"
  else
    echo "â¹ï¸   No log file found at $log_file"
    echo "   Start the daemon first: $0 start"
  fi
}

# ââ Run in foreground (development mode) âââââââââââââââââ
run_foreground() {
  echo "ð Starting MyAgent in development mode..."
  echo "   Server logs will be displayed in this terminal"
  echo "   Press Ctrl+C to stop the server"
  echo ""

  mkdir -p "$SCRIPT_DIR/logs"

  if check_daemon; then
    echo "â ï¸  Daemon is running. Stopping it first..."
    stop_daemon
    sleep 2
  fi

  echo "ð Starting server in foreground..."
  echo "   Log file: $SCRIPT_DIR/logs/agent-webui-server.log"
  echo "âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ"
  echo ""

  node "$SCRIPT_DIR/backend/server.js" 2>&1 | tee -a "$SCRIPT_DIR/logs/agent-webui-server.log"
}

# ââ Parse command line arguments ââââââââââââââââââââââââââââ
case "${1:-start}" in
  start)
    start_daemon
    sleep 1
    show_status
    echo ""
    echo "ð To view logs: $0 logs"
    echo "   Or: tail -f $SCRIPT_DIR/logs/agent-webui-daemon.log"
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    restart_daemon
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
    echo "  start      - Start the daemon (default, runs in background)"
    echo "  stop       - Stop the daemon"
    echo "  restart    - Restart the daemon (graceful)"
    echo "  status     - Show daemon status"
    echo "  logs       - View recent logs (last 50 lines)"
    echo "  log        - Follow logs in real-time (Ctrl+C to stop)"
    echo "  dev        - Run in foreground mode (see logs in terminal)"
    exit 1
    ;;
esac
