// POS MCP handshake smoke: starts its own server on spare ports with a temp data
// folder, then runs initialize and tools/list on the secret path.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-smoke-'));
const cfgPath = path.join(dir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ maxOutputBytes: 200_000, execTimeoutMs: 120_000, tunnel: 'none', publicUrl: '' }));
const PORT = 18857;
const PANEL = 18859;

// The temp folder moves too, so the panel URL file of a running copy stays as it is.
const server = spawn(process.execPath, [path.join(HERE, '..', 'bridge', 'mcp-http.mjs')], {
  env: { ...process.env, POS_CONFIG: cfgPath, POS_DATA: dir, POS_PORT: String(PORT), POS_PANEL_PORT: String(PANEL), POS_NO_OPEN: '1', POS_TOKEN: '', TEMP: dir, TMP: dir, TMPDIR: dir },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let secret = '';
for (let i = 0; i < 50 && !secret; i++) {
  try { secret = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).secret; } catch { await sleep(100); }
}
const base = `http://127.0.0.1:${PORT}`;
const URL = `${base}/mcp/${secret}`;
const H = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

async function rpc(method, params, id, url = URL, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const txt = await r.text();
  // Streamable HTTP replies may be SSE: lines shaped like 'data: {...}'
  const lines = txt.split(/\r?\n/).filter((l) => l.startsWith('data: '));
  const payload = lines.length ? lines[lines.length - 1].slice(6) : txt;
  const cors = r.headers.get('access-control-allow-origin');
  try { return { status: r.status, cors, ...JSON.parse(payload) }; } catch { return { status: r.status, cors, raw: txt.slice(0, 300) }; }
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base); break; } catch { await sleep(100); }
  }
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }, 1);
  ok('initialize returned a result', !!init.result, JSON.stringify(init).slice(0, 200));
  ok('server name is perplexity-on-steroids', init.result?.serverInfo?.name === 'perplexity-on-steroids', JSON.stringify(init.result?.serverInfo));

  const list = await rpc('tools/list', {}, 2);
  const names = (list.result?.tools || []).map((t) => t.name);
  ok('14 tools listed', names.length === 14, 'found ' + names.length);
  ok('every tool is pos_ prefixed', names.every((n) => n.startsWith('pos_')));

  const bare = await rpc('tools/list', {}, 3, `${base}/mcp`);
  ok('bare /mcp is refused', bare.status === 404, String(bare.status));
  const wrong = await rpc('tools/list', {}, 4, `${base}/mcp/${'0'.repeat(64)}`);
  ok('a wrong secret is refused', wrong.status === 404, String(wrong.status));
  const fromSite = await rpc('tools/list', {}, 5, URL, { Origin: 'https://example.com' });
  ok('no CORS header for other sites', !fromSite.cors, String(fromSite.cors));
  const pre = await fetch(URL, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' } });
  ok('CORS preflight is not answered', pre.status === 405 && !pre.headers.get('access-control-allow-origin'), String(pre.status));
} finally {
  server.kill();
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
