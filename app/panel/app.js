(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let key = '';
  try {
    const m = location.hash.match(/k=([0-9a-f]{64})/);
    if (m) { key = m[1]; sessionStorage.setItem('pos_k', key); history.replaceState(null, '', location.pathname); }
    else key = sessionStorage.getItem('pos_k') || '';
  } catch { /* no storage */ }

  const S = { data: null, filter: 'all', open: new Set(), busy: false, gate: false };

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
    const ok = todays.filter((e) => e.decision === 'approved' || e.decision === 'auto').length;
    const no = todays.filter((e) => e.decision === 'denied').length;
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
    const cfg = d.config || {};
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

    paintSettings(cfg);
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

  const MODES = {
    readonly: { patch: { readOnly: true, allowExec: false, autoApprove: { write: false, exec: false, destroy: false } }, msg: 'Read-only mode on' },
    files: { patch: { readOnly: false, allowExec: false, autoApprove: { write: false, exec: false, destroy: false } }, msg: 'Commands disabled' },
    ask: { patch: { readOnly: false, allowExec: true, autoApprove: { write: false, exec: false, destroy: false } }, msg: 'Everything will ask again' },
    writes: { patch: { readOnly: false, allowExec: true, autoApprove: { write: true, exec: false, destroy: false } }, msg: 'Writes will run without asking' },
    auto: { patch: { readOnly: false, allowExec: true, autoApprove: { write: true, exec: true, destroy: false } }, msg: 'Unflagged commands will run without asking. This is not a sandbox.' },
    none: { patch: { readOnly: false, allowExec: true, autoApprove: { write: true, exec: true, destroy: true } }, msg: 'No restrictions: nothing will ask' },
  };
  const modeOf = (s) => s.readOnly ? 'readonly' : !s.allowExec ? 'files'
    : s.autoApprove.write ? (s.autoApprove.exec ? (s.autoApprove.destroy ? 'none' : 'auto') : 'writes') : 'ask';

  function paintSettings(cfg) {
    const ul = $('roots');
    ul.textContent = '';
    for (const root of cfg.roots || []) {
      const li = h('li');
      const name = root.split(/[\\/]/).filter(Boolean).pop() || root;
      li.append(h('b', null, name), h('code', null, root));
      const b = h('button', 'btn sm', 'Remove');
      b.type = 'button';
      b.disabled = (cfg.roots || []).length < 2;
      b.addEventListener('click', () => saveSettings({ roots: cfg.roots.filter((r) => r !== root) }, 'Folder removed'));
      li.append(b);
      ul.append(li);
    }
    if (!(cfg.roots || []).length) ul.append(h('li', 'empty', 'No folders approved. Perplexity cannot reach any file.'));
    const mode = modeOf(cfg);
    for (const b of $('permModes').children) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  }

  function statusChip(e) {
    const c = h('span', 'st-c');
    c.append(h('span', 'dot'));
    if (e.status === 'denied') { c.dataset.tone = 'bad'; c.append('Denied'); }
    else if (e.status === 'error') { c.dataset.tone = 'bad'; c.append('Error'); }
    else if (e.status === 'pending') { c.dataset.tone = 'wait'; c.append('Waiting'); }
    else { c.dataset.tone = 'ok'; c.append(e.decision === 'approved' ? 'Approved' : 'Auto'); }
    return c;
  }

  function paintBoard(d) {
    const body = $('board');
    body.textContent = '';
    let rows = (d.activity || []).slice().reverse();
    if (S.filter === 'read' || S.filter === 'write' || S.filter === 'exec') rows = rows.filter((e) => e.kind === S.filter || (S.filter === 'write' && e.kind === 'delete'));
    if (S.filter === 'error') rows = rows.filter((e) => e.status === 'error' || e.status === 'denied' || e.status === 'pending');
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
      const tr = h('tr', 'row' + (e.status === 'denied' ? ' void' : ''));
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
        if (e.summary) { box.append(h('span', 'lbl', 'Summary')); box.append(h('span', 'val', e.summary)); }
        if (e.args) { box.append(h('span', 'lbl', 'Arguments')); box.append(h('span', 'val', e.args)); }
        const msg = e.error || e.note;
        if (msg) {
          box.append(h('span', 'lbl', e.error ? 'Error' : 'Preview'));
          box.append(h('span', 'val' + (e.error ? ' err' : ''), msg));
        }
        if (!e.args && !msg) box.append(h('span', 'val', 'No details recorded.'));
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

  const REQ = {
    write_file: (i) => i.isNew ? 'Write a new file' : 'Overwrite a file',
    edit_file: () => 'Edit a file',
    delete_file: () => 'Delete',
    copy_file: (i) => i.danger ? 'Overwrite by copy' : 'Copy',
    move_file: (i) => i.danger ? 'Replace by move' : 'Move',
    make_dir: () => 'Create a folder',
    exec_command: (i) => i.destructive ? 'Run a destructive command' : 'Run a command',
  };

  function paintReqs(d) {
    const box = $('reqs');
    box.textContent = '';
    box.className = '';
    const list = [...(d.pending || [])].sort((a, b) => a.at - b.at);
    if (!list.length) {
      const s = d.config || {};
      const auto = [s.autoApprove?.write && 'writes', s.autoApprove?.exec && s.allowExec && 'unflagged commands (not sandboxed)'].filter(Boolean);
      const idle = h('div', 'idle');
      idle.append(flapEl('Nothing pending', false), h('p', null,
        s.readOnly ? 'Read-only mode is on: Perplexity can only read.'
          : !s.allowExec ? 'Commands are off. Write requests wait for you here.'
          : s.autoApprove?.destroy ? 'No restrictions: writes, commands and deletes all run without asking.'
          : auto.length ? `Done without asking: ${auto.join(' and ')}. Deletes always ask.`
          : 'Write and command requests wait for you here.'));
      box.append(idle);
      return;
    }
    box.className = 'reqs';
    list.forEach((p) => {
      const i = p.info || {};
      const danger = p.tool === 'delete_file' || i.destructive || i.danger;
      const title = (REQ[p.tool] || (() => p.tool))(i);
      const card = h('article', 'req' + (danger ? ' danger' : ''));
      card.setAttribute('aria-label', title);
      const top = h('div', 'req-top');
      const hbox = h('div', 'grow');
      hbox.append(h('h3', null, title));
      const chips = h('div');
      chips.style.cssText = 'display:flex;gap:8px;margin-top:9px;flex-wrap:wrap';
      const kindChip = h('span', 'chip', KIND[i.kind] || 'TOOL');
      kindChip.dataset.tone = danger ? 'bad' : 'wait';
      chips.append(kindChip);
      if (i.destructive) { const d2 = h('span', 'chip', 'Destructive'); d2.dataset.tone = 'bad'; chips.append(d2); }
      hbox.append(chips);
      top.append(hbox);
      const left = h('div', 'left');
      const lf = h('span', 'flaps amber'); lf.dataset.exp = p.expiresAt;
      left.append(lf, h('small', null, 'seconds left'));
      top.append(left);
      card.append(top);

      if (p.tool === 'exec_command') {
        card.append(h('pre', 'cmd', i.target || ''));
        if (i.cwd) card.append(h('p', 'note', `folder: ${i.cwd}`));
      } else {
        card.append(h('p', 'path', i.target || ''));
        if (i.extra) card.append(h('p', 'note', i.extra));
        if (p.tool === 'edit_file') {
          const diff = h('div', 'diff');
          const was = h('div', 'was'); was.append(h('span', 'tag', 'Current'), h('pre', null, i.before || ''));
          const now = h('div', 'now'); now.append(h('span', 'tag', 'After'), h('pre', null, i.after || ''));
          diff.append(was, now); card.append(diff);
        } else if (i.detail) {
          card.append(h('pre', null, i.detail));
        }
        if (p.tool === 'delete_file') card.append(h('p', 'note', 'The deleted file cannot be brought back.'));
      }

      const acts = h('div', 'acts');
      const yes = h('button', 'btn go', p.tool === 'delete_file' ? 'Allow delete' : p.tool === 'exec_command' ? 'Run it' : 'Approve');
      const no = h('button', 'btn no', 'Deny');
      yes.type = no.type = 'button';
      yes.onclick = async () => { yes.disabled = no.disabled = true; await api('/api/approve', { id: p.id }); await load(); };
      no.onclick = async () => { yes.disabled = no.disabled = true; await api('/api/deny', { id: p.id }); await load(); };
      acts.append(yes, no);
      card.append(acts);
      const bar = h('div', 'bar');
      bar.style.animationDuration = `${p.expiresAt - p.at}ms`;
      bar.style.animationDelay = `-${Date.now() - p.at}ms`;
      card.append(bar);
      box.append(card);
    });
    tickLeft();
  }

  function tickLeft() {
    for (const n of document.querySelectorAll('.req .left .flaps')) {
      flaps(n, String(Math.max(0, Math.round((Number(n.dataset.exp) - Date.now()) / 1000))).padStart(3, '0'), false);
    }
  }

  function render() {
    const d = S.data;
    if (!d || !d.ok) return;
    $('gate').hidden = true;
    $('app').hidden = false;
    paintTop(d);
    paintConnector(d);
    paintReqs(d);
    paintBoard(d);
    paintGuide();
  }

  async function saveSettings(patch, message) {
    if (S.busy || !S.data) return false;
    S.busy = true;
    try {
      const r = await api('/api/settings', patch);
      if (!r.ok) { toast(r.error || 'Could not save', true); return false; }
      S.data = { ...S.data, config: r.config };
      render();
      toast(message || 'Saved');
      return true;
    } catch (e) {
      toast(e.message || 'Could not save', true);
      return false;
    } finally {
      S.busy = false;
    }
  }

  async function load() {
    if (S.gate || S.busy) return;
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

  $('addRoot').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('rootIn');
    const next = input.value.trim();
    if (!next || !S.data) return;
    const roots = [...(S.data.config.roots || []), next];
    const ok = await saveSettings({ roots }, 'Folder added');
    if (ok) input.value = '';
  });

  for (const b of $('permModes').children) {
    b.addEventListener('click', () => saveSettings(MODES[b.dataset.mode].patch, MODES[b.dataset.mode].msg));
  }
  const modeKeys = {};
  [...$('permModes').children].forEach((b, i) => { modeKeys[String(i + 1)] = b; });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const b = modeKeys[e.key];
    if (!b) return;
    e.preventDefault();
    b.click();
  });

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
  setInterval(tickLeft, 1000);
  setInterval(() => { if (!guide.open) load(); }, 2000);
  tickClock();
  load();
})();
