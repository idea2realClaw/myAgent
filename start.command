#!/bin/bash
# ============================================================
# MyAgent — macOS Double-Click Launcher (start.command)
# ------------------------------------------------------------
# Double-click this file in Finder to launch MyAgent:
#   • starts the backend server (single process, self-monitoring)
#   • opens http://localhost:3737 in your default browser
#   • keeps this Terminal window open showing status / recent logs
#   • closing this window does NOT stop the server (it is detached)
#     ── to stop: run  ./start.sh stop   or double-click again is harmless
# ============================================================

# ── Script location (works even when double-clicked from Finder) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1
BACKEND_DIR="$SCRIPT_DIR/backend"
SERVER_JS="$BACKEND_DIR/server.js"
APP_PORT=3737

# ── Node.js discovery (macOS / Linux common locations) ──
for __node_dir in \
  "/usr/local/bin" \
  "/opt/homebrew/bin" \
  "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin" \
  "$HOME/.volta/bin" \
  "/usr/bin"; do
  if [ -f "$__node_dir/node" ] && [ -x "$__node_dir/node" ]; then
    export PATH="$__node_dir:$PATH"
    break
  fi
done
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" 2>/dev/null || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is required but was not found. Install from https://nodejs.org"
  read -p "Press Enter to close this window..."
  exit 1
fi

# ── Python virtual environment (optional) ──
VENV_PYTHON="$SCRIPT_DIR/venv/bin/python3"
if [ -f "$VENV_PYTHON" ]; then
  export PATH="$SCRIPT_DIR/venv/bin:$PATH"
fi

# ── Proxy avoidance (don't route localhost through proxies) ──
export no_proxy="${no_proxy:+$no_proxy,}localhost,127.0.0.1"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1"

PID_FILE="$SCRIPT_DIR/.agent-webui.pid"
LOG_FILE="$SCRIPT_DIR/logs/agent-webui-server.log"

# ── Helpers ──
check_process() {
  local pid="$1"
  [ -z "$pid" ] && return 1
  kill -0 "$pid" 2>/dev/null
}

check_server() {
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || echo '')"
    if check_process "$pid"; then return 0; fi
  fi
  return 1
}

wait_for_ready() {
  local waited=0
  local use_curl=0
  command -v curl >/dev/null 2>&1 && use_curl=1
  while [ $waited -lt 25 ]; do
    if [ $use_curl -eq 1 ]; then
      curl -s -m 2 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 && return 0
    else
      check_server && return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

start_server() {
  if check_server; then
    echo "ℹ️  MyAgent is already running."
    return 0
  fi
  mkdir -p "$SCRIPT_DIR/logs" "$BACKEND_DIR/logs" "$SCRIPT_DIR/identity"

  if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    echo "📦 Installing dependencies (first run may take a moment)..."
    (cd "$BACKEND_DIR" && npm install) || true
  fi

  echo "🚀 Starting MyAgent..."
  if command -v setsid >/dev/null 2>&1; then
    setsid node "$SERVER_JS" > "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup node "$SERVER_JS" > "$LOG_FILE" 2>&1 < /dev/null &
  fi
  echo $! > "$PID_FILE"
}

# ── Banner ──
echo "=============================================="
echo "            MyAgent Launcher"
echo "=============================================="
echo "Node.js : $(command -v node)"
echo "Path    : $SCRIPT_DIR"
echo ""

# ── Launch ──
start_server

if wait_for_ready; then
  echo "✅ MyAgent is ready!"
  echo "   URL: http://localhost:$APP_PORT"
  # Open in default browser
  open "http://localhost:$APP_PORT" 2>/dev/null || \
    echo "   (Could not auto-open browser — please visit the URL above manually)"
else
  echo "⚠️  MyAgent did not respond in time. Recent logs:"
  tail -20 "$LOG_FILE" 2>/dev/null || true
fi

echo ""
echo "---------------------------------------------------"
echo "Recent logs (last 15 lines):"
echo "---------------------------------------------------"
tail -n 15 "$LOG_FILE" 2>/dev/null || echo "   (no log yet)"
echo ""
echo "💡 MyAgent runs in the background. Closing this window will NOT stop it."
echo "   To stop the server later:  ./start.sh stop"
echo "   Press Enter to close this window."

# Keep the Terminal window open until the user dismisses it.
read -p ""
