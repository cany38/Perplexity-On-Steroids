import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../bridge/runtime.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-runtime-'));
const cfgPath = path.join(dir, 'config.json');
// Settings an older version wrote; the runtime drops them on load.
fs.writeFileSync(cfgPath, JSON.stringify({
  roots: [dir],
  readOnly: true,
  allowExec: false,
  autoApprove: { write: false, exec: false, destroy: false },
  approvalTimeoutMs: 500,
  maxOutputBytes: 200_000,
  execTimeoutMs: 120_000,
}, null, 2));

const rt = createRuntime({ configPath: cfgPath, mcpPort: 8857, panelPort: 8859, token: null, tunnel: false, dataDir: dir });
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' ' + extra); }
};

const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
ok('old folder and permission settings are dropped', ['roots', 'readOnly', 'allowExec', 'autoApprove', 'approvalTimeoutMs'].every((k) => !(k in disk)), JSON.stringify(disk));
ok('config reports the home folder', rt.config().home === os.homedir());
ok('panel key is 64 hex characters', /^[0-9a-f]{64}$/.test(rt.panelKey));
ok('persists a connector secret', /^[0-9a-f]{64}$/.test(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).secret));

const ping = await rt.dispatch('pos_ping', {});
ok('pos_ping runs through the runtime', ping.ok === true && ping.bridge === 'perplexity-on-steroids');

const snap = await rt.snapshot();
ok('snapshot carries one activity row', snap.activity.length === 1, JSON.stringify(snap.activity));
ok('ping is recorded as a read', snap.activity[0].tool === 'ping' && snap.activity[0].kind === 'read');
ok('snapshot exposes 14 tools', snap.tools.length === 14, String(snap.tools.length));
ok('snapshot has no pending list', !('pending' in snap));

fs.writeFileSync(path.join(dir, 'exists.txt'), 'x');
const written = await rt.dispatch('pos_write_file', { path: path.join(dir, 'exists.txt'), content: 'y' });
ok('an overwrite runs right away', written.ok === true && fs.readFileSync(path.join(dir, 'exists.txt'), 'utf8') === 'y');
const row = (await rt.snapshot()).activity.at(-1);
ok('the write is recorded', row.tool === 'write_file' && row.kind === 'write' && row.status === 'ok' && !('decision' in row));

const outside = path.join(path.dirname(dir), `pos-outside-${process.pid}.txt`);
const far = await rt.dispatch('pos_write_file', { path: outside, content: 'z' });
ok('a write outside the old root runs', far.ok === true && fs.readFileSync(outside, 'utf8') === 'z');
fs.rmSync(outside, { force: true });

const ran = await rt.dispatch('pos_exec_command', { command: 'echo hello-rt', cwd: dir });
ok('a command runs right away', ran.ok === true && /hello-rt/.test(ran.output));

const gone = await rt.dispatch('pos_delete_file', { path: path.join(dir, 'exists.txt') });
ok('a delete runs right away', gone.ok === true && !fs.existsSync(path.join(dir, 'exists.txt')));

const failed = await rt.dispatch('pos_read_file', { path: path.join(dir, 'missing.txt') });
ok('a failed call is recorded as an error', failed.ok === false && (await rt.snapshot()).activity.at(-1).status === 'error');

rt.updateSettings({ maxOutputBytes: 5000, execTimeoutMs: 30_000 });
ok('live output cap update', rt.bridge.state.maxOutputBytes === 5000);
ok('live timeout update', rt.bridge.state.execTimeoutMs === 30_000);
const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
ok('settings are written to config.json', saved.maxOutputBytes === 5000 && saved.execTimeoutMs === 30_000);

assert.throws(() => rt.updateSettings({ maxOutputBytes: 10 }), /between/);
assert.throws(() => rt.updateSettings({ tunnel: 'nowhere' }), /unknown tunnel/);
ok('invalid settings are rejected', true);

rt.touch();
const seen = await rt.snapshot();
ok('touch records the last request', typeof seen.lastSeen === 'string' && seen.lastSeen.length > 10);

const lines = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n');
ok('calls are appended to calls.jsonl', lines.length >= 6, String(lines.length));

rt.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
