// POS MCP handshake smoke: initialize + tools/list
const URL = 'http://127.0.0.1:8857/mcp';
const H = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

async function rpc(method, params, id) {
  const r = await fetch(URL, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const txt = await r.text();
  // Streamable HTTP replies may be SSE: lines shaped like 'data: {...}'
  const lines = txt.split(/\r?\n/).filter((l) => l.startsWith('data: '));
  const payload = lines.length ? lines[lines.length - 1].slice(6) : txt;
  try { return JSON.parse(payload); } catch { return { raw: txt.slice(0, 300) }; }
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }, 1);
ok('initialize returned a result', !!init.result, JSON.stringify(init).slice(0, 200));
ok('server name is perplexity-on-steroids', init.result?.serverInfo?.name === 'perplexity-on-steroids', JSON.stringify(init.result?.serverInfo));

const list = await rpc('tools/list', {}, 2);
const names = (list.result?.tools || []).map((t) => t.name);
ok('14 tools listed', names.length === 14, 'found ' + names.length);
ok('every tool is pos_ prefixed', names.every((n) => n.startsWith('pos_')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
