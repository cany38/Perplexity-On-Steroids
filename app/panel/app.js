(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let key = '';
  try {
    const m = location.hash.match(/k=([0-9a-f]{64})/);
    if (m) { key = m[1]; sessionStorage.setItem('pos_k', key); history.replaceState(null, '', location.pathname); }
    else key = sessionStorage.getItem('pos_k') || '';
  } catch { /* no storage */ }

  const S = { data: null, filter: 'all', open: new Set(), gate: false };

  const api = async (path, body) => {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Panel-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (r.status === 401) showGate();
    return j;
  };

  const showGate = () => {
    S.gate = true;
    $('app').hidden = true;
    $('gate').hidden = false;
  };

  let toastT;
  const toast = (msg, bad) => {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 2400);
  };

  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const upper = (s) => String(s).toLocaleUpperCase('en');
  const ago = (iso) => {
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString('en-GB');
  };
  const dur = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

  const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function flaps(el, text, cascade) {
    const chars = [...upper(text)];
    const cells = [...el.children];
    while (cells.length < chars.length) { const c = h('span'); el.append(c); cells.push(c); }
    while (cells.length > chars.length) cells.pop().remove();
    chars.forEach((ch, i) => {
      const c = cells[i];
      const gap = ch === ' ';
      c.className = gap ? 'gap' : '';
      const had = c.textContent;
      if (had === ch) return;
      if (!cascade || gap) {
        c.textContent = ch;
        if (had && !gap) { c.classList.remove('flip'); void c.offsetWidth; c.classList.add('flip'); }
        return;
      }
      let n = 3 + i;
      const tick = () => {
        if (n-- <= 0) { c.textContent = ch; return; }
        c.textContent = ALPH[(Math.random() * ALPH.length) | 0];
        c.classList.remove('flip'); void c.offsetWidth; c.classList.add('flip');
        setTimeout(tick, 45);
      };
      tick();
    });
    el.setAttribute('aria-label', text);
  }
  const flapEl = (text, cascade, cls) => {
    const s = h('span', 'flaps' + (cls ? ' ' + cls : ''));
    flaps(s, text, cascade);
    return s;
  };

  const KIND = { read: 'READ', write: 'WRITE', delete: 'DEL', exec: 'CMD', batch: 'BATCH', other: 'TOOL' };
  const VERB = {
    ping: 'checked bridge', list_dir: 'listed', read_file: 'read', search: 'searched',
    write_file: 'wrote', edit_file: 'edited', delete_file: 'deleted', copy_file: 'copied',
    move_file: 'moved', make_dir: 'created folder', exec_command: 'ran', batch: 'ran batch',
    list_sessions: 'listed sessions', session_log: 'read session',
  };

  function copyText(text) {
    if (!text) return;
    const done = () => toast('Copied');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {
        const ta = h('textarea');
        ta.value = text;
        document.body.append(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch { toast('Could not copy', true); }
        ta.remove();
      });
      return;
    }
    const ta = h('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('Could not copy', true); }
    ta.remove();
  }

  function paintTop(d) {
    const tun = d.tunnel || {};
    const up = tun.status === 'up';
    const last = d.lastSeen ? new Date(d.lastSeen) : null;
    const fresh = last && Date.now() - last.getTime() < 120_000;
    // Perplexity sends nothing while idle, so "connected" means it has reached
    // this server at least once; the meta line says when it last did.
    const connected = !!last && up;

    let state = 'No tunnel';
    let lamp = 'bad';
    let meta = tun.error || 'Set up a permanent address';
    if (connected) { state = 'Perplexity connected'; lamp = 'on'; meta = fresh ? 'active now' : `last call ${ago(last)}`; }
    else if (up) { state = 'Waiting for Perplexity'; lamp = 'wait'; meta = tun.url; }
    else if (fresh) { meta = `last local call ${ago(last)}`; }

    $('connState').textContent = state;
    $('connMeta').textContent = meta;
    $('lamp').className = 'lamp ' + lamp;

    const today = new Date().toDateString();
    const todays = (d.activity || []).filter((e) => new Date(e.t).toDateString() === today);
    const ok = todays.filter((e) => e.status === 'ok').length;
    const no = todays.length - ok;
    flaps($('nCalls'), String(todays.length).padStart(2, '0'));
    flaps($('nOk'), String(ok).padStart(2, '0'));
    flaps($('nNo'), String(no).padStart(2, '0'));
    document.title = connected ? 'Perplexity connected | Perplexity On Steroids' : 'Perplexity On Steroids';
  }

  const providerName = (id) => ({ relay: 'Cloudflare relay', cloudflared: 'Cloudflare quick tunnel', manual: 'Manual address' }[id] || id || 'tunnel');

  function paintConnector(d) {
    const tun = d.tunnel || {};
    const up = tun.status === 'up';
    const url = tun.connectorUrl || '';
    const last = d.lastSeen ? new Date(d.lastSeen) : null;
    const connected = !!last && up;
    const permanent = !!tun.relay?.active;

    $('mcpUrl').textContent = url || (tun.status === 'error' ? `No URL yet: ${tun.error || 'the tunnel could not open.'}`
      : tun.status === 'starting' ? (tun.hint || `Opening ${providerName(tun.kind)}...`) : 'The permanent URL appears here after Cloudflare setup.');
    $('mcpUrl').classList.toggle('none', !url);
    $('mcpCopy').disabled = !url;
    $('mcpState').textContent = url ? (permanent ? 'Permanent' : tun.fixed ? 'Fixed' : 'Temporary')
      : tun.status === 'error' ? 'Tunnel error' : tun.status === 'starting' ? 'Opening tunnel' : 'Waiting for tunnel';
    $('mcpState').dataset.tone = url ? 'ok' : tun.status === 'error' ? 'bad' : 'wait';
    $('mcpNote').textContent = url ? (permanent ? 'Permanent address on your own Cloudflare relay. Paste it once.'
      : tun.fixed ? 'Fixed address.' : 'Temporary address: it changes on restart.') : '';
    paintPerm();

    const steps = [
      ['s1', url ? 'Done' : tun.status === 'starting' ? 'Opening' : 'Next', url ? 'ok' : 'wait'],
      ['s2', connected ? 'Done' : url ? 'Ready' : 'Waiting', connected ? 'ok' : url ? 'info' : ''],
      ['s3', connected ? 'Done' : 'Waiting', connected ? 'ok' : ''],
    ];
    for (const [id, text, tone] of steps) {
      const el = $(id);
      el.textContent = text;
      if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
    }
    $('s1p').textContent = url ? `Public address: ${tun.url}` : 'Set up the permanent Cloudflare address once.';

    $('kSrv').textContent = `running | MCP ${d.mcpPort} | panel ${d.panelPort}`;
    $('kTun').textContent = up ? `${tun.kind} | ${tun.url}` : (tun.error || 'off');
    $('kCli').textContent = d.lastSeen ? (up ? ago(d.lastSeen) : `no tunnel, last local call ${ago(d.lastSeen)}`) : 'no request yet';
    $('kAuth').textContent = d.auth === 'bearer' ? 'Bearer token' : 'none';
    $('kEnd').textContent = d.endpoint;
    $('tunErr').hidden = !(tun.status === 'error' && tun.error);
    if (tun.status === 'error' && tun.error) $('tunErr').textContent = tun.error;

    $('files').textContent = `${(d.tools || []).length} tools | server ${d.version} | panel 127.0.0.1:${d.panelPort}`;
  }

  function paintPerm() {
    const r = S.data?.relaySetup || { step: 'idle' };
    const t = S.data?.tunnel || {};
    const relay = t.relay || {};
    const busy = ['checking', 'login', 'deploying'].includes(r.step);
    const waiting = relay.configured && !relay.active && !busy;
    // Keep the Cloudflare connection block always visible: idle, running,
    // failed, waiting for activation, or connected. Connected only changes
    // the message, it never hides the block.
    $('perm').hidden = false;
    const btn = $('permBtn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Setting up...' : r.step === 'error' ? 'Try again' : 'Get a permanent address';
    btn.hidden = !!relay.configured && r.step !== 'error';
    const msg = $('permMsg');
    msg.className = 'perm-msg' + (r.step === 'error' ? ' bad' : relay.active ? ' ok' : '');
    msg.textContent = busy ? (r.message || 'Setting up...')
      : r.step === 'error' ? r.error
      : relay.active ? 'Connected to your relay. This is your permanent address; paste it into Perplexity once and it will not change again.'
      : waiting ? 'Your permanent address is set up. Cloudflare is still activating it; the panel switches to it by itself.'
      : 'One sign-in to a free Cloudflare account, and the URL never changes again.';
    $('permLink').hidden = !(r.step === 'login' && r.loginUrl);
    if (r.loginUrl) $('permHref').href = r.loginUrl;
  }

  function statusChip(e) {
    const c = h('span', 'st-c');
    c.append(h('span', 'dot'));
    if (e.status === 'error') { c.dataset.tone = 'bad'; c.append('Error'); }
    else { c.dataset.tone = 'ok'; c.append('Done'); }
    return c;
  }

  function paintBoard(d) {
    const body = $('board');
    body.textContent = '';
    let rows = (d.activity || []).slice().reverse();
    if (S.filter === 'read' || S.filter === 'write' || S.filter === 'exec') rows = rows.filter((e) => e.kind === S.filter || (S.filter === 'write' && e.kind === 'delete'));
    if (S.filter === 'error') rows = rows.filter((e) => e.status === 'error');
    rows = rows.slice(0, 60);

    if (!rows.length) {
      const tr = h('tr', 'empty');
      const td = h('td');
      td.colSpan = 6;
      td.append(h('b', null, S.filter === 'all' ? 'No calls yet' : 'Nothing in this filter'));
      td.append(h('span', null, S.filter === 'all' ? 'When Perplexity uses a tool, it shows up here with the path or command it touched.' : 'Try another filter.'));
      tr.append(td);
      body.append(tr);
      return;
    }

    for (const e of rows) {
      const id = `${e.t}|${e.tool}|${e.ms}`;
      const tr = h('tr', 'row');
      tr.tabIndex = 0;

      const time = h('td', 'time');
      time.append(flapEl(new Date(e.t).toLocaleTimeString('en-GB', { hour12: false }), false));
      tr.append(time);

      const kind = h('td', 'kind');
      const k = h('span', 'flaps kind-k');
      k.dataset.k = e.kind;
      flaps(k, KIND[e.kind] || 'TOOL');
      kind.append(k);
      tr.append(kind);

      tr.append(h('td', 'verb', VERB[e.tool] || e.tool));
      const target = h('td', 'tgt', e.target || '');
      target.title = e.target || '';
      tr.append(target);

      const st = h('td', 'st');
      st.append(statusChip(e));
      tr.append(st);

      tr.append(h('td', 'ms', dur(e.ms)));
      body.append(tr);

      if (S.open.has(id)) {
        const more = h('tr', 'more');
        const td = h('td');
        td.colSpan = 6;
        const box = h('div', 'more-in');
        if (e.args) { box.append(h('span', 'lbl', 'Arguments')); box.append(h('span', 'val', e.args)); }
        if (e.error) { box.append(h('span', 'lbl', 'Error')); box.append(h('span', 'val err', e.error)); }
        if (!e.args && !e.error) box.append(h('span', 'val', 'No details recorded.'));
        td.append(box);
        more.append(td);
        body.append(more);
      }

      const toggle = () => {
        if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
        paintBoard(S.data);
      };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      });
    }
  }

  function render() {
    const d = S.data;
    if (!d || !d.ok) return;
    $('gate').hidden = true;
    $('app').hidden = false;
    paintTop(d);
    paintConnector(d);
    paintBoard(d);
    paintGuide();
  }

  async function load() {
    if (S.gate) return;
    try {
      const d = await api('/api/state');
      if (!d || !d.ok) throw new Error(d && d.error ? d.error : 'offline');
      S.data = d;
      render();
    } catch (e) {
      $('app').hidden = false;
      $('connState').textContent = 'Server offline';
      $('connMeta').textContent = e && e.message ? e.message : 'Waiting for the bridge';
      $('lamp').className = 'lamp bad';
    }
  }

  function paintGuide() {
    const url = S.data?.tunnel?.connectorUrl;
    $('gUrl').textContent = url || 'The URL appears here after Cloudflare setup.';
    $('gCopy').disabled = !url;
    $('g1').classList.toggle('done', !!url);
    for (const id of ['g2', 'g3', 'g4']) $(id).classList.toggle('done', !!S.data?.lastSeen);
    $('g5').classList.toggle('done', !!S.data?.tunnel?.relay?.active);
  }

  $('mcpCopy').addEventListener('click', () => copyText((S.data && S.data.tunnel && S.data.tunnel.connectorUrl) || ''));
  $('gCopy').addEventListener('click', () => copyText((S.data && S.data.tunnel && S.data.tunnel.connectorUrl) || ''));

  document.querySelectorAll('.filters button').forEach((b) => {
    b.addEventListener('click', () => {
      S.filter = b.dataset.f;
      document.querySelectorAll('.filters button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (S.data) paintBoard(S.data);
    });
  });

  const guide = $('guide');
  $('guideBtn').addEventListener('click', () => guide.showModal());
  $('guideClose').addEventListener('click', () => guide.close());
  guide.addEventListener('click', (ev) => { if (ev.target === guide) guide.close(); });

  $('permBtn').addEventListener('click', async () => {
    $('permBtn').disabled = true;
    const r = await api('/api/relay/setup', {});
    if (!r.ok) toast(r.error || 'Could not start Cloudflare setup', true);
    else toast('Cloudflare setup started');
    await load();
  });

  $('restart').addEventListener('click', async () => {
    const r = await api('/api/tunnel/restart', {});
    if (r.tunnel) S.data.tunnel = r.tunnel;
    toast(r.ok ? 'Restarting the tunnel' : (r.error || 'Could not restart'), !r.ok);
    await load();
  });

  $('rotate').addEventListener('click', async () => {
    if (!confirm('Rotate the connector URL? The old URL stops working and you must paste the new one into Perplexity.')) return;
    const r = await api('/api/secret/rotate', {});
    toast(r.ok ? 'Address rotated. Copy the new URL.' : (r.error || 'Could not rotate'), !r.ok);
    await load();
  });

  function tickClock() {
    flaps($('clock'), new Date().toLocaleTimeString('en-GB', { hour12: false }));
  }

  setInterval(tickClock, 1000);
  setInterval(() => { if (!guide.open) load(); }, 2000);
  tickClock();
  load();
})();
