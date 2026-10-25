#!/bin/bash
# Starts the server in the background and opens the panel.
cd "$(dirname "$0")/../app" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run setup.command first."
  read -r -p "Press Enter to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing packages..."
  npm install --no-audit --no-fund || { echo "The package install failed. Run setup.command."; read -r -p "Press Enter to close."; exit 1; }
fi

if lsof -nP -iTCP:8857 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "The server is already running."
  panel="${TMPDIR:-/tmp}/pos-panel.url"
  [ -f "$panel" ] && open "$(cat "$panel")"
  exit 0
fi

node scripts/start.mjs || { echo "The server did not start. See ${TMPDIR:-/tmp}/pos-mcp.log"; read -r -p "Press Enter to close."; exit 1; }
echo
echo "The server runs in the background. Run stop.command to stop it."
