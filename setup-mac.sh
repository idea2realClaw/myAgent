#!/usr/bin/env bash
# ============================================================
# Agent WebUI — macOS Setup Script
# Creates a Python venv for macOS (Apple Silicon ARM64)
# ============================================================
set -e

# ── Colors ──────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}✅${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠️${NC} $1"; }
err()   { echo -e "${RED}❌${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${1:-$SCRIPT_DIR/venv}"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        Agent WebUI — macOS Python Environment Setup     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── OS & Arch Check ─────────────────────────────────────────
OS_TYPE="$(uname -s)"
ARCH="$(uname -m)"

if [ "$OS_TYPE" != "Darwin" ]; then
  err "This script is for macOS only (detected: $OS_TYPE)"
  exit 1
fi

info "macOS detected | Arch: $ARCH"
if [ "$ARCH" = "arm64" ]; then
  info "Apple Silicon (ARM64) — running native Python"
else
  warn "Intel (x86_64) — running under Rosetta 2 or native"
fi

# ── Find Python 3.13 ────────────────────────────────────────
PYTHON=""

# Priority 1: Look for Python 3.13 explicitly
for py in \
  "/opt/homebrew/bin/python3.13" \
  "/usr/local/bin/python3.13" \
  "$HOME/.pyenv/shims/python3.13"; do
  if [ -f "$py" ] && [ -x "$py" ]; then
    PYTHON="$py"
    break
  fi
done

# Priority 2: Fall back to any Python 3
if [ -z "$PYTHON" ]; then
  for py in \
    "/opt/homebrew/bin/python3" \
    "/usr/local/bin/python3" \
    "/usr/bin/python3" \
    "$HOME/.pyenv/shims/python3"; do
    if [ -f "$py" ] && [ -x "$py" ]; then
      PY_VERSION="$($py --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')"
      PY_MAJOR="${PY_VERSION%.*}"; PY_MINOR="${PY_VERSION#*.}"
      if [ "$PY_MAJOR" = "3" ] && [ "$PY_MINOR" -ge "10" ]; then
        PYTHON="$py"
        break
      fi
    fi
  done
fi

# Priority 3: Try to install via Homebrew
if [ -z "$PYTHON" ] && command -v brew >/dev/null 2>&1; then
  warn "Python 3.13 not found. Installing via Homebrew..."
  brew install python@3.13
  PYTHON="/opt/homebrew/bin/python3.13"
fi

if [ -z "$PYTHON" ] || [ ! -f "$PYTHON" ]; then
  err "Python 3.13+ not found!"
  echo ""
  echo "  Install manually:"
  echo "    brew install python@3.13"
  echo "    # or: https://www.python.org/downloads/"
  echo ""
  exit 1
fi

PY_FULL_VER="$($PYTHON --version 2>&1)"
info "Found: $PY_FULL_VER ($PYTHON)"

# ── Create Virtual Environment ──────────────────────────────
echo ""
info "Creating virtual environment at: $VENV_DIR"
echo ""

if [ -d "$VENV_DIR" ]; then
  if [ -f "$VENV_DIR/bin/python3" ]; then
    EXISTING_VER="$($VENV_DIR/bin/python3 --version 2>&1)"
    info "Virtual environment already exists: $EXISTING_VER"
    echo ""
    info "To recreate: rm -rf \"$VENV_DIR\" && ./setup-mac.sh"
    echo ""
  else
    warn "Directory exists but is not a valid venv. Recreating..."
    rm -rf "$VENV_DIR"
    "$PYTHON" -m venv "$VENV_DIR"
  fi
else
  "$PYTHON" -m venv "$VENV_DIR"
fi

if [ ! -f "$VENV_DIR/bin/python3" ]; then
  err "Failed to create virtual environment!"
  exit 1
fi

info "Virtual environment created: $($VENV_DIR/bin/python3 --version 2>&1)"

# ── Upgrade pip ─────────────────────────────────────────────
echo ""
info "Upgrading pip..."
"$VENV_DIR/bin/python3" -m pip install --upgrade pip --quiet

# ── Activate instruction ────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                    Setup Complete!                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
info "Python: $($VENV_DIR/bin/python3 --version 2>&1)"
info "pip:    $($VENV_DIR/bin/pip --version 2>&1 | grep -oE 'pip [0-9.]+')"
echo ""
echo "  To activate:"
echo "    source $VENV_DIR/bin/activate"
echo ""
echo "  Or run MyAgent (daemon auto-finds venv):"
echo "    ./start.sh start"
echo ""
echo "  To install packages (if needed):"
echo "    $VENV_DIR/bin/pip install <package>"
echo ""
