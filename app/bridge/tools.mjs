// language: JavaScript, file: bridge/tools.mjs, target: Node 18+
// Core of the bridge: the tools. A relative path resolves against the home
// folder, and so does a call that names no folder.
// The MCP server (mcp-http.mjs) calls into this file, so the tool logic lives
// in one place and the transport stays separate.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'target']);

export const bad = (msg) => ({ ok: false, error: msg });

export const BRIDGE_VERSION = '0.1.0';
export const PREFIX = 'pos_';

// One source for the data directory, so the writer and the reader agree on it.
export const DATA = process.env.POS_DATA || path.join(os.homedir(), '.perplexity-on-steroids');
export const SESSION_DIR = path.join(DATA, 'sessions');

export function createBridge(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const HOME = os.homedir();
  const PING_NONCE = crypto.randomBytes(8).toString('hex');

  const state = {
    sessionId: null,
    maxOutputBytes: cfg.maxOutputBytes || 200_000,
    execTimeoutMs: cfg.execTimeoutMs || 120_000,
    log: [],
  };
  const note = (kind, detail) => {
    state.log.push({ t: new Date().toISOString(), kind, detail });
    if (state.log.length > 500) state.log.shift();
  };

  const resolve = (p) => (typeof p === 'string' && p.trim() ? path.resolve(HOME, p) : HOME);

  async function walk(dir, out, depth = 0) {
    if (depth > 12 || out.length > 20000) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, out, depth + 1);
      else out.push(p);
    }
  }

  // ---- tools -----------------------------------------------------------
  const tools = {
    async read_file({ path: p, offset = 0, limit = 0 }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      let st;
      try { st = await fsp.stat(abs); } catch (e) { return bad(`cannot read: ${e.code}`); }
      if (st.isDirectory()) {
        const ents = await fsp.readdir(abs, { withFileTypes: true });
        return { ok: true, dir: true, entries: ents.slice(0, 500).map((e) => ({ name: e.name, dir: e.isDirectory() })) };
      }
      const fh = await fsp.open(abs, 'r');
      try {
        const start = Math.max(0, Number(offset) || 0);
        const remaining = Math.max(0, st.size - start);
        const cap = state.maxOutputBytes;
        const want = Math.min(limit > 0 ? Number(limit) : cap, remaining, cap);
        const buf = Buffer.alloc(want);
        if (want > 0) await fh.read(buf, 0, want, start);
        return { ok: true, size: st.size, start, truncated: start + want < st.size, content: buf.toString('utf8') };
      } finally { await fh.close(); }
    },

    async list_dir({ path: p }) {
      const abs = resolve(p);
      const ents = await fsp.readdir(abs, { withFileTypes: true });
      const rows = [];
      for (const e of ents.slice(0, 1000)) {
        let size = null;
        try { size = e.isFile() ? (await fsp.stat(path.join(abs, e.name))).size : null; } catch {}
        rows.push({ name: e.name, dir: e.isDirectory(), size });
      }
      return { ok: true, dir: abs, entries: rows };
    },

    async write_file({ path: p, content = '' }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      return { ok: true, wrote: abs, bytes: Buffer.byteLength(content) };
    },

    async edit_file({ path: p, find = '', replace = '', all = false }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      if (!find) return bad('find is empty');
      const src = await fsp.readFile(abs, 'utf8');
      const idx = src.indexOf(find);
      if (idx < 0) return bad(`not found: ${JSON.stringify(find.slice(0, 80))}`);
      // Replace the first match only, and treat `find` as a literal string.
      // join() on a one-element array adds no separator, so slice is used here.
      const out = all
        ? src.split(find).join(replace)
        : src.slice(0, idx) + replace + src.slice(idx + find.length);
      await fsp.writeFile(abs, out, 'utf8');
      const count = all ? src.split(find).length - 1 : 1;
      return { ok: true, path: abs, replacements: count, bytes: Buffer.byteLength(out) };
    },

    async delete_file({ path: p }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      if (!fs.existsSync(abs)) return bad('no such file');
      await fsp.rm(abs, { recursive: true, force: true });
      return { ok: true, deleted: abs };
    },

    async copy_file({ from = '', to = '' }) {
      if (!from || !to) return bad('from and to are required');
      const src = resolve(from);
      const dst = resolve(to);
      if (!fs.existsSync(src)) return bad(`no such source: ${src}`);
      if (src.toLowerCase() === dst.toLowerCase()) return bad('source and destination are the same');
      const st = fs.statSync(src);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (st.isDirectory()) await fsp.cp(src, dst, { recursive: true, force: true });
      else await fsp.copyFile(src, dst);
      return { ok: true, from: src, to: dst, dir: st.isDirectory(), bytes: st.isDirectory() ? null : st.size };
    },

    async move_file({ from = '', to = '' }) {
      if (!from || !to) return bad('from and to are required');
      const src = resolve(from);
      const dst = resolve(to);
      if (!fs.existsSync(src)) return bad(`no such source: ${src}`);
      if (src.toLowerCase() === dst.toLowerCase()) return bad('source and destination are the same');
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      try {
        await fsp.rename(src, dst);
      } catch (e) {
        if (e.code === 'EXDEV') {
          const st = fs.statSync(src);
          if (st.isDirectory()) await fsp.cp(src, dst, { recursive: true, force: true });
          else await fsp.copyFile(src, dst);
          await fsp.rm(src, { recursive: true, force: true });
        } else throw e;
      }
      return { ok: true, from: src, to: dst };
    },

    async make_dir({ path: p }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      await fsp.mkdir(abs, { recursive: true });
      return { ok: true, dir: abs };
    },

    async search({ path: p, query = '', isRegex = false, glob = '', maxHits = 200 }) {
      const root = resolve(p);
      if (!query) return bad('query is empty');
      let re = null;
      if (isRegex) {
        try { re = new RegExp(query, 'gi'); } catch (e) { return bad(`regex: ${e.message}`); }
      }
      const files = [];
      await walk(root, files);
      const reExt = glob
        ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
        : null;
      const hits = [];
      for (const f of files) {
        if (hits.length >= Number(maxHits)) break;
        if (reExt && !reExt.test(path.basename(f))) continue;
        let st;
        try { st = await fsp.stat(f); } catch { continue; }
        if (st.size > 4 * 1024 * 1024) continue;
        let txt;
        try { txt = await fsp.readFile(f, 'utf8'); } catch { continue; }
        if (txt.includes('\u0000')) continue;
        const lines = txt.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const hit = re ? re.test(lines[i]) : lines[i].includes(query);
          if (re) re.lastIndex = 0;
          if (hit) {
            hits.push({ file: f, line: i + 1, text: lines[i].slice(0, 400) });
            if (hits.length >= Number(maxHits)) break;
          }
        }
      }
      return { ok: true, root, hits, truncated: hits.length >= Number(maxHits) };
    },

    async exec_command({ command = '', cwd = '', timeoutMs = 0 }) {
      if (!command) return bad('command is empty');
      const dir = resolve(cwd);
      const isWin = process.platform === 'win32';
      const t = Math.min(Number(timeoutMs) || state.execTimeoutMs, 900_000);
      return await new Promise((resolve) => {
        const sh = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/c', command] : ['-c', command], {
          cwd: dir, env: process.env, windowsHide: true,
        });
        let out = '';
        const cap = (b) => { if (out.length < state.maxOutputBytes) out += b.toString('utf8'); };
        sh.stdout.on('data', cap);
        sh.stderr.on('data', cap);
        const killer = setTimeout(() => { try { sh.kill('SIGKILL'); } catch {} }, t);
        sh.on('error', (e) => { clearTimeout(killer); resolve(bad(e.message)); });
        sh.on('close', (code) => {
          clearTimeout(killer);
          resolve({ ok: code === 0, exit: code, cwd: dir, output: out.length >= state.maxOutputBytes ? out + '\n[output truncated]' : out });
        });
      });
    },

    async batch({ calls = [] }) {
      if (!Array.isArray(calls)) return bad('calls must be an array');
      if (!calls.length) return bad('calls is empty');
      if (calls.length > 20) return bad('at most 20 calls (sequential, not parallel)');
      const out = [];
      for (const c of calls) {
        if (!c || typeof c.tool !== 'string') { out.push({ ok: false, error: 'invalid call' }); continue; }
        const name = c.tool.replace(/^pos_/, '');
        if (name === 'batch') { out.push({ ok: false, error: 'nested batch is not allowed' }); continue; }
        const r = await dispatch(c.tool, c.args || {});
        out.push({ tool: c.tool, ...r });
      }
      return { ok: true, count: out.length, results: out };
    },

    async list_sessions() {
      if (!fs.existsSync(SESSION_DIR)) return { ok: true, sessions: [] };
      const ids = fs.readdirSync(SESSION_DIR).filter((d) => fs.existsSync(path.join(SESSION_DIR, d, 'steps.jsonl')));
      return { ok: true, sessions: ids };
    },

    async session_log({ id = '', tail = 40 }) {
      const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safe) return bad('id is required');
      const f = path.join(SESSION_DIR, safe, 'steps.jsonl');
      if (!fs.existsSync(f)) return bad(`no such session: ${safe}`);
      const lines = (await fsp.readFile(f, 'utf8')).trim().split('\n').filter(Boolean);
      const rows = lines.slice(-(Number(tail) || 40)).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      return { ok: true, id: safe, total: lines.length, steps: rows };
    },
  };

  const TOOL_ALIAS = new Map(Object.keys(tools).map((t) => [`${PREFIX}${t}`, t]));
  const ADVERTISED = [`${PREFIX}ping`, ...Object.keys(tools).map((t) => `${PREFIX}${t}`)];

  async function pos_ping() {
    return {
      ok: true,
      bridge: 'perplexity-on-steroids',
      version: BRIDGE_VERSION,
      nonce: PING_NONCE,
      machine: os.hostname(),
      platform: `${process.platform}/${process.arch}`,
      home: HOME,
      tools: ADVERTISED,
      note: 'This response came from the local bridge. You can now use the pos_-prefixed tools.',
    };
  }

  async function dispatch(tool, args) {
    if (tool === `${PREFIX}ping`) return pos_ping();
    const fn = tools[TOOL_ALIAS.get(tool) || tool];
    if (!fn) return bad(`unknown tool: ${tool}. Available: ${ADVERTISED.join(', ')}`);
    try { return await fn(args || {}); } catch (e) { return bad(`${tool} threw: ${e.message}`); }
  }

  return { cfg, HOME, state, tools, dispatch, ADVERTISED, note, resolve };
}
