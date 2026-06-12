#!/usr/bin/env bash
# ============================================================
# Agent WebUI — Start Script
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║          Agent WebUI Launcher             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Check node
if ! command -v node &> /dev/null; then
  echo "❌ Node.js is required. Install from https://nodejs.org"
  exit 1
fi

# Install deps if needed
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "📦 Installing dependencies..."
  cd "$BACKEND_DIR" && npm install
  cd "$SCRIPT_DIR"
fi

# Start server
echo "🚀 Starting Agent WebUI on http://localhost:3737"
echo "   Identity files: $SCRIPT_DIR/identity/"
echo "   Skills: Add to .claude/skills/ or ~/.claude/skills/"
echo ""
echo "   Press Ctrl+C to stop"
echo ""

cd "$BACKEND_DIR" && node server.js
