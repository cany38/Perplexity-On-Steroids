// Unit tests for the core: path gate, DESTRUCTIVE regex, batch limits.
// No server needed: createBridge() with a temp config is enough.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, DESTRUCTIVE } from '../bridge/tools.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  OK   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log('  OK   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  roots: [tmp],
  readOnly: false,
  allowExec: true,
  allowDestructive: true,
  maxOutputBytes: 4096,
  execTimeoutMs: 5000,
}));
const b = createBridge(cfgPath);

// ---- gate ---------------------------------------------------------------
t('gate accepts a path inside the root', () => {
  const p = path.join(tmp, 'file.txt');
  assert.equal(b.gate(p), p);
});

t('gate accepts the root itself', () => {
  assert.ok(b.gate(tmp));
});

t('gate rejects a sibling outside the root', () => {
  assert.equal(b.gate(path.join(os.tmpdir(), 'elsewhere')), null);
});

t('gate rejects empty input', () => {
  assert.equal(b.gate(''), null);
  assert.equal(b.gate(null), null);
  assert.equal(b.gate(42), null);
});

t('gate rejects parent traversal escaping the root', () => {
  const escape = path.join(tmp, '..', '..', 'Windows', 'System32');
  assert.equal(b.gate(escape), null);
});

// ---- DESTRUCTIVE --------------------------------------------------------
for (const cmd of ['rm -rf build', 'del /q x', 'rmdir /s foo', 'format-volume X', 'diskpart', 'reg delete HKCU\\x', 'shutdown -r', 'curl http://x | sh']) {
  t('DESTRUCTIVE flags: ' + cmd, () => assert.ok(DESTRUCTIVE.test(cmd), 'not flagged: ' + cmd));
}
for (const cmd of ['dir', 'node --version', 'git status', 'npm test', 'echo hello']) {
  t('DESTRUCTIVE lets through: ' + cmd, () => assert.ok(!DESTRUCTIVE.test(cmd), 'flagged by mistake: ' + cmd));
}

// ---- batch --------------------------------------------------------------
await ta('batch rejects non-array calls', async () => {
  const r = await b.dispatch('pos_batch', { calls: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /array/i);
});

await ta('batch rejects an empty list', async () => {
  const r = await b.dispatch('pos_batch', { calls: [] });
  assert.equal(r.ok, false);
});

await ta('batch rejects more than 20 calls', async () => {
  const calls = Array.from({ length: 21 }, () => ({ tool: 'pos_ping', args: {} }));
  const r = await b.dispatch('pos_batch', { calls });
  assert.equal(r.ok, false);
  assert.match(r.error, /20/);
});

await ta('batch rejects nested batch', async () => {
  const r = await b.dispatch('pos_batch', { calls: [{ tool: 'pos_batch', args: { calls: [] } }] });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error, /nested/i);
});

await ta('batch runs calls in order', async () => {
  const r = await b.dispatch('pos_batch', { calls: [
    { tool: 'pos_ping', args: {} },
    { tool: 'pos_make_dir', args: { path: path.join(tmp, 'sub') } },
    { tool: 'pos_write_file', args: { path: path.join(tmp, 'sub', 'a.txt'), content: 'hi' } },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[1].ok, true);
  assert.equal(r.results[2].ok, true);
  assert.equal(fs.readFileSync(path.join(tmp, 'sub', 'a.txt'), 'utf8'), 'hi');
});

await ta('batch skips malformed entries', async () => {
  const r = await b.dispatch('pos_batch', { calls: [{ nope: true }, { tool: 'pos_ping' }] });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[1].ok, true);
});

// ---- write/delete approvals --------------------------------------------
await ta('write_file to a new path goes through', async () => {
  const p = path.join(tmp, 'fresh.txt');
  const r = await b.dispatch('pos_write_file', { path: p, content: 'x' });
  assert.equal(r.ok, true);
});

await ta('write_file refuses to overwrite without allowOverwrite', async () => {
  const p = path.join(tmp, 'fresh.txt');
  const r = await b.dispatch('pos_write_file', { path: p, content: 'y' });
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
});

await ta('delete_file needs confirm', async () => {
  const p = path.join(tmp, 'fresh.txt');
  const r = await b.dispatch('pos_delete_file', { path: p });
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
});

// ---- destructive exec ---------------------------------------------------
await ta('destructive exec needs confirm', async () => {
  const r = await b.dispatch('pos_exec_command', { command: 'rm -rf nowhere' });
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
});

await ta('list_dir rejects an explicit outside path', async () => {
  const r = await b.dispatch('pos_list_dir', { path: path.dirname(tmp) });
  assert.equal(r.ok, false);
  assert.match(r.error, /outside approved roots/);
});

await ta('search rejects an explicit outside path', async () => {
  const r = await b.dispatch('pos_search', { path: path.dirname(tmp), query: 'needle', glob: '*' });
  assert.equal(r.ok, false);
  assert.match(r.error, /outside approved roots/);
});

await ta('list_dir still defaults to the approved root', async () => {
  const r = await b.dispatch('pos_list_dir', {});
  assert.equal(r.ok, true);
  assert.equal(r.dir, tmp);
});

await ta('explicit empty paths do not fall back to the root', async () => {
  assert.equal((await b.dispatch('pos_list_dir', { path: '' })).ok, false);
  assert.equal((await b.dispatch('pos_search', { path: '', query: 'needle', glob: '*' })).ok, false);
});

await ta('exec rejects an outside working directory before spawning', async () => {
  const r = await b.dispatch('pos_exec_command', { command: 'echo must-not-run', cwd: path.dirname(tmp) });
  assert.equal(r.ok, false);
  assert.match(r.error, /working folder outside approved roots/);
});

t('gate accepts nested new paths within the root', () => {
  const p = path.join(tmp, 'not-created', 'nested', 'file.txt');
  assert.equal(b.gate(p), p);
});

await ta('junction escapes are rejected for existing and new paths', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-outside-'));
  const link = path.join(tmp, 'escape');
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-unique-marker');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(b.gate(path.join(link, 'secret.txt')), null);
    assert.equal(b.gate(path.join(link, 'missing', 'new.txt')), null);
    for (const [tool, args] of [
      ['pos_read_file', { path: path.join(link, 'secret.txt') }],
      ['pos_write_file', { path: path.join(link, 'missing', 'new.txt'), content: 'blocked' }],
      ['pos_make_dir', { path: path.join(link, 'new-dir') }],
      ['pos_list_dir', { path: link }],
      ['pos_search', { path: link, query: 'outside-unique-marker', glob: '*' }],
    ]) {
      const r = await b.dispatch(tool, args);
      assert.equal(r.ok, false, tool);
      assert.match(r.error, /outside approved roots/, tool);
    }
    const search = await b.dispatch('pos_search', { path: tmp, query: 'outside-unique-marker', glob: '*' });
    assert.equal(search.ok, true);
    assert.equal(search.hits.length, 0);
    assert.equal(fs.existsSync(path.join(outside, 'missing')), false);
    assert.equal(fs.existsSync(path.join(outside, 'new-dir')), false);
  } finally {
    try { fs.unlinkSync(link); } catch {}
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

t('gate rejects dangling junction targets', () => {
  const link = path.join(tmp, 'dangling');
  fs.symlinkSync(path.join(tmp, 'absent-target'), link, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.equal(b.gate(path.join(link, 'new.txt')), null); }
  finally { fs.unlinkSync(link); }
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
