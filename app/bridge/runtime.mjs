import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBridge, BRIDGE_VERSION, DATA, DESTRUCTIVE } from './tools.mjs';
import { createApprovals } from './approvals.mjs';
import { startTunnel, tunnelAvailable } from './tunnel.mjs';
import { createRelaySetup } from './relaySetup.mjs';

const READ = new Set(['ping', 'list_dir', 'read_file', 'search', 'list_sessions', 'session_log']);
const WRITE = new Set(['write_file', 'edit_file', 'copy_file', 'move_file', 'make_dir']);
const ARG_KEYS = ['path', 'from', 'to', 'cwd', 'query', 'glob', 'isRegex', 'offset', 'limit', 'command', 'id', 'tail', 'maxHits'];

function kindOf(tool) {
  if (tool === 'delete_file') return 'delete';
  if (tool === 'exec_command') return 'exec';
  if (tool === 'batch') return 'batch';
  if (WRITE.has(tool)) return 'write';
  if (READ.has(tool)) return 'read';
  return 'other';
}

function previewOf(args = {}) {
  const out = {};
  for (const k of ARG_KEYS) if (args[k] !== undefined) out[k] = args[k];
  if (Array.isArray(args.calls)) out.calls = args.calls.map((c) => c && c.tool).filter(Boolean);
  const text = JSON.stringify(out);
  return text.length > 600 ? text.slice(0, 600) + '...' : text;
}

function clip(text, max = 900) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function normalizeRoots(list) {
  if (!Array.isArray(list)) throw new Error('roots must be an array');
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('root paths must be non-empty strings');
    const abs = path.resolve(raw.trim());
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error(`no such folder: ${abs}`); }
    if (!st.isDirectory()) throw new Error(`not a folder: ${abs}`);
    if (!out.some((r) => r.toLowerCase() === abs.toLowerCase())) out.push(abs);
  }
  if (!out.length) throw new Error('at least one root is required');
  return out;
}

