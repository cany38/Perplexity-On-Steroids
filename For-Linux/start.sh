#!/bin/bash
# Starts the server in the background and opens the panel.
cd "$(dirname "$0")/../app" || exit 1
port_pids() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  elif command -v fuser >/dev/null 2>&1; then fuser "$1/tcp" 2>/dev/null
  fi
}
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run setup.sh first."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing packages..."
  npm install --no-audit --no-fund || { echo "The package install failed. Run setup.sh."; exit 1; }
fi

if [ -n "$(port_pids 8857)" ]; then
  echo "The server is already running."
  panel="${TMPDIR:-/tmp}/pos-panel.url"
  [ -f "$panel" ] && command -v xdg-open >/dev/null 2>&1 && xdg-open "$(cat "$panel")" >/dev/null 2>&1
  exit 0
fi

node scripts/start.mjs || { echo "The server did not start. See ${TMPDIR:-/tmp}/pos-mcp.log"; exit 1; }
echo
echo "The server runs in the background. Run stop.sh to stop it."
