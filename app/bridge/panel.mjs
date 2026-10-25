// Local panel: a read-and-configure window on the bridge. Loopback only, and
// every API call carries the per-run panel key printed at start.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'panel');
export const PANEL_FILE = path.join(os.tmpdir(), 'pos-panel.url');

const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 65_536) { req.destroy(); reject(new Error('request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function openBrowser(url) {
  if (process.env.POS_NO_OPEN) return;
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { /* no browser, the URL is printed */ }
}

export function startPanel({ runtime, port }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const host = req.headers.host || '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { json(res, 403, { ok: false, error: 'wrong host' }); return; }
      const url = new URL(req.url, `http://${host}`);
      const auth = req.headers['x-panel-key'] || url.searchParams.get('k') || '';
      const keyed = auth === runtime.panelKey;

      if (req.method === 'GET' && ASSETS[url.pathname]) {
        const [file, type] = ASSETS[url.pathname];
        try {
          send(res, 200, fs.readFileSync(path.join(UI, file)), type);
        } catch {
          json(res, 500, { ok: false, error: 'panel files are missing' });
        }
        return;
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        if (!keyed) { json(res, 401, { ok: false, error: 'missing or wrong panel key' }); return; }
        json(res, 200, await runtime.snapshot());
        return;
      }

      if (url.pathname === '/api/settings' && req.method === 'POST') {
        if (!keyed) { json(res, 401, { ok: false, error: 'missing or wrong panel key' }); return; }
        try {
          const body = await readBody(req);
          json(res, 200, runtime.updateSettings(body));
        } catch (e) {
          json(res, 400, { ok: false, error: e.message });
        }
        return;
      }

      if (url.pathname === '/api/tunnel') {
        if (!keyed) { json(res, 401, { ok: false, error: 'missing or wrong panel key' }); return; }
        json(res, 200, { ok: true, ...runtime.tunnelView() });
        return;
      }

      if (url.pathname === '/api/tunnel/restart' && req.method === 'POST') {
        if (!keyed) { json(res, 401, { ok: false, error: 'missing or wrong panel key' }); return; }
        runtime.restartTunnel();
        json(res, 200, { ok: true, tunnel: runtime.tunnelView() });
        return;
      }

      if (url.pathname === '/api/relay/setup' && req.method === 'POST') {
        if (!keyed) { json(res, 401, { ok: false, error: 'missing or wrong panel key' }); return; }
        runtime.setupRelay().catch(() => {});
        json(res, 202, { ok: true });
        return;
      }

      if (url.pathname === '/api/secret/rotate' && req.method === 'POST') {
        if (!keyed) { json(res, 401, { ok: false, error: 'missing or wrong panel key' }); return; }
        runtime.rotateSecret();
        json(res, 200, { ok: true, tunnel: runtime.tunnelView() });
        return;
      }

      json(res, 404, { ok: false, error: 'not found' });
    });

    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const panelUrl = `http://127.0.0.1:${port}/#k=${runtime.panelKey}`;
      try { fs.writeFileSync(PANEL_FILE, panelUrl + '\n'); } catch { /* temp unavailable */ }
      const cleanup = () => {
        try {
          if (fs.readFileSync(PANEL_FILE, 'utf8').trim() === panelUrl) fs.unlinkSync(PANEL_FILE);
        } catch { /* already gone */ }
      };
      process.once('exit', cleanup);
      openBrowser(panelUrl);
      resolve({ server, url: panelUrl });
    });
  });
}
