import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../bridge/runtime.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-runtime-'));
const cfgPath = path.join(dir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  roots: [dir],
  readOnly: false,
  allowExec: true,
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

ok('loads the configured root', rt.config().roots.length === 1 && rt.config().roots[0].toLowerCase() === dir.toLowerCase());
ok('panel key is 64 hex characters', /^[0-9a-f]{64}$/.test(rt.panelKey));
ok('persists a connector secret', /^[0-9a-f]{64}$/.test(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).secret));

const ping = await rt.dispatch('pos_ping', {});
ok('pos_ping runs through the runtime', ping.ok === true && ping.bridge === 'perplexity-on-steroids');

const snap = await rt.snapshot();
ok('snapshot carries one activity row', snap.activity.length === 1, JSON.stringify(snap.activity));
ok('ping is recorded as a read', snap.activity[0].tool === 'ping' && snap.activity[0].kind === 'read');
ok('snapshot exposes 14 tools', snap.tools.length === 14, String(snap.tools.length));

fs.writeFileSync(path.join(dir, 'exists.txt'), 'x');
const write = rt.dispatch('pos_write_file', { path: path.join(dir, 'exists.txt'), content: 'y' });
await wait(30);
const pending = (await rt.snapshot()).pending;
ok('overwrite waits for approval', pending.length === 1 && pending[0].tool === 'write_file', JSON.stringify(pending));
rt.approve(pending[0].id);
const written = await write;
ok('approved overwrite runs', written.ok === true && fs.readFileSync(path.join(dir, 'exists.txt'), 'utf8') === 'y');
const approved = (await rt.snapshot()).activity.at(-1);
ok('approved call is recorded', approved.decision === 'approved' && approved.status === 'ok');

const stuck = rt.dispatch('pos_write_file', { path: path.join(dir, 'exists.txt'), content: 'z' });
await wait(30);
const denyList = (await rt.snapshot()).pending;
rt.deny(denyList[0].id, 'not this time');
const denied = await stuck;
ok('denied call does not run', denied.denied === true && fs.readFileSync(path.join(dir, 'exists.txt'), 'utf8') === 'y');
ok('denied call is recorded', (await rt.snapshot()).activity.at(-1).status === 'denied');

rt.updateSettings({ autoApprove: { write: true } });
const fresh = await rt.dispatch('pos_write_file', { path: path.join(dir, 'fresh.txt'), content: 'a' });
ok('auto-approved write runs', fresh.ok === true && fs.readFileSync(path.join(dir, 'fresh.txt'), 'utf8') === 'a');

assert.throws(() => rt.updateSettings({ roots: [path.join(dir, 'missing')] }), /no such folder/);
ok('missing root is rejected', true);

const sub = path.join(dir, 'sub');
fs.mkdirSync(sub);
rt.updateSettings({ roots: [dir, sub], readOnly: true, maxOutputBytes: 5000, execTimeoutMs: 30_000 });
ok('live roots update', rt.bridge.ROOTS.length === 2);
ok('live readOnly update', rt.bridge.state.readOnly === true);
ok('live output cap update', rt.bridge.state.maxOutputBytes === 5000);
ok('live timeout update', rt.bridge.state.execTimeoutMs === 30_000);

const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
ok('settings are written to config.json', saved.readOnly === true && saved.maxOutputBytes === 5000 && saved.roots.length === 2);

assert.throws(() => rt.updateSettings({ roots: [] }), /at least one root/);
assert.throws(() => rt.updateSettings({ readOnly: 'yes' }), /true or false/);
assert.throws(() => rt.updateSettings({ maxOutputBytes: 10 }), /between/);
ok('invalid settings are rejected', true);

rt.touch();
const seen = await rt.snapshot();
ok('touch records the last request', typeof seen.lastSeen === 'string' && seen.lastSeen.length > 10);

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-timeout-'));
const cfg2 = path.join(dir2, 'config.json');
fs.writeFileSync(cfg2, JSON.stringify({ roots: [dir2], allowExec: true, autoApprove: { write: false, exec: false, destroy: false } }));
const slow = createRuntime({ configPath: cfg2, mcpPort: 8857, panelPort: 8859, token: null, approvalTimeoutMs: 80, tunnel: false, dataDir: dir2 });
const timed = await slow.dispatch('pos_write_file', { path: path.join(dir2, 'late.txt'), content: 'x' });
ok('unapproved call times out', timed.denied === true && /timed out/.test(timed.error), JSON.stringify(timed));

rt.updateSettings({ readOnly: false, allowExec: true, autoApprove: { write: true, exec: true, destroy: false } });
const originalDispatch = rt.bridge.dispatch;
let bridgeCalls = 0;
rt.bridge.dispatch = async (...args) => { bridgeCalls++; return originalDispatch(...args); };
const invalidCwd = await rt.dispatch('pos_exec_command', { command: 'echo must-not-run', cwd: path.dirname(dir) });
ok('preflight blocks outside cwd before bridge dispatch', invalidCwd.ok === false && /working folder outside approved roots/.test(invalidCwd.error) && bridgeCalls === 0);
const invalidWrite = await rt.dispatch('pos_write_file', { path: path.join(path.dirname(dir), 'outside.txt'), content: 'blocked' });
ok('preflight blocks outside writes before bridge dispatch', invalidWrite.ok === false && bridgeCalls === 0);
ok('preflight failures are recorded as blocked', (await rt.snapshot()).activity.at(-1).decision === 'blocked');
rt.bridge.dispatch = originalDispatch;

rt.updateSettings({ autoApprove: { write: false, exec: false, destroy: false } });
const changedWrite = rt.dispatch('pos_write_file', { path: path.join(dir, 'changed.txt'), content: 'blocked' });
await wait(30);
const changedPending = (await rt.snapshot()).pending;
ok('write waits before a permission change', changedPending.length === 1);
rt.updateSettings({ readOnly: true });
if (changedPending[0]) rt.approve(changedPending[0].id);
const changedResult = await changedWrite;
ok('permissions are rechecked after approval', changedResult.ok === false && /read-only/.test(changedResult.error) && !fs.existsSync(path.join(dir, 'changed.txt')));
ok('rechecked failures leave no pending approvals', (await rt.snapshot()).pending.length === 0);

slow.close();
rt.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dir2, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

