#!/usr/bin/env python3
"""Rewrite start_daemon() in start.sh with reliable wait logic."""
import re

with open(r"D:\DiskD\GitHub\myAgent\start.sh", "r", encoding="utf-8") as f:
    content = f.read()

# Replace the entire start_daemon() function
# From "start_daemon() {" to the next "}" at the same level
# Simpler: replace from "# ── Start daemon ─" to "# ── Show status ─"
old = """# ── Start daemon ───────────────────────────────────────────
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
        echo "✅ Daemon started (PID: $pid)"
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

  # If we get here, failed to start — show log tail
  echo "❌ Daemon may have failed — last 20 lines of log:"
  tail -20 "$SCRIPT_DIR/logs/daemon-stdout.log" 2>/dev/null || true
  echo ""
  echo "   Full log: $SCRIPT_DIR/logs/daemon-stdout.log"
  exit 1
}"""

new = """# ── Start daemon ───────────────────────────────────────────
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

  # Launch daemon via nohup (background)
  nohup node "$DAEMON_JS" > "$SCRIPT_DIR/logs/daemon-stdout.log" 2>&1 &
  local launcher_pid=$!

  # Wait fixed 4s for daemon to write PID file and start server
  sleep 4

  # Check if daemon is running
  if check_daemon; then
    local pid
    pid="$(cat "$SCRIPT_DIR/.agent-webui-daemon.pid" 2>/dev/null || echo '')"
    echo "✅ Daemon started (PID: $pid)"
    echo "   URL: http://localhost:3737"
    echo "   Control: http://localhost:$CONTROL_PORT"
    echo ""
    echo "   Press Ctrl+C to detach (daemon will keep running)"
    echo ""
    return 0
  fi

  # Failed to start — show log
  echo "❌ Daemon may have failed — last 20 lines of log:"
  tail -20 "$SCRIPT_DIR/logs/daemon-stdout.log" 2>/dev/null || true
  echo ""
  echo "   Full log: $SCRIPT_DIR/logs/daemon-stdout.log"
  exit 1
}"""

if old in content:
    content = content.replace(old, new, 1)
    with open(r"D:\DiskD\GitHub\myAgent\start.sh", "w", encoding="utf-8") as f:
        f.write(content)
    print("SUCCESS: start_daemon() updated")
else:
    print("ERROR: old string not found!")
    # Try to find the function
    idx = content.find("start_daemon() {")
    if idx >= 0:
        print(f"Found start_daemon at char {idx}")
        print("Context:")
        print(content[idx:idx+200])
    else:
        print("start_daemon() not found at all!")
