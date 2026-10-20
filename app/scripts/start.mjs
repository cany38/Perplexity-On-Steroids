// Detached launcher: spawns the MCP server, then opens the local panel.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const log = path.join(os.tmpdir(), 'pos-mcp.log');
const panelFile = path.join(os.tmpdir(), 'pos-panel.url');

try { fs.unlinkSync(panelFile); } catch { /* no stale panel */ }

const out = fs.openSync(log, 'a');
const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'mcp-http.mjs')], {
  cwd: ROOT, detached: true, stdio: ['ignore', out, out],
  env: { ...process.env, POS_NO_OPEN: '1' },
});
child.unref();
console.log('started pid ' + child.pid + ' log ' + log);

function openBrowser(url) {
  if (process.env.POS_NO_OPEN) return;
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const opener = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    opener.unref();
  } catch { /* the URL is printed below */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let panelUrl = '';
for (let i = 0; i < 50 && !panelUrl; i++) {
  try { panelUrl = fs.readFileSync(panelFile, 'utf8').trim(); } catch { await sleep(200); }
}

if (panelUrl) {
  console.log('panel ' + panelUrl);
  openBrowser(panelUrl);
} else {
  console.log('panel did not start yet; open the URL printed in ' + log);
}
