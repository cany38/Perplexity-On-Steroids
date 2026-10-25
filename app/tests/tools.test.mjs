// Unit tests for the core: path resolution, direct writes and deletes, batch limits.
// No server needed: createBridge() with a temp config is enough.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../bridge/tools.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  OK   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log('  OK   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ maxOutputBytes: 4096, execTimeoutMs: 5000 }));
const b = createBridge(cfgPath);

// ---- paths --------------------------------------------------------------
t('an absolute path is used as is', () => {
  const p = path.join(tmp, 'file.txt');
  assert.equal(b.resolve(p), p);
});

t('a relative path starts from the home folder', () => {
  assert.equal(b.resolve('notes.txt'), path.join(os.homedir(), 'notes.txt'));
});

t('a missing path means the home folder', () => {
  assert.equal(b.resolve(''), os.homedir());
  assert.equal(b.resolve(undefined), os.homedir());
});

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

// ---- writes and deletes run right away ---------------------------------
await ta('write_file creates a new file', async () => {
  const p = path.join(tmp, 'fresh.txt');
  const r = await b.dispatch('pos_write_file', { path: p, content: 'x' });
  assert.equal(r.ok, true);
});

await ta('write_file overwrites an existing file', async () => {
  const p = path.join(tmp, 'fresh.txt');
  const r = await b.dispatch('pos_write_file', { path: p, content: 'y' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'y');
});

await ta('copy_file overwrites the destination', async () => {
  fs.writeFileSync(path.join(tmp, 'src.txt'), 'new');
  fs.writeFileSync(path.join(tmp, 'dst.txt'), 'old');
  const r = await b.dispatch('pos_copy_file', { from: path.join(tmp, 'src.txt'), to: path.join(tmp, 'dst.txt') });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(tmp, 'dst.txt'), 'utf8'), 'new');
});

await ta('delete_file deletes right away', async () => {
  const p = path.join(tmp, 'fresh.txt');
  const r = await b.dispatch('pos_delete_file', { path: p });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(p), false);
});

await ta('a command runs right away', async () => {
  const r = await b.dispatch('pos_exec_command', { command: 'echo ran-it', cwd: tmp });
  assert.equal(r.ok, true);
  assert.equal(r.cwd, tmp);
  assert.match(r.output, /ran-it/);
});

// ---- no folder limit ----------------------------------------------------
await ta('list_dir reaches a folder outside the old roots', async () => {
  const r = await b.dispatch('pos_list_dir', { path: path.dirname(tmp) });
  assert.equal(r.ok, true);
  assert.equal(r.dir, path.dirname(tmp));
});

await ta('list_dir defaults to the home folder', async () => {
  const r = await b.dispatch('pos_list_dir', {});
  assert.equal(r.ok, true);
  assert.equal(r.dir, os.homedir());
});

await ta('ping reports the home folder', async () => {
  const r = await b.dispatch('pos_ping', {});
  assert.equal(r.home, os.homedir());
  assert.equal('roots' in r, false);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
