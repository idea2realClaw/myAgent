#!/usr/bin/env bash
# ============================================================
# Agent WebUI — Start Script (uses daemon for graceful restart)
# ============================================================

# Ensure Node.js is findable on Windows/Git Bash
# This runs BEFORE set -e so missing node doesn't kill the script
for __node_dir in \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2" \
  "$HOME/.workbuddy/binaries/node/versions/24.14.0" \
  "/c/Program Files/nodejs" \
  "$HOME/AppData/Local/Programs/nodejs"; do
  if [ -f "$__node_dir/node" ] || [ -f "$__node_dir/node.exe" ]; then
    export PATH="$__node_dir:$PATH"
    break
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is required. Install from https://nodejs.org"
  exit 1
fi

set -e
echo "✅ Node.js found: $(command -v node)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
DAEMON_JS="$BACKEND_DIR/daemon.js"
CONTROL_PORT=13737

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║          Agent WebUI Launcher             ║"
echo "╚══════════════════════════════════════════╝"
echo ""


# Install deps if needed
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "📦 Installing dependencies..."
  cd "$BACKEND_DIR" && npm install
  cd "$SCRIPT_DIR"
fi

# Function to check if daemon is running
check_daemon() {
  if [ -f "$SCRIPT_DIR/.agent-webui-daemon.pid" ]; then
    local pid=$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

# Function to stop daemon
stop_daemon() {
  if check_daemon; then
    local pid=$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")
    echo "🛑 Stopping daemon (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 2
    # Force kill if still running
    if kill -0 "$pid" 2>/dev/null; then
      echo "⚠️  Force killing daemon..."
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "✅ Daemon stopped"
  else
    echo "ℹ️  Daemon is not running"
  fi
}

# Function to restart daemon
restart_daemon() {
  if check_daemon; then
    echo "🔄 Restarting daemon..."
    local pid=$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")
    kill -USR1 "$pid" 2>/dev/null || true
    echo "✅ Restart signal sent"
  else
    echo "⚠️  Daemon is not running, starting..."
    start_daemon
  fi
}

# Function to start daemon
start_daemon() {
  if check_daemon; then
    echo "⚠️  Daemon is already running"
    local pid=$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")
    echo "   PID: $pid"
    echo "   URL: http://localhost:3737"
    return
  fi

  # Create required directories
  mkdir -p "$SCRIPT_DIR/identity"
  mkdir -p "$SCRIPT_DIR/logs"
  mkdir -p "$SCRIPT_DIR/backend/logs"

  echo "🚀 Starting Agent WebUI Daemon..."
  echo "   Identity files: $SCRIPT_DIR/identity/"
  echo "   Skills: Add to .claude/skills/ or ~/.claude/skills/"
  echo "   Logs: $SCRIPT_DIR/logs/"
  echo ""

  # Start daemon in background
  nohup node "$DAEMON_JS" > "$SCRIPT_DIR/logs/daemon-stdout.log" 2>&1 &
  
  # Wait for daemon to start
  sleep 2
  
  if check_daemon; then
    local pid=$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")
    echo "✅ Daemon started (PID: $pid)"
    echo "   URL: http://localhost:3737"
    echo "   Control: http://localhost:$CONTROL_PORT"
    echo ""
    echo "   Press Ctrl+C to detach (daemon will keep running)"
    echo ""
  else
    echo "❌ Failed to start daemon"
    exit 1
  fi
}

# Function to show status
show_status() {
  if check_daemon; then
    local pid=$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid")
    echo "✅ Daemon is running (PID: $pid)"
    
    # Try to get detailed status
    if command -v curl &> /dev/null; then
      echo ""
      echo "📊 Status:"
      curl -s http://127.0.0.1:$CONTROL_PORT/status 2>/dev/null | node -e "
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

# Function to view logs
view_logs() {
  local log_file="$SCRIPT_DIR/logs/agent-webui-daemon.log"
  if [ -f "$log_file" ]; then
    echo "📋 Recent logs (last 50 lines):"
    echo ""
    tail -50 "$log_file"
  else
    echo "ℹ️  No log file found at $log_file"
  fi
}

# Parse command line arguments
case "${1:-start}" in
  start)
    start_daemon
    # Keep script running to show logs (Ctrl+C to detach)
    echo "📋 Showing daemon logs (Ctrl+C to detach)..."
    echo ""
    tail -f "$SCRIPT_DIR/logs/agent-webui-daemon.log" 2>/dev/null || echo "Press Ctrl+C to exit"
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
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    echo ""
    echo "  start   - Start the daemon (default)"
    echo "  stop    - Stop the daemon"
    echo "  restart - Restart the daemon (graceful)"
    echo "  status  - Show daemon status"
    echo "  logs    - View recent logs"
    exit 1
    ;;
esac
