// language: JavaScript, file: bridge/tools.mjs, target: Node 18+
// Core of the bridge: the path gate, the tools, and the approval flow.
// The MCP server (mcp-http.mjs) calls into this file, so the tool logic lives
// in one place and the transport stays separate.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'target']);

// Heuristic only. Unmatched commands are not necessarily safe.
// Shell execution is not sandboxed by the filesystem roots.
export const DESTRUCTIVE =
  /\b(rm\s+-[a-z]*[rf]|rmdir|rd\s*\/s|erase|del\s*\/[qsf]|remove-item|clear-content|format-volume|diskpart|takeown|icacls\s*\/[gr]|reg\s+delete|stop-computer|restart-computer|shutdown|cipher\s*\/w|shred|wipefs|mkfs|dd\s+if=|curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh)/i;

export const bad = (msg) => ({ ok: false, error: msg });

export const BRIDGE_VERSION = '0.1.0';
export const PREFIX = 'pos_';

// One source for the data directory, so the writer and the reader agree on it.
export const DATA = process.env.POS_DATA || path.join(os.homedir(), '.perplexity-on-steroids');
export const SESSION_DIR = path.join(DATA, 'sessions');

// The user's real Desktop. OneDrive often moves it, so ask Explorer's own record
// first, then try the usual places.
export function desktopDir() {
  const tries = [];
  if (process.platform === 'win32') {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = String(r.stdout || '').match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (m) tries.push(m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`));
    if (process.env.OneDrive) tries.push(path.join(process.env.OneDrive, 'Desktop'));
  }
  tries.push(path.join(os.homedir(), 'Desktop'));
  return tries.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) || os.homedir();
}

export function createBridge(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // A fresh install ships with no roots: start with the user's Desktop.
  if (!Array.isArray(cfg.roots) || !cfg.roots.length) cfg.roots = [desktopDir()];
  const ROOTS = (cfg.roots || []).map((r) => path.resolve(r));
  const PING_NONCE = crypto.randomBytes(8).toString('hex');

  const state = {
    sessionId: null,
    readOnly: !!cfg.readOnly,
    allowExec: cfg.allowExec !== false,
    allowDestructive: !!cfg.allowDestructive,
    maxOutputBytes: cfg.maxOutputBytes || 200_000,
    execTimeoutMs: cfg.execTimeoutMs || 120_000,
    log: [],
  };
  const note = (kind, detail) => {
    state.log.push({ t: new Date().toISOString(), kind, detail });
    if (state.log.length > 500) state.log.shift();
  };

  // ---- path gate -------------------------------------------------------
  // A root can be a drive root like `C:\`. path.sep is already the trailing
  // separator there, so `r + sep` would produce a doubled backslash. Normalize
  // each root before comparing: strip trailing separators, but keep `C:\` and
  // not `C:`.
  function within(root, candidate) {
    const fold = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
    const rel = path.relative(fold(root), fold(candidate));
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
  }

  function resolvedCandidate(candidate) {
    let current = candidate;
    const missing = [];
    for (;;) {
      try {
        fs.lstatSync(current);
      } catch (e) {
        if (e.code !== 'ENOENT') return null;
        const parent = path.dirname(current);
        if (parent === current) return null;
        missing.unshift(path.basename(current));
        current = parent;
        continue;
      }
      try { return path.join(fs.realpathSync.native(current), ...missing); }
      catch { return null; }
    }
  }

  function gate(p) {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
    const abs = path.resolve(p);
    for (const raw of ROOTS) {
      const root = path.resolve(raw);
      if (!within(root, abs)) continue;
      let realRoot;
      try { realRoot = fs.realpathSync.native(root); } catch { continue; }
      const real = resolvedCandidate(abs);
      if (real && within(realRoot, real)) return abs;
    }
    return null;
  }

  async function walk(dir, out, depth = 0) {
    if (depth > 12 || out.length > 20000) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (!gate(p)) continue;
      if (e.isDirectory()) await walk(p, out, depth + 1);
      else out.push(p);
    }
  }

  // ---- tools -----------------------------------------------------------
  const tools = {
    async read_file({ path: p, offset = 0, limit = 0 }) {
      const abs = gate(p);
      if (!abs) return bad(`path outside approved roots: ${p}`);
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
      const abs = gate(p === undefined ? ROOTS[0] : p);
      if (!abs) return bad(p === undefined ? 'no valid roots defined in config.json' : `path outside approved roots: ${p}`);
      const ents = await fsp.readdir(abs, { withFileTypes: true });
      const rows = [];
      for (const e of ents.slice(0, 1000)) {
        let size = null;
        try { size = e.isFile() ? (await fsp.stat(path.join(abs, e.name))).size : null; } catch {}
        rows.push({ name: e.name, dir: e.isDirectory(), size });
      }
      return { ok: true, dir: abs, entries: rows };
    },

    async write_file({ path: p, content = '', allowOverwrite = false, confirm = false }) {
      if (state.readOnly) return bad('read-only mode is on');
      const abs = gate(p);
      if (!abs) return bad(`path outside approved roots: ${p}`);
      const exists = fs.existsSync(abs);
      if (exists && !allowOverwrite) {
        return {
          ok: false, pending: true,
          preview: `${abs} already exists (${fs.statSync(abs).size} bytes). It will be overwritten.`,
          hint: 'The overwrite waits for approval in the local panel.',
        };
      }
      if (exists && !confirm) {
        return {
          ok: false, pending: true,
          preview: `${abs} already exists (${fs.statSync(abs).size} bytes). It will be overwritten.`,
          hint: 'This waits for approval in the local panel.',
        };
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      return { ok: true, wrote: abs, bytes: Buffer.byteLength(content) };
    },

    async edit_file({ path: p, find = '', replace = '', all = false }) {
      if (state.readOnly) return bad('read-only mode is on');
      const abs = gate(p);
      if (!abs) return bad(`path outside approved roots: ${p}`);
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

    async delete_file({ path: p, confirm = false }) {
      if (state.readOnly) return bad('read-only mode is on');
      const abs = gate(p);
      if (!abs) return bad(`path outside approved roots: ${p}`);
      if (!fs.existsSync(abs)) return bad('no such file');
      if (!confirm) {
        const size = fs.statSync(abs).size;
        return {
          ok: false, pending: true,
          preview: `${abs} will be deleted (${size} bytes). This cannot be undone.`,
          hint: 'This waits for approval in the local panel.',
        };
      }
      await fsp.rm(abs, { recursive: true, force: true });
      return { ok: true, deleted: abs };
    },

    async copy_file({ from = '', to = '', overwrite = false, confirm = false }) {
      if (state.readOnly) return bad('read-only mode is on');
      const src = gate(from);
      const dst = gate(to);
      if (!src) return bad(`source path outside approved roots: ${from}`);
      if (!dst) return bad(`destination path outside approved roots: ${to}`);
      if (!fs.existsSync(src)) return bad(`no such source: ${src}`);
      if (src.toLowerCase() === dst.toLowerCase()) return bad('source and destination are the same');
      const dstExists = fs.existsSync(dst);
      if (dstExists && !overwrite) {
        const st0 = fs.statSync(src);
        return {
          ok: false, pending: true,
          preview: `${dst} already exists. The ${st0.isDirectory() ? 'directory' : 'file'} will be overwritten.`,
          hint: 'This overwrite waits for approval in the local panel.',
        };
      }
      if (dstExists && !confirm) {
        return { ok: false, pending: true, preview: `${dst} will be overwritten.`, hint: 'Send confirm:true to approve.' };
      }
      const st = fs.statSync(src);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (st.isDirectory()) await fsp.cp(src, dst, { recursive: true, force: true });
      else await fsp.copyFile(src, dst);
      return { ok: true, from: src, to: dst, dir: st.isDirectory(), bytes: st.isDirectory() ? null : st.size };
    },

    async move_file({ from = '', to = '', confirm = false }) {
      if (state.readOnly) return bad('read-only mode is on');
      const src = gate(from);
      const dst = gate(to);
      if (!src) return bad(`source path outside approved roots: ${from}`);
      if (!dst) return bad(`destination path outside approved roots: ${to}`);
      if (!fs.existsSync(src)) return bad(`no such source: ${src}`);
      if (src.toLowerCase() === dst.toLowerCase()) return bad('source and destination are the same');
      const dstExists = fs.existsSync(dst);
      if (dstExists && !confirm) {
        return { ok: false, pending: true, preview: `${dst} already exists and will be replaced.`, hint: 'Send confirm:true to approve.' };
      }
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
      if (state.readOnly) return bad('read-only mode is on');
      const abs = gate(p);
      if (!abs) return bad(`path outside approved roots: ${p}`);
      await fsp.mkdir(abs, { recursive: true });
      return { ok: true, dir: abs };
    },

    async search({ path: p, query = '', isRegex = false, glob = '', maxHits = 200 }) {
      const root = gate(p === undefined ? ROOTS[0] : p);
      if (!root) return bad(p === undefined ? 'no valid roots defined in config.json' : `path outside approved roots: ${p}`);
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

    async exec_command({ command = '', cwd = '', timeoutMs = 0, confirm = false }) {
      if (!state.allowExec) return bad('exec_command is disabled in config');
      if (state.readOnly) return bad('read-only mode is on');
      if (!command) return bad('command is empty');
      if (DESTRUCTIVE.test(command) && !confirm) {
        return {
          ok: false, pending: true,
          preview: `shell: ${command}`,
          hint: 'This destructive command waits for approval in the local panel.',
        };
      }
      const dir = gate(cwd === '' ? ROOTS[0] : cwd);
      if (!dir) return bad(`working folder outside approved roots: ${cwd}`);
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
      roots: ROOTS,
      readOnly: state.readOnly,
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

  return { cfg, ROOTS, state, tools, dispatch, ADVERTISED, note, gate };
}