function integer(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function secret() {
  return crypto.randomBytes(32).toString('hex');
}

function needsApproval(info, config) {
  if (info.kind === 'read') return false;
  if (info.kind === 'delete' || info.destructive) return !config.autoApprove.destroy;
  if (info.kind === 'write') return !config.autoApprove.write;
  if (info.kind === 'exec') return !config.autoApprove.exec;
  return true;
}

export function createRuntime({ configPath, mcpPort, panelPort, token, approvalTimeoutMs = 90_000, tunnel: startTunnels = true, dataDir = DATA }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'state.json');
  let diskState = {};
  try { diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const bridge = createBridge(configPath);
  let cfg = {
    ...bridge.cfg,
    autoApprove: { write: false, exec: false, destroy: false, ...(bridge.cfg.autoApprove || {}) },
    approvalTimeoutMs: Number(bridge.cfg.approvalTimeoutMs) || approvalTimeoutMs,
    tunnel: bridge.cfg.tunnel || 'auto',
    publicUrl: bridge.cfg.publicUrl || '',
    relayUrl: diskState.relayUrl || bridge.cfg.relayUrl || '',
  };
  if (typeof bridge.cfg.allowDestructive === 'boolean' && !bridge.cfg.autoApprove) {
    cfg.autoApprove.destroy = bridge.cfg.allowDestructive;
  }
  cfg.secret = /^[0-9a-f]{64}$/.test(String(diskState.secret || '')) ? diskState.secret
    : /^[0-9a-f]{64}$/.test(String(bridge.cfg.secret || '')) ? bridge.cfg.secret : secret();

  const activity = [];
  const started = new Date().toISOString();
  const panelKey = crypto.randomBytes(32).toString('hex');
  const approvals = createApprovals({ logFile: path.join(dataDir, 'calls.jsonl'), timeoutMs: cfg.approvalTimeoutMs });
  const relaySetup = createRelaySetup();
  // Last request that came through the relay or tunnel. Saved with the state so
  // the panel still knows Perplexity is connected after a restart.
  let lastSeen = diskState.lastSeen || null;
  let lastSaved = 0;
  let tunnel = { state: { kind: null, status: 'off', url: '', error: '', detail: '', hint: '', stable: false }, stop() {} };

  function config() {
    return {
      roots: [...bridge.ROOTS],
      readOnly: !!bridge.state.readOnly,
      allowExec: !!bridge.state.allowExec,
      allowDestructive: !!bridge.state.allowDestructive,
      autoApprove: { ...cfg.autoApprove },
      approvalTimeoutMs: cfg.approvalTimeoutMs,
      maxOutputBytes: bridge.state.maxOutputBytes,
      execTimeoutMs: bridge.state.execTimeoutMs,
      tunnel: cfg.tunnel,
      publicUrl: cfg.publicUrl,
      relayUrl: cfg.relayUrl,
      configFile: configPath,
      logFile: path.join(dataDir, 'calls.jsonl'),
    };
  }

  function save() {
    const disk = { ...cfg };
    delete disk.secret;
    delete disk.relayUrl;
    delete disk.allowDestructive;
    fs.writeFileSync(configPath, JSON.stringify(disk, null, 2) + '\n');
    writeState();
    bridge.cfg = cfg;
  }

  function writeState() {
    fs.writeFileSync(stateFile, JSON.stringify({ secret: cfg.secret, relayUrl: cfg.relayUrl, lastSeen }, null, 2) + '\n', { mode: 0o600 });
  }

  save();

  function syncBridge() {
    bridge.state.readOnly = !!cfg.readOnly;
    bridge.state.allowExec = cfg.allowExec !== false;
    bridge.state.allowDestructive = !!cfg.autoApprove.destroy;
    bridge.state.maxOutputBytes = cfg.maxOutputBytes || bridge.state.maxOutputBytes;
    bridge.state.execTimeoutMs = cfg.execTimeoutMs || bridge.state.execTimeoutMs;
  }

  function updateSettings(patch = {}) {
    const next = config();
    if (patch.roots !== undefined) next.roots = normalizeRoots(patch.roots);
    for (const key of ['readOnly', 'allowExec']) {
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'boolean') throw new Error(`${key} must be true or false`);
        next[key] = patch[key];
      }
    }
    if (patch.autoApprove !== undefined) {
      if (!patch.autoApprove || typeof patch.autoApprove !== 'object') throw new Error('autoApprove must be an object');
      for (const key of ['write', 'exec', 'destroy']) {
        if (patch.autoApprove[key] !== undefined) {
          if (typeof patch.autoApprove[key] !== 'boolean') throw new Error(`autoApprove.${key} must be true or false`);
          next.autoApprove[key] = patch.autoApprove[key];
        }
      }
    }
    if (typeof patch.allowDestructive === 'boolean') next.autoApprove.destroy = patch.allowDestructive;
    if (patch.maxOutputBytes !== undefined) next.maxOutputBytes = integer(patch.maxOutputBytes, 'maxOutputBytes', 1000, 5_000_000);
    if (patch.execTimeoutMs !== undefined) next.execTimeoutMs = integer(patch.execTimeoutMs, 'execTimeoutMs', 1000, 900_000);
    if (patch.publicUrl !== undefined) next.publicUrl = String(patch.publicUrl || '').trim();
    if (patch.tunnel !== undefined) {
      if (!['auto', 'relay', 'cloudflared', 'manual', 'none'].includes(patch.tunnel)) throw new Error('unknown tunnel mode');
      next.tunnel = patch.tunnel;
    }

    bridge.ROOTS.splice(0, bridge.ROOTS.length, ...next.roots);
    cfg = {
      ...cfg,
      roots: next.roots,
      readOnly: next.readOnly,
      allowExec: next.allowExec,
      autoApprove: next.autoApprove,
      maxOutputBytes: next.maxOutputBytes,
      execTimeoutMs: next.execTimeoutMs,
      publicUrl: next.publicUrl,
      tunnel: next.tunnel,
    };
    syncBridge();
    save();
    if (patch.publicUrl !== undefined || patch.tunnel !== undefined) restartTunnel();
    return { ok: true, config: config() };
  }

  function record(tool, args, res, ms, decision = 'auto', info = null) {
    const short = String(tool || '').replace(/^pos_/, '');
    const row = {
      t: new Date().toISOString(),
      tool: short,
      kind: (info && info.kind) || kindOf(short),
      target: clip((info && info.target) || targetOf(args), 300),
      summary: clip((info && info.summary) || '', 300),
      args: previewOf(args),
      status: res && res.denied ? 'denied' : res && res.ok ? 'ok' : 'error',
      decision,
      ms: Math.round(ms),
      error: res && !res.ok ? clip(res.error || res.preview || 'failed') : '',
      note: res && res.ok ? '' : clip(res.preview || res.hint || ''),
    };
    activity.push(row);
    if (activity.length > 200) activity.shift();
    approvals.record({ ...row, t: row.t, tool: short, ok: !!res?.ok, reason: res?.denied ? row.error : undefined });
    return row;
  }

  function targetOf(args = {}) {
    if (args.command) return String(args.command);
    if (args.query) return JSON.stringify(String(args.query));
    if (args.from) return args.to ? `${args.from} -> ${args.to}` : String(args.from);
    if (args.path) return String(args.path);
    if (args.id) return String(args.id);
    if (Array.isArray(args.calls)) return `${args.calls.length} calls`;
    return '';
  }

  function describe(tool, a = {}) {
    const abs = a.path ? bridge.gate(a.path) || String(a.path) : '';
    const from = a.from ? bridge.gate(a.from) || String(a.from) : '';
    const to = a.to ? bridge.gate(a.to) || String(a.to) : '';
    const cwd = a.cwd ? bridge.gate(a.cwd) || String(a.cwd) : '';
    if (tool === 'write_file') {
      const exists = !!abs && fs.existsSync(abs);
      const bytes = Buffer.byteLength(String(a.content ?? ''));
      return {
        kind: 'write', destructive: false, danger: exists,
        summary: `${exists ? 'overwrite' : 'new file'}: ${abs}`,
        detail: String(a.content ?? '').slice(0, 4000),
        target: abs,
        isNew: !exists,
        extra: exists ? `current size ${fs.statSync(abs).size} bytes -> new ${bytes} bytes` : `${bytes} bytes`,
      };
    }
    if (tool === 'edit_file') {
      return {
        kind: 'write', destructive: false, danger: false,
        summary: `edit: ${abs}${a.all ? ' (all matches)' : ''}`,
        detail: `- ${String(a.find ?? '').slice(0, 2000)}\n+ ${String(a.replace ?? '').slice(0, 2000)}`,
        target: abs,
        before: String(a.find ?? '').slice(0, 3000),
        after: String(a.replace ?? '').slice(0, 3000),
      };
    }
    if (tool === 'delete_file') {
      return { kind: 'delete', destructive: true, danger: true, summary: `DELETE: ${abs}`, target: abs, detail: 'No undo.' };
    }
    if (tool === 'copy_file') {
      const exists = !!to && fs.existsSync(to);
      return {
        kind: 'write', destructive: false, danger: exists,
        summary: `${exists ? 'overwrite' : 'copy'}: ${from} -> ${to}`,
        target: `${from} -> ${to}`,
        detail: exists ? `${to} already exists and will be replaced.` : '',
      };
    }
    if (tool === 'move_file') {
      const exists = !!to && fs.existsSync(to);
      return {
        kind: 'write', destructive: false, danger: exists,
        summary: `${exists ? 'replace' : 'move'}: ${from} -> ${to}`,
        target: `${from} -> ${to}`,
        detail: exists ? `${to} already exists and will be replaced.` : '',
      };
    }
    if (tool === 'make_dir') {
      return { kind: 'write', destructive: false, danger: false, summary: `new folder: ${abs}`, target: abs, detail: '' };
    }
    if (tool === 'exec_command') {
      const destructive = DESTRUCTIVE.test(String(a.command || ''));
      return {
        kind: 'exec', destructive, danger: destructive,
        summary: `command${destructive ? ' (may be DESTRUCTIVE)' : ''}: ${String(a.command || '').slice(0, 300)}`,
        detail: `folder: ${cwd || bridge.ROOTS[0] || '?'}\n${String(a.command || '')}`,
        target: String(a.command || ''),
        cwd,
      };
    }
    if (tool === 'batch') {
      return { kind: 'batch', destructive: false, danger: false, summary: `batch: ${(a.calls || []).length} calls`, target: `${(a.calls || []).length} calls`, detail: '' };
    }
    return {
      kind: 'read', destructive: false, danger: false,
      summary: [a.query && `"${String(a.query).slice(0, 80)}"`, abs].filter(Boolean).join(' | '),
      target: abs || targetOf(a),
      detail: '',
    };
  }

  function preflight(tool, a) {
    if (cfg.readOnly && kindOf(tool) !== 'read') return 'read-only mode is on';
    if (tool === 'write_file' || tool === 'edit_file' || tool === 'delete_file' || tool === 'make_dir') {
      if (!bridge.gate(a.path)) return `path outside approved roots: ${a.path}`;
    }
    if (tool === 'copy_file' || tool === 'move_file') {
      if (!bridge.gate(a.from)) return `source path outside approved roots: ${a.from}`;
      if (!bridge.gate(a.to)) return `destination path outside approved roots: ${a.to}`;
      if (!fs.existsSync(a.from)) return `no such source: ${a.from}`;
      if (String(a.from).toLowerCase() === String(a.to).toLowerCase()) return 'source and destination are the same';
    }
    if (tool === 'delete_file' && !fs.existsSync(a.path)) return 'no such file';
    if (tool === 'edit_file' && !a.find) return 'find is empty';
    if (tool === 'exec_command') {
      if (!cfg.allowExec) return 'command execution is off';
      if (!String(a.command || '').trim()) return 'command is empty';
      if (a.cwd && !bridge.gate(a.cwd)) return `working folder outside approved roots: ${a.cwd}`;
    }
    return '';
  }

  function prepareArgs(tool, a) {
    const out = { ...a };
    if (tool === 'write_file' && out.path && bridge.gate(out.path) && fs.existsSync(out.path)) {
      out.allowOverwrite = true;
      out.confirm = true;
    } else if (tool === 'delete_file') {
      out.confirm = true;
    } else if (tool === 'copy_file' && out.to && bridge.gate(out.to) && fs.existsSync(out.to)) {
      out.overwrite = true;
      out.confirm = true;
    } else if (tool === 'move_file' && out.to && bridge.gate(out.to) && fs.existsSync(out.to)) {
      out.confirm = true;
    } else if (tool === 'exec_command' && DESTRUCTIVE.test(String(out.command || ''))) {
      out.confirm = true;
    }
    return out;
  }

  async function dispatch(tool, args) {
    const name = String(tool || '').replace(/^pos_/, '');
    if (name === 'batch') return dispatchBatch(args || {});
    const input = args || {};
    const info = describe(name, input);
    const t0 = Date.now();
    let decision = 'auto';
    const blocked = preflight(name, input);
    if (blocked) {
      const res = { ok: false, error: blocked };
      record(name, input, res, Date.now() - t0, 'blocked', info);
      return res;
    }
    if (needsApproval(info, cfg)) {
      const r = await approvals.request(name, input, info);
      if (!r.approved) {
        const res = { ok: false, denied: true, error: `The user did not approve this action: ${r.reason}. Do not retry the same call; ask the user what they want done instead.` };
        record(name, input, res, Date.now() - t0, 'denied', info);
        return res;
      }
      decision = 'approved';
    }
    const changed = preflight(name, input);
    if (changed) {
      const res = { ok: false, error: changed };
      record(name, input, res, Date.now() - t0, 'blocked', info);
      return res;
    }
    let res;
    try {
      res = await bridge.dispatch(name === 'ping' ? 'pos_ping' : name, prepareArgs(name, input));
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    record(name, input, res, Date.now() - t0, decision, info);
    return res;
  }

  async function dispatchBatch(args) {
    if (!Array.isArray(args.calls)) return { ok: false, error: 'calls must be an array' };
    if (!args.calls.length) return { ok: false, error: 'calls is empty' };
    if (args.calls.length > 20) return { ok: false, error: 'at most 20 calls (sequential, not parallel)' };
    const out = [];
    for (const c of args.calls) {
      if (!c || typeof c.tool !== 'string') { out.push({ ok: false, error: 'invalid call' }); continue; }
      const name = c.tool.replace(/^pos_/, '');
      if (name === 'batch') { out.push({ ok: false, error: 'nested batch is not allowed' }); continue; }
      const r = await dispatch(c.tool, c.args || {});
      out.push({ tool: c.tool, ...r });
    }
    return { ok: true, count: out.length, results: out };
  }

  function touch() {
    lastSeen = new Date().toISOString();
    if (Date.now() - lastSaved > 60_000) {
      lastSaved = Date.now();
      try { writeState(); } catch { /* the panel still has it in memory */ }
    }
  }

  function acceptsMcpPath(pathname) {
    return pathname === '/mcp' || pathname === `/mcp/${cfg.secret}`;
  }

  function tunnelView() {
    const t = tunnel.state;
    const base = t.status === 'up' ? t.url : String(cfg.publicUrl || '').replace(/\/+$/, '');
    return {
      ...t,
      connectorUrl: base && cfg.secret ? `${base}/mcp/${cfg.secret}` : '',
      fixed: !!t.stable,
      available: tunnelAvailable(cfg.relayUrl),
      providers: ['relay', 'cloudflared', 'manual'],
      relay: {
        configured: !!cfg.relayUrl,
        active: t.kind === 'relay' && t.status === 'up',
      },
    };
  }

  function restartTunnel() {
    if (!startTunnels) return;
    try { tunnel.stop(); } catch {}
    tunnel = startTunnel({
      mode: cfg.tunnel || 'auto',
      port: mcpPort,
      relayUrl: cfg.relayUrl,
      secret: cfg.secret,
      publicUrl: cfg.publicUrl,
    });
  }

  async function setupRelay() {
    const url = await relaySetup.run();
    if (url) {
      cfg = { ...cfg, relayUrl: url };
      save();
      restartTunnel();
    }
    return { ...relaySetup.state };
  }

  function rotateSecret() {
    cfg = { ...cfg, secret: secret() };
    lastSeen = null;   // the new URL still has to be pasted into Perplexity
    save();
    restartTunnel();
    return config();
  }

  async function snapshot() {
    return {
      ok: true,
      name: 'perplexity-on-steroids',
      version: BRIDGE_VERSION,
      started,
      now: new Date().toISOString(),
      mcpPort,
      panelPort,
      endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
      auth: token ? 'bearer' : 'none',
      tools: bridge.ADVERTISED,
      config: config(),
      activity: activity.slice(-100),
      pending: approvals.list(),
      relaySetup: { ...relaySetup.state, configured: !!cfg.relayUrl },
      lastSeen,
      tunnel: tunnelView(),
    };
  }

  syncBridge();
  save();
  if (startTunnels) restartTunnel();

  return {
    bridge,
    config,
    updateSettings,
    dispatch,
    touch,
    acceptsMcpPath,
    snapshot,
    tunnelView,
    restartTunnel,
    setupRelay,
    rotateSecret,
    approve: (id) => approvals.approve(id),
    deny: (id, why) => approvals.deny(id, why),
    approvals,
    panelKey,
    mcpPort,
    panelPort,
    close: () => { approvals.close(); try { tunnel.stop(); } catch {} },
  };
}

