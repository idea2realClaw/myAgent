#!/usr/bin/env bash
# ============================================================
# Agent WebUI — Start Script (Cross-platform: Windows / macOS / Linux)
# ============================================================

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
  echo "❌ Node.js is required. Install from https://nodejs.org"
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
  DAEMON_JS="$BACKEND_DIR/daemon.js"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BACKEND_DIR="$SCRIPT_DIR/backend"
  DAEMON_JS="$BACKEND_DIR/daemon.js"
fi
CONTROL_PORT=13737

# ── Proxy avoidance ─────────────────────────────────────────
export no_proxy="${no_proxy:+$no_proxy,}localhost,127.0.0.1"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1"

set -e
echo "✅ Node.js found: $(command -v node)"
echo "✅ OS detected: $__OS"
echo ""

# ── Python Virtual Environment Setup ─────────────────────────
if [ "$__OS" = "mac" ] || [ "$__OS" = "linux" ]; then
  VENV_PYTHON="$SCRIPT_DIR/venv/bin/python3"
  if [ -f "$VENV_PYTHON" ]; then
    PY_VER="$("$VENV_PYTHON" --version 2>&1)"
    echo "✅ Python venv: $PY_VER"
    export PATH="$SCRIPT_DIR/venv/bin:$PATH"
  else
    echo "ℹ️   No Python venv found. Run ./setup-mac.sh to create one."
  fi
elif [ "$__OS" = "windows" ]; then
  # ARM64 Windows: use bundled python-arm64
  for py_dir in \
    "$SCRIPT_DIR/python-arm64" \
    "$SCRIPT_DIR/venv/Scripts"; do
    if [ -f "$py_dir/python.exe" ]; then
      PY_VER="$("$py_dir/python.exe" --version 2>&1)"
      echo "✅ Python: $PY_VER ($py_dir)"
      export PATH="$py_dir:$PATH"
      break
    fi
  done
fi
echo ""

echo "╔═════════════════════════════════════════════╗"
echo "║          Agent WebUI Launcher                 ║"
echo "╚═════════════════════════════════════════════╝"
echo ""

# ── Install deps if needed ────────────────────────────────
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "📦 Installing dependencies..."
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
    echo "   ⚠️  Process $pid may still be running"
  fi
  return 0
}

# ── Check if daemon is running ────────────────────────────
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

# ── Stop daemon ────────────────────────────────────────────
stop_daemon() {
  if check_daemon; then
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")"
    echo "🛑  Stopping daemon (PID: $pid)..."
    kill_process "$pid"
    rm -f "$SCRIPT_DIR/.agent-webui-daemon.pid"
    echo "✅ Daemon stopped"
  else
    echo "ℹ️   Daemon is not running"
  fi
}

# ── Restart daemon ─────────────────────────────────────────
restart_daemon() {
  if check_daemon; then
    echo "🔄 Restarting daemon..."
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")"
    kill -USR1 "$pid" 2>/dev/null || true
    echo "✅ Restart signal sent"
  else
    echo "⚠️  Daemon is not running, starting..."
    start_daemon
  fi
}

