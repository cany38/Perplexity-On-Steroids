import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DATA } from './tools.mjs';
import { connectRelay } from './relay.mjs';

// The panel asks for this every 2 s, so the PATH lookup is cached for a minute.
// windowsHide: the server runs without a console, and an unhidden `where` would
// flash a cmd window on every lookup.
let found = { at: 0, path: null };
export function findCloudflared() {
  const local = path.join(DATA, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(local)) return local;
  if (Date.now() - found.at < 60_000) return found.path;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
  found = { at: Date.now(), path: r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean)?.trim() || null : null };
  return found.path;
}

export function tunnelAvailable(relayUrl) {
  return { relay: !!relayUrl, cloudflared: !!findCloudflared() };
}

const firstUrl = (re) => (text) => {
  for (const line of String(text).split('\n')) {
    if (/failed|error|warn/i.test(line)) continue;
    const m = line.match(re);
    if (m) return m;
  }
  return null;
};

export function startTunnel({ mode = 'auto', port, relayUrl = '', secret = '', publicUrl = '' }) {
  const ev = new EventEmitter();
  const state = { kind: null, status: 'off', url: '', error: '', detail: '', hint: '', stable: false };
  const set = (patch) => { Object.assign(state, patch); ev.emit('change', { ...state }); };
  let child = null;
  let stopped = false;

  const bin = findCloudflared();
  const manual = String(publicUrl || '').replace(/\/+$/, '');
  const auto = [];
  if (relayUrl && secret) auto.push('relay');
  if (bin) auto.push('cloudflared');
  if (manual) auto.push('manual');
  const list = mode === 'none' ? [] : mode === 'auto' ? auto : [mode].filter((k) => (k === 'relay' ? relayUrl && secret : k === 'cloudflared' ? bin : k === 'manual' ? manual : false));

  if (!list.length) {
    set({ status: 'off', error: mode === 'none' ? '' : 'No tunnel is configured. Set up a permanent address in the panel.' });
    return { ev, state, stop() {} };
  }

  let lastError = '';
  let lastDetail = '';

  const launch = (i) => {
    if (stopped) return;
    if (i >= list.length) {
      set({ status: 'error', error: lastError || 'the tunnel could not be opened', detail: lastDetail });
      return;
    }
    const kind = list[i];

    if (kind === 'manual') {
      set({ kind: 'manual', status: 'up', url: manual, stable: true, error: '', detail: '', hint: '' });
      return;
    }
    if (kind === 'relay') return launchRelay(i);

    set({ kind, status: 'starting', url: '', error: '', detail: '', hint: '', stable: false });
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let searchBuf = '';
    let reconnects = 0;

    const next = (msg) => {
      lastError = msg;
      lastDetail = tail.slice(-800);
      if (i + 1 < list.length) launch(i + 1);
      else set({ status: 'error', error: lastError, detail: lastDetail });
    };

    const startTimer = setTimeout(() => {
      if (state.status !== 'starting' || state.kind !== kind) return;
      try { child.kill(); } catch {}
      next('Cloudflare did not return an address within 30 s.');
    }, 30_000);

    const onData = (buf) => {
      const text = buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
      const seen = searchBuf + text;
      searchBuf = seen.slice(-2000);
      tail = (tail + text).slice(-4000);
      if (state.status !== 'starting') return;
      const m = firstUrl(/(https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com)/i)(seen);
      if (m) {
        clearTimeout(startTimer);
        set({ status: 'up', url: m[1], hint: '', stable: false });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => next(`Cloudflare could not start: ${e.message}`));
    child.on('exit', (code) => {
      clearTimeout(startTimer);
      if (stopped || state.status === 'error' || state.kind !== kind) return;
      if (state.status === 'up' && reconnects < 3) {
        reconnects++;
        set({ status: 'starting', url: '', hint: `Cloudflare dropped; reconnecting (${reconnects}/3)...` });
        setTimeout(() => launch(i), 2000);
        return;
      }
      next(state.status === 'up' ? `Cloudflare kept dropping (code ${code}).` : `Cloudflare stopped (code ${code}).`);
    });
  };

  const launchRelay = (i) => {
    let opened = false;
    let r = null;
    const next = (msg) => {
      if (stopped) return;
      lastError = msg;
      lastDetail = '';
      if (i + 1 < list.length) launch(i + 1);
      else set({ status: 'error', error: msg, detail: '' });
    };
    const timer = setTimeout(() => {
      if (opened) return;
      r?.stop();
      next('The relay did not answer within 15 s.');
    }, 15_000);
    r = connectRelay({
      relayUrl, secret, port,
      onUp: (url) => {
        if (stopped) return;
        opened = true;
        clearTimeout(timer);
        set({ status: 'up', url, error: '', hint: '', stable: true });
      },
      onDown: (why, gaveUp) => {
        if (stopped) return;
        if (gaveUp) { clearTimeout(timer); r?.stop(); next(`Relay: ${why}`); return; }
        set({ status: 'starting', url: '', hint: `Relay reconnecting (${why})...` });
      },
    });
    child = { kill() { clearTimeout(timer); r?.stop(); } };
  };

  set({ kind: list[0], status: 'starting' });
  launch(0);

  return {
    ev,
    state,
    stop() { stopped = true; try { child && child.kill(); } catch {} },
  };
}
