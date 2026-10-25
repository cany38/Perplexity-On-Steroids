import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBridge, BRIDGE_VERSION, DATA } from './tools.mjs';
import { createLog } from './log.mjs';
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

function integer(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function secret() {
  return crypto.randomBytes(32).toString('hex');
}

// Folder and permission settings of older versions, dropped from config.json on load.
const RETIRED = ['roots', 'readOnly', 'allowExec', 'allowDestructive', 'autoApprove', 'approvalTimeoutMs'];

export function createRuntime({ configPath, mcpPort, panelPort, token, tunnel: startTunnels = true, dataDir = DATA }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'state.json');
  let diskState = {};
  try { diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const bridge = createBridge(configPath);
  let cfg = {
    ...bridge.cfg,
    tunnel: bridge.cfg.tunnel || 'auto',
    publicUrl: bridge.cfg.publicUrl || '',
    relayUrl: diskState.relayUrl || bridge.cfg.relayUrl || '',
  };
  for (const k of RETIRED) delete cfg[k];
  cfg.secret = /^[0-9a-f]{64}$/.test(String(diskState.secret || '')) ? diskState.secret
    : /^[0-9a-f]{64}$/.test(String(bridge.cfg.secret || '')) ? bridge.cfg.secret : secret();

  const activity = [];
  const started = new Date().toISOString();
  const panelKey = crypto.randomBytes(32).toString('hex');
  const log = createLog(path.join(dataDir, 'calls.jsonl'));
  const relaySetup = createRelaySetup();
  // Last request that came through the relay or tunnel. Saved with the state so
  // the panel still knows Perplexity is connected after a restart.
  let lastSeen = diskState.lastSeen || null;
  let lastSaved = 0;
  let tunnel = { state: { kind: null, status: 'off', url: '', error: '', detail: '', hint: '', stable: false }, stop() {} };

  function config() {
    return {
      home: bridge.HOME,
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
    fs.writeFileSync(configPath, JSON.stringify(disk, null, 2) + '\n');
    writeState();
    bridge.cfg = cfg;
  }

  function writeState() {
    fs.writeFileSync(stateFile, JSON.stringify({ secret: cfg.secret, relayUrl: cfg.relayUrl, lastSeen }, null, 2) + '\n', { mode: 0o600 });
  }

  save();

  function syncBridge() {
    bridge.state.maxOutputBytes = cfg.maxOutputBytes || bridge.state.maxOutputBytes;
    bridge.state.execTimeoutMs = cfg.execTimeoutMs || bridge.state.execTimeoutMs;
  }

  function updateSettings(patch = {}) {
    const next = config();
    if (patch.maxOutputBytes !== undefined) next.maxOutputBytes = integer(patch.maxOutputBytes, 'maxOutputBytes', 1000, 5_000_000);
    if (patch.execTimeoutMs !== undefined) next.execTimeoutMs = integer(patch.execTimeoutMs, 'execTimeoutMs', 1000, 900_000);
    if (patch.publicUrl !== undefined) next.publicUrl = String(patch.publicUrl || '').trim();
    if (patch.tunnel !== undefined) {
      if (!['auto', 'relay', 'cloudflared', 'manual', 'none'].includes(patch.tunnel)) throw new Error('unknown tunnel mode');
      next.tunnel = patch.tunnel;
    }

    cfg = {
      ...cfg,
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

  function record(tool, args, res, ms) {
    const short = String(tool || '').replace(/^pos_/, '');
    const row = {
      t: new Date().toISOString(),
      tool: short,
      kind: kindOf(short),
      target: clip(targetOf(args), 300),
      args: previewOf(args),
      status: res && res.ok ? 'ok' : 'error',
      ms: Math.round(ms),
      error: res && !res.ok ? clip(res.error || 'failed') : '',
    };
    activity.push(row);
    if (activity.length > 200) activity.shift();
    log.record({ ...row, ok: !!res?.ok });
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

  async function dispatch(tool, args) {
    const name = String(tool || '').replace(/^pos_/, '');
    if (name === 'batch') return dispatchBatch(args || {});
    const input = args || {};
    const t0 = Date.now();
    let res;
    try {
      res = await bridge.dispatch(name === 'ping' ? 'pos_ping' : name, input);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    record(name, input, res, Date.now() - t0);
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

  // Only /mcp/<secret> answers. A bare /mcp would let any web page open in this
  // browser reach the tools through 127.0.0.1.
  function acceptsMcpPath(pathname) {
    const m = String(pathname).match(/^\/mcp\/([0-9a-f]{64})\/?$/);
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(String(cfg.secret));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
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
      endpoint: `http://127.0.0.1:${mcpPort}/mcp/<secret>`,
      auth: token ? 'bearer' : 'none',
      tools: bridge.ADVERTISED,
      config: config(),
      activity: activity.slice(-100),
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
    log,
    panelKey,
    mcpPort,
    panelPort,
    close: () => { try { tunnel.stop(); } catch {} },
  };
}