# ── Start daemon ───────────────────────────────────────────
start_daemon() {
  if check_daemon; then
    echo "⚠️  Daemon is already running"
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")"
    echo "   PID: $pid"
    echo "   URL: http://localhost:3737"
    return 0
  fi

  mkdir -p "$SCRIPT_DIR/identity"
  mkdir -p "$SCRIPT_DIR/logs"
  mkdir -p "$SCRIPT_DIR/backend/logs"

  echo "🚀 Starting Agent WebUI Daemon..."
  echo "   Identity files: $SCRIPT_DIR/identity/"
  echo "   Skills: Add to .claude/skills/ or ~/.claude/skills/"
  echo "   Logs: $SCRIPT_DIR/logs/"
  echo ""

  # 跨平台「彻底脱离启动窗口」地拉起 daemon：
  # - < /dev/null 让 daemon 不占用启动终端的 stdin，避免随启动窗口关闭被杀
  # - Linux/mac 用 setsid 创建独立会话；Windows Git Bash 用 nohup（同样重定向 stdin）
  if [ "$__OS" = "windows" ]; then
    nohup node "$DAEMON_JS" > "$SCRIPT_DIR/logs/daemon-stdout.log" 2>&1 < /dev/null &
  else
    if command -v setsid >/dev/null 2>&1; then
      setsid node "$DAEMON_JS" > "$SCRIPT_DIR/logs/daemon-stdout.log" 2>&1 < /dev/null &
    else
      nohup node "$DAEMON_JS" > "$SCRIPT_DIR/logs/daemon-stdout.log" 2>&1 < /dev/null &
    fi
  fi

  local daemon_pid=$!
  echo "   Launched (launcher PID: $daemon_pid), waiting for daemon to be ready..."

  # 成功判定：优先探测 daemon 控制端口的 /health（权威信号，200 即代表 daemon+server 都已就绪），
  # 避免依赖 tasklist/grep 在 Windows Git Bash 子进程下偶发的误判导致「假失败」。
  local waited=0
  local use_curl=0
  command -v curl >/dev/null 2>&1 && use_curl=1
  while [ $waited -lt 20 ]; do
    local up=0
    if [ $use_curl -eq 1 ]; then
      if curl -s -m 2 "http://127.0.0.1:$CONTROL_PORT/health" >/dev/null 2>&1; then
        up=1
      fi
    else
      # 回退：pid 文件存在且进程存活
      if [ -f "$SCRIPT_DIR/.agent-webui-daemon.pid" ]; then
        local pid
        pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid" 2>/dev/null || echo '')"
        if check_process "$pid"; then up=1; fi
      fi
    fi
    if [ $up -eq 1 ]; then
      local pid="unknown"
      [ -f "$SCRIPT_DIR/.agent-webui-daemon.pid" ] && pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid" 2>/dev/null || echo unknown)"
      echo "✅ Daemon started (PID: $pid)"
      echo "   URL: http://localhost:3737"
      echo "   Control: http://localhost:$CONTROL_PORT"
      echo ""
      echo "   Press Ctrl+C to detach (daemon will keep running)"
      echo ""
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # If we get here, failed to start - show log tail
  echo "❌ Daemon may have failed — last 20 lines of log:"
  tail -20 "$SCRIPT_DIR/logs/daemon-stdout.log" 2>/dev/null || true
  echo ""
  echo "   Full log: $SCRIPT_DIR/logs/daemon-stdout.log"
  exit 1
}

# ── Show status ────────────────────────────────────────────
show_status() {
  if check_daemon; then
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")"
    echo "✅ Daemon is running (PID: $pid)"

    if command -v curl >/dev/null 2>&1; then
      echo ""
      echo "📊 Status:"
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
    echo "❌ Daemon is not running"
  fi
}

# ── View recent logs ───────────────────────────────────────
view_logs() {
  local log_file="$SCRIPT_DIR/logs/agent-webui-daemon.log"
  if [ -f "$log_file" ]; then
    echo "📋 Recent logs (last 50 lines):"
    echo "   Log file: $log_file"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    tail -50 "$log_file"
  else
    echo "ℹ️   No log file found at $log_file"
    echo "   Start the daemon first: $0 start"
  fi
}

# ── Follow logs ────────────────────────────────────────────
follow_logs() {
  local log_file="$SCRIPT_DIR/logs/agent-webui-daemon.log"
  if [ -f "$log_file" ]; then
    echo "📋 Following logs (Ctrl+C to stop)..."
    echo "   Log file: $log_file"
    echo ""
    tail -f "$log_file"
  else
    echo "ℹ️   No log file found at $log_file"
    echo "   Start the daemon first: $0 start"
  fi
}

# ── Run in foreground (development mode) ─────────────────
run_foreground() {
  echo "🚀 Starting MyAgent in development mode..."
  echo "   Server logs will be displayed in this terminal"
  echo "   Press Ctrl+C to stop the server"
  echo ""

  mkdir -p "$SCRIPT_DIR/logs"

  if check_daemon; then
    echo "⚠️  Daemon is running. Stopping it first..."
    stop_daemon
    sleep 2
  fi

  echo "📋 Starting server in foreground..."
  echo "   Log file: $SCRIPT_DIR/logs/agent-webui-server.log"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  node "$SCRIPT_DIR/backend/server.js" 2>&1 | tee -a "$SCRIPT_DIR/logs/agent-webui-server.log"
}

# ── Parse command line arguments ────────────────────────────
case "${1:-start}" in
  start)
    start_daemon
    sleep 1
    show_status
    echo ""
    echo "📋 To view logs: $0 logs"
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
