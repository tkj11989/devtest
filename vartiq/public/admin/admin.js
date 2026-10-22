/* VartiQ admin dashboard. Plain JS; every piece of text from the server is shown with textContent (never as HTML). */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }, del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } } };
  const state = { token: store.get('admin.token'), admin: null, settings: null, features: [] };

  /** h('div', { class: 'x', onclick }, 'text', childNode, ...) */
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }

  async function api(method, path, body) {
    const res = await fetch(`/admin/api${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.status === 401 && state.token) { signedOut('Your session ended. Sign in again.'); throw new Error('Signed out'); }
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || 'Something went wrong'), { code: data?.error?.code });
    return data;
  }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }
  const attempt = async (fn) => { try { return await fn(); } catch (err) { if (err.message !== 'Signed out') toast(err.message); return null; } };

  const fmt = {
    n: (x) => Number(x).toLocaleString(),
    date: (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
    bytes: (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`),
    ago: (ts) => { if (!ts) return 'never'; const s = Math.round((Date.now() - ts) / 1000); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; },
    uptime: (s) => (s > 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s > 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`),
  };
  const isSuper = () => state.admin?.role === 'super';

  // ---------- sign in ----------

  function signedOut(message) {
    state.token = null;
    state.admin = null;
    store.del('admin.token');
    $('#shell').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#login-error').textContent = message || '';
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#login-error').textContent = '';
    try {
      const res = await api('POST', '/login', { username: f.username.value, password: f.password.value });
      state.token = res.token;
      state.admin = res.admin;
      store.set('admin.token', res.token);
      f.reset();
      start();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api('POST', '/logout').catch(() => {});
    signedOut('');
  });

  // ---------- pages ----------

  /** Payments received (Razorpay), newest first, with what came in. */
  async function payments() {
    const { payments: list, totals } = await api('GET', '/payments');
    const tile = (label, n) => h('div', { class: 'tile' }, h('div', { class: 'n' }, typeof n === 'number' ? fmt.n(n) : n), h('div', { class: 'l' }, label));
    const money = (cur, v) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(v); } catch { return `${cur} ${v}`; } };
    const cur = Object.keys(totals);
    return h('div', {},
      head('Payments received', h('button', { class: 'btn small', onclick: route }, 'Refresh')),
      h('div', { class: 'grid' },
        ...(cur.length ? cur.flatMap((c) => [tile(`Received, last 30 days (${c})`, money(c, totals[c].last30Days)), tile(`Received, all time (${c})`, money(c, totals[c].all)), tile('Payments', totals[c].count)]) : [tile('Payments', 0)])),
      h('p', { class: 'muted' }, 'Every payment Razorpay reported as received, after its signature and amount were checked. Refunds are deducted. Figures include accounts that were later deleted (the payment record is kept for accounting).'),
      h('div', { class: 'card tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Received', 'Person', 'Plan', 'Amount', 'Premium until', 'Payment id', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((p) => h('tr', {},
          h('td', {}, fmt.date(p.at)), h('td', {}, p.deleted ? h('span', { class: 'muted' }, `@${p.user} (deleted)`) : h('a', { href: `#users` , onclick: () => { userFilter.q = p.user; } }, `@${p.user}`)),
          h('td', {}, p.plan), h('td', {}, money(p.currency, p.amount)), h('td', {}, fmt.date(p.periodEnd)), h('td', { class: 'wrap' }, p.id),
          h('td', {}, p.refunded ? h('span', { class: 'tag bad' }, `Refunded ${money(p.currency, p.refunded)}`) : p.method ? h('span', { class: 'tag' }, p.method) : null))))),
        !list.length && h('p', { class: 'muted' }, 'No payments yet.')));
  }

  const pages = { overview, users, channels, payments, features, settings, audit, admins };

  async function route() {
    const page = (location.hash.replace('#', '') || 'overview').split('/')[0];
    const render = pages[page] || overview;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === (pages[page] ? page : 'overview')));
    closeDrawer();
    $('#page').replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    const node = await attempt(render);
    if (node) $('#page').replaceChildren(node);
  }
  window.addEventListener('hashchange', () => { if (state.admin) route(); });

  function head(title, ...right) {
    return h('div', { class: 'page-head' }, h('h2', {}, title), h('div', { class: 'actions' }, right));
  }

  // --- overview ---
  function bars(title, values, from) {
    const w = 320; const hgt = 100; const max = Math.max(1, ...values);
    const bw = w / values.length;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt + 18}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${title}: ${values.join(', ')}`);
    values.forEach((v, i) => {
      const bh = Math.max(v ? 2 : 0, (v / max) * hgt);
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('class', 'bar');
      r.setAttribute('x', i * bw + 2); r.setAttribute('y', hgt - bh); r.setAttribute('width', bw - 4); r.setAttribute('height', bh); r.setAttribute('rx', 2);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = `${new Date(from + i * 86400000).toLocaleDateString([], { day: 'numeric', month: 'short' })}: ${v}`;
      r.appendChild(t);
      svg.appendChild(r);
    });
    [0, values.length - 1].forEach((i) => {
      const tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tx.setAttribute('class', 'axis'); tx.setAttribute('x', i === 0 ? 2 : w - 2); tx.setAttribute('y', hgt + 13); tx.setAttribute('text-anchor', i === 0 ? 'start' : 'end');
      tx.textContent = new Date(from + i * 86400000).toLocaleDateString([], { day: 'numeric', month: 'short' });
      svg.appendChild(tx);
    });
    return h('div', { class: 'card chart' }, h('h3', {}, title), svg);
  }

  async function overview() {
    const o = await api('GET', '/overview');
    const { stats: s, config, integrations: ig, server, legal } = o;
    const tile = (label, n, warn) => h('div', { class: `tile${warn && n ? ' warn' : ''}` }, h('div', { class: 'n' }, typeof n === 'number' ? fmt.n(n) : n), h('div', { class: 'l' }, label));
    const off = Object.entries(config.features).filter(([, on]) => !on).map(([id]) => state.features.find((f) => f.id === id)?.label || id);
    setBanner(config);
    $('#nav-reports').textContent = s.content.openReports;
    $('#nav-reports').classList.toggle('hidden', !s.content.openReports);
    return h('div', {},
      head('Overview', h('button', { class: 'btn small', onclick: route }, 'Refresh')),
      !legal?.configured && h('div', { class: 'card warn-card' }, h('strong', {}, 'Legal details are missing. '), 'The Terms of Use and Privacy Notice still show placeholders such as [Company legal name]. Fill in the company details and Grievance Officer before launch. ', h('a', { href: '#settings' }, 'Open Settings → Legal')),
      h('div', { class: 'grid' },
        tile('Users', s.users.total), tile('Online now', s.users.online), tile('New today', s.users.newToday), tile('New in 7 days', s.users.new7d),
        tile('Premium', s.users.premium), tile('Verified', s.users.verified), tile('Business', s.users.business), tile('Under 18', s.users.children), tile('Suspended', s.users.suspended, true)),
      s.users.awaitingGuardian ? h('div', { class: 'grid' }, tile('Waiting for a parent or guardian', s.users.awaitingGuardian, true)) : null,
      s.users.deleting ? h('div', { class: 'grid' }, tile('Disabled, data waiting to be erased', s.users.deleting, true), tile('Overdue (over 24 hours)', s.users.deletionOverdue, true)) : null,
      h('p'),
      h('div', { class: 'grid' },
        tile('Chats', s.content.chats), tile('Groups', s.content.groups), tile('Messages', s.content.messages), tile('Status updates', s.content.statuses),
        tile('Channels', s.content.channels), tile('Channel posts', s.content.channelPosts), tile('Products', s.content.products), tile('Open reports', s.content.openReports, true),
        tile('Media files', s.content.mediaFiles), tile('Media size', fmt.bytes(s.content.mediaBytes)), tile('API keys', s.content.apiKeys), tile('Webhooks', s.content.webhooks)),
      h('p'),
      h('div', { class: 'charts' }, bars('New users per day', s.series.signups, s.series.from), bars('Messages per day', s.series.messages, s.series.from)),
      h('div', { class: 'card' }, h('h3', {}, 'Features switched off'),
        off.length ? h('div', { class: 'chips' }, off.map((l) => h('span', { class: 'chip off' }, l))) : h('p', { class: 'muted' }, 'Everything is on.'),
        h('p', {}, h('a', { href: '#features' }, 'Manage features'))),
      h('div', { class: 'card' }, h('h3', {}, 'Connected services'),
        h('div', { class: 'chips' }, [['Login codes (OTP)', ig.otp], ['Identity verification', ig.kyc], ['Payments', ig.payments], ['Translation', ig.translation]].map(([l, v]) => h('span', { class: `chip ${v === 'gateway' ? 'live' : v}` }, `${l}: ${v === 'gateway' ? 'live' : v}`))),
        h('p', { class: 'muted' }, 'live = a real provider is connected · sandbox = development stand-in (never in production) · off = not available · console = login codes are only printed in the server log.')),
      h('div', { class: 'card' }, h('h3', {}, 'Server'),
        h('p', { class: 'muted' }, `Up ${fmt.uptime(server.uptimeSeconds)} · Node ${server.node} · ${server.memoryMb} MB memory`)));
  }

  function setBanner(config) {
    const b = $('#status-banner');
    const parts = [];
    if (config.maintenance.on) parts.push('MAINTENANCE MODE IS ON: users cannot use the apps.');
    if (config.minClientVersion) parts.push(`Apps older than ${config.minClientVersion} are refused.`);
    b.textContent = parts.join(' ');
    b.classList.toggle('hidden', !parts.length);
  }

  // --- users ---
  const userFilter = { q: '', filter: '', page: 1 };

  async function users() {
    const res = await api('GET', `/users?${new URLSearchParams({ q: userFilter.q, filter: userFilter.filter, page: userFilter.page, pageSize: 25 })}`);
    const pagesCount = Math.max(1, Math.ceil(res.total / res.pageSize));
    const search = h('input', { type: 'search', placeholder: 'Search name, username, phone or email', value: userFilter.q, 'aria-label': 'Search users' });
    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { userFilter.q = search.value; userFilter.page = 1; route().then(() => $('#page input[type=search]')?.focus()); }, 350); });
    const filter = h('select', { 'aria-label': 'Filter', onchange: (e) => { userFilter.filter = e.target.value; userFilter.page = 1; route(); } },
      [['', 'All users'], ['premium', 'Premium'], ['verified', 'Verified'], ['business', 'Business'], ['children', 'Under 18'], ['awaiting-guardian', 'Waiting for a parent or guardian'], ['suspended', 'Suspended'], ['deleted', 'Permanently disabled']].map(([v, l]) => h('option', { value: v, selected: v === userFilter.filter }, l)));
    return h('div', {},
      head(`Users (${fmt.n(res.total)})`),
      h('div', { class: 'toolbar' }, search, filter),
      h('div', { class: 'card tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['User', 'Phone', 'Joined', 'Last seen', 'Status'].map((t) => h('th', {}, t)))),
        h('tbody', {}, res.users.map((u) => h('tr', { class: 'click', tabindex: 0, onclick: () => openUser(u.username), onkeydown: (e) => e.key === 'Enter' && openUser(u.username) },
          h('td', {}, h('strong', {}, u.displayName), h('br'), h('span', { class: 'muted' }, `@${u.username}`)),
          h('td', {}, u.phone || '—'), h('td', {}, fmt.date(u.createdAt)), h('td', {}, fmt.ago(u.lastSeen)),
          h('td', {}, u.suspended && h('span', { class: 'tag bad' }, 'Suspended'), u.minor && h('span', { class: 'tag' }, u.guardian?.state === 'pending' ? 'Under 18, waiting' : 'Under 18'), u.premium && h('span', { class: 'tag gold' }, 'Premium'), u.verified && h('span', { class: 'tag ok' }, 'Verified'), u.business && h('span', { class: 'tag' }, 'Business')))))),
        !res.users.length && h('p', { class: 'muted' }, 'No users found.')),
      h('div', { class: 'pager' },
        h('button', { class: 'btn small', disabled: userFilter.page <= 1, onclick: () => { userFilter.page -= 1; route(); } }, 'Previous'),
        h('span', { class: 'muted' }, `Page ${res.page} of ${pagesCount}`),
        h('button', { class: 'btn small', disabled: userFilter.page >= pagesCount, onclick: () => { userFilter.page += 1; route(); } }, 'Next')));
  }

  function closeDrawer() { $('#drawer').classList.add('hidden'); $('#drawer-bg').classList.add('hidden'); }
  $('#drawer-bg').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  async function openUser(username) {
    const { user: u } = (await attempt(() => api('GET', `/users/${encodeURIComponent(username)}`))) || {};
    if (!u) return;
    const act = (label, fn, cls = '') => h('button', { class: `btn small ${cls}`, onclick: async () => { const r = await attempt(fn); if (r) { toast('Done'); openUser(username); if (location.hash.startsWith('#users')) route(); } } }, label);
    const dl = h('dl', {},
      ...[['Username', `@${u.username}`], ['Name', u.displayName], ['Phone', u.phone || '—'], ['Email', u.email || '—'], ['Joined', fmt.date(u.createdAt)], ['Last seen', fmt.ago(u.lastSeen)],
        ['Premium', u.premium ? `${u.plan || 'yes'} until ${fmt.date(u.premiumUntil)}` : 'No'], ['Verified', u.verified ? 'Yes' : 'No'], ['Business', u.business || 'No'],
        ['Chats', u.chats], ['Channels owned', u.channelsOwned], ['API keys', u.apiKeys], ['Devices (encryption)', u.devices],
        ['Terms and Privacy accepted', u.consent ? `version ${u.consent.version}, ${fmt.date(u.consent.at)}${Object.entries(u.consent.optional).map(([k, v]) => ` · ${k}: ${v ? 'yes' : 'no'}`).join('')}` : 'No record (account made before consent was added)'],
        ...(u.age !== null && u.age !== undefined ? [['Age', u.minor ? `${u.age} (under 18)` : `${u.age}`]] : []),
        ...(u.guardian ? [['Parent or guardian', u.guardian.state === 'ended (turned 18)' ? 'Controls ended (turned 18); contact details erased' : `${u.guardian.name} (${u.guardian.relationship}), ${[u.guardian.phone, u.guardian.email].filter(Boolean).join(', ')}`],
          ['Their approval', u.guardian.state === 'pending' ? 'Waiting: the account cannot be used yet' : u.guardian.consentedAt ? `Agreed ${fmt.date(u.guardian.consentedAt)}` : u.guardian.state],
          ...(u.guardian.controls ? [['What they allow', Object.entries(u.guardian.controls).map(([k, v]) => `${k}: ${v ? 'on' : 'off'}`).join(' · ')]] : [])] : []),
        ...(u.deleted ? [['Account deleted', fmt.date(u.deleted)]] : [])]
        .flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]),
      u.deletion || u.deleted ? [h('dt', {}, 'Status'), h('dd', {}, u.deleted ? `Permanently disabled ${fmt.date(u.disabledAt)}; chats, media and personal data erased ${fmt.date(u.deleted)}. Only a basic record is kept.` : `Permanently disabled ${fmt.date(u.deletion.requestedAt)}; login blocked; chats, media and personal data are erased by ${fmt.date(u.deletion.eraseAt)} (always within 24 hours)`)] : [],
      u.suspended ? [h('dt', {}, 'Suspended'), h('dd', {}, `${fmt.date(u.suspended.at)} by ${u.suspended.by}${u.suspended.reason ? `: ${u.suspended.reason}` : ''}`)] : []);
    const reason = h('input', { placeholder: 'Reason shown to the user (optional)', maxlength: 200 });
    const days = h('input', { type: 'number', min: 1, max: 3650, value: 30, 'aria-label': 'Days of Premium' });
    $('#drawer').replaceChildren(
      h('div', { class: 'page-head' }, h('h3', {}, u.displayName), h('button', { class: 'btn small', onclick: closeDrawer }, 'Close')),
      dl,
      h('h3', {}, 'Moderation'),
      u.suspended
        ? h('div', { class: 'actions' }, act('Unsuspend', () => api('POST', `/users/${username}/unsuspend`)))
        : h('div', { class: 'form' }, reason, h('div', { class: 'actions' }, act('Suspend account', () => api('POST', `/users/${username}/suspend`, { reason: reason.value }), 'danger'))),
      h('div', { class: 'actions' }, act('Force log out everywhere', () => api('POST', `/users/${username}/logout`))),
      isSuper() && h('h3', {}, 'Badges and Premium'),
      isSuper() && h('div', { class: 'actions' }, act(u.verified ? 'Remove Verified badge' : 'Give Verified badge', () => api('POST', `/users/${username}/verified`, { verified: !u.verified }))),
      isSuper() && h('div', { class: 'row' }, h('label', {}, 'Give Premium for (days)', days), h('div', { class: 'actions', style: 'align-self:flex-end' },
        act('Give Premium', () => api('POST', `/users/${username}/premium`, { days: Number(days.value) })), u.premium && act('End Premium', () => api('POST', `/users/${username}/premium`, { revoke: true }), 'danger'))),
      h('p', { class: 'muted' }, 'Administrators can see contact details but never messages: those are end-to-end encrypted.'));
    $('#drawer').classList.remove('hidden');
    $('#drawer-bg').classList.remove('hidden');
  }

  // --- channels & reports ---
  async function channels() {
    const [{ channels: list }, { reports }, { reports: photoReports }] = await Promise.all([api('GET', '/channels'), api('GET', '/reports'), api('GET', '/photo-reports')]);
    $('#nav-reports').textContent = reports.length + photoReports.length;
    $('#nav-reports').classList.toggle('hidden', !(reports.length + photoReports.length));
    // Reported profile photos: the picture is fetched with the administrator's session (it is never public).
    const photoImg = (g, size) => {
      const img = h('img', { alt: 'Reported photo', width: 96, height: 96, style: 'border-radius:10px;object-fit:cover;background:#ccc;cursor:pointer' });
      fetch(`/admin/api/photo-reports/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.photoId)}/image?size=${size}`, { headers: { Authorization: `Bearer ${state.token}` } })
        .then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) img.src = URL.createObjectURL(b); });
      return img;
    };
    const photoAction = (path, g, done) => async () => { if (await attempt(() => api('POST', path, { owner: g.owner, photoId: g.photoId })) !== null) { toast(done); route(); } };
    const photoCard = h('div', { class: 'card' }, h('h3', {}, `Reported profile photos (${photoReports.length})`),
      photoReports.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Photo', 'Owner', 'Reports', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, photoReports.map((g) => h('tr', {},
          h('td', {}, photoImg(g, 'thumb')),
          h('td', {}, `${g.ownerName} (@${g.owner})`, h('br'), g.minor && h('span', { class: 'tag bad' }, 'Under 18'), g.hidden && h('span', { class: 'tag' }, 'Hidden from others')),
          h('td', { class: 'wrap' }, g.reports.map((r) => h('div', {}, `${fmt.date(r.ts)} · @${r.reporter}: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`))),
          h('td', {}, h('div', { class: 'actions' },
            h('button', { class: 'btn small', onclick: async () => { const r = await fetch(`/admin/api/photo-reports/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.photoId)}/image?size=full`, { headers: { Authorization: `Bearer ${state.token}` } }); if (r.ok) window.open(URL.createObjectURL(await r.blob()), '_blank'); } }, 'View large'),
            h('button', { class: 'btn small', onclick: photoAction('/photo-reports/dismiss', g, 'Restored and cleared') }, 'Looks fine'),
            h('button', { class: 'btn small danger', onclick: () => { if (confirm(`Remove this photo of ${g.ownerName}? Their other photos stay.`)) photoAction('/photo-reports/remove', g, 'Photo removed')(); } }, 'Remove photo'))))))))
        : h('p', { class: 'muted' }, 'No reported photos. Three different people, or one report that a child may be at risk, hide a photo from everyone but its owner until you decide.'));
    const removeChannel = (c) => async () => {
      if (!confirm(`Delete channel "${c.name}" (@${c.handle}) and all its posts? Its ${c.followers} followers will lose it.`)) return;
      if (await attempt(() => api('DELETE', `/channels/${c.id}`)) !== null) { toast('Channel deleted'); route(); }
    };
    return h('div', {},
      head('Channels & reports'),
      photoCard,
      h('div', { class: 'card' }, h('h3', {}, `Open channel reports (${reports.length})`),
        reports.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Channel', 'Owner', 'Reported by', 'Reason', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, reports.map((r) => h('tr', {},
            h('td', {}, fmt.date(r.ts)), h('td', {}, r.channel ? `${r.channel.name} (@${r.channel.handle})` : 'deleted'), h('td', {}, r.channel?.owner || '—'), h('td', {}, `@${r.reporter}`), h('td', { class: 'wrap' }, r.reason),
            h('td', {}, h('div', { class: 'actions' },
              r.channel && h('button', { class: 'btn small danger', onclick: removeChannel({ id: r.channel.id, name: r.channel.name, handle: r.channel.handle, followers: '' }) }, 'Delete channel'),
              h('button', { class: 'btn small', onclick: async () => { if (await attempt(() => api('POST', '/reports/dismiss', { channelId: r.channelId, reporter: r.reporter })) !== null) { toast('Dismissed'); route(); } } }, 'Dismiss'))))))))
          : h('p', { class: 'muted' }, 'No open reports.')),
      h('div', { class: 'card' }, h('h3', {}, 'All channels'),
        h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Channel', 'Owner', 'Followers', 'Posts', 'Reports', 'Created', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, list.map((c) => h('tr', {}, h('td', {}, h('strong', {}, c.name), h('br'), h('span', { class: 'muted' }, `@${c.handle}`)), h('td', {}, `@${c.owner}`), h('td', {}, c.followers), h('td', {}, c.posts),
            h('td', {}, c.reports ? h('span', { class: 'tag bad' }, c.reports) : '0'), h('td', {}, fmt.date(c.createdAt)), h('td', {}, h('button', { class: 'btn small danger', onclick: removeChannel(c) }, 'Delete'))))))),
        !list.length && h('p', { class: 'muted' }, 'No channels yet.')));
  }

  // --- features ---
  async function loadSettings() {
    const res = await api('GET', '/settings');
    state.settings = res.settings;
    state.features = res.features;
    return res;
  }

  async function saveSettings(patch, okMessage) {
    const res = await attempt(() => api('PUT', '/settings', patch));
    if (res) {
      state.settings = res.settings;
      toast(res.changes.length ? okMessage || 'Saved. Every app is updated.' : 'Nothing changed');
    }
    return res;
  }

  async function features() {
    const { settings: s, features: list } = await loadSettings();
    const groups = [...new Set(list.map((f) => f.group))];
    const msg = h('input', { value: s.maintenance.message, maxlength: 300, 'aria-label': 'Maintenance message', disabled: !isSuper() });
    const ann = h('input', { value: s.announcement, maxlength: 300, placeholder: 'e.g. New: public channels are here!', 'aria-label': 'Announcement', disabled: !isSuper() });
    const minV = h('input', { value: s.minClientVersion, placeholder: 'e.g. 1.2.0 (empty = no minimum)', 'aria-label': 'Minimum app version', disabled: !isSuper() });
    const toggle = (checked, onChange, label) => {
      const input = h('input', { type: 'checkbox', role: 'switch', checked, disabled: !isSuper(), 'aria-label': label });
      input.addEventListener('change', async () => {
        const ok = await onChange(input.checked);
        if (!ok) input.checked = !input.checked;
      });
      return h('span', { class: 'switch' }, input, h('span', { class: 'track' }));
    };
    return h('div', {},
      head('Features'),
      !isSuper() && h('p', { class: 'muted' }, 'Only a super admin can change these. You can see what is on.'),
      h('p', { class: 'muted' }, 'A switch controls the web app and the mobile apps at once: the server refuses the feature and the apps hide it. Nothing is deleted, and removing protection (unlocking a chat, unhiding, turning something off) always keeps working.'),
      h('div', { class: 'card' }, h('h3', {}, 'Platform'),
        h('div', { class: 'switch-row' }, h('div', { class: 't' }, h('strong', {}, 'Maintenance mode'), h('span', {}, 'Blocks everyone except administrators and shows the message below in every app.')),
          toggle(s.maintenance.on, async (on) => {
            if (on && !confirm('Turn maintenance mode ON? Every user will be locked out of the apps until you turn it off.')) return false;
            return !!(await saveSettings({ maintenance: { on } }, on ? 'Maintenance mode is ON' : 'Maintenance mode is off'));
          }, 'Maintenance mode')),
        h('div', { class: 'row' }, h('label', {}, 'Maintenance message', msg), h('div', { class: 'actions', style: 'align-self:flex-end' }, h('button', { class: 'btn small', disabled: !isSuper(), onclick: () => saveSettings({ maintenance: { message: msg.value } }) }, 'Save'))),
        h('div', { class: 'row' }, h('label', {}, 'Announcement shown to everyone', ann), h('div', { class: 'actions', style: 'align-self:flex-end' }, h('button', { class: 'btn small', disabled: !isSuper(), onclick: () => saveSettings({ announcement: ann.value }) }, 'Save'))),
        h('div', { class: 'row' }, h('label', {}, 'Minimum app version (mobile apps)', minV), h('div', { class: 'actions', style: 'align-self:flex-end' }, h('button', { class: 'btn small', disabled: !isSuper(), onclick: () => saveSettings({ minClientVersion: minV.value }) }, 'Save')))),
      groups.map((g) => h('div', { class: 'group' }, h('h3', {}, g), h('div', { class: 'card' },
        list.filter((f) => f.group === g).map((f) => h('div', { class: 'switch-row' }, h('div', { class: 't' }, h('strong', {}, f.label), h('span', {}, f.description)),
          toggle(s.features[f.id] !== false, async (on) => !!(await saveSettings({ features: { [f.id]: on } }, `${f.label}: ${on ? 'on' : 'off'}. Every app is updated.`)), f.label)))))));
  }

  // --- settings: legal details printed in the Terms and Privacy Notice ---
  function legalCard(s) {
    const L = s.legal;
    const text = (k, label, ph = '') => { const i = h('input', { value: L[k] || '', maxlength: 300, placeholder: ph, disabled: !isSuper(), 'aria-label': label }); i.dataset.k = k; return [label, i]; };
    const fields = [
      text('company', 'Company legal name', 'e.g. PrayukTech Private Limited'), text('address', 'Registered address'),
      text('contactEmail', 'Contact email'), text('city', 'City for legal disputes (courts)'),
      text('grievanceName', 'Grievance Officer name'), text('grievanceEmail', 'Grievance Officer email'),
      text('grievancePhone', 'Grievance Officer phone (optional)'), text('hosting', 'Where the servers are', 'e.g. India (Mumbai)'),
      text('paymentProvider', 'Payment provider named in the Privacy Notice', 'Razorpay'),
    ];
    const days = (k, label) => { const i = h('input', { type: 'number', min: 1, max: 365, value: L[k], disabled: !isSuper(), 'aria-label': label }); i.dataset.k = k; return [label, i]; };
    const nums = [days('backupDays', 'Days deleted data may stay in backups'), days('responseDays', 'Days to answer a rights request')];
    const legacy = h('input', { type: 'checkbox', checked: !!L.requireForLegacy, disabled: !isSuper(), 'aria-label': 'Ask accounts made before consent existed to accept' });
    const save = () => saveSettings({
      legal: {
        ...Object.fromEntries(fields.map(([, i]) => [i.dataset.k, i.value])),
        ...Object.fromEntries(nums.map(([, i]) => [i.dataset.k, Number(i.value)])),
        requireForLegacy: legacy.checked,
      },
    }, 'Legal details saved. The Terms and Privacy Notice pages are updated.');
    return h('div', { class: 'card' }, h('h3', {}, 'Legal: Terms of Use and Privacy Notice'),
      h('p', { class: 'muted' }, 'These details are printed in the Terms of Use and Privacy Notice that people accept when they sign up. Have your lawyer review those texts and these details before launch. ', h('a', { href: '/legal/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Notice'), ' · ', h('a', { href: '/legal/terms', target: '_blank', rel: 'noopener' }, 'Terms of Use')),
      ...[0, 2, 4, 6, 8].map((n) => h('div', { class: 'row' }, ...fields.slice(n, n + 2).map(([label, i]) => h('label', {}, label, i)))),
      h('div', { class: 'row' }, ...nums.map(([label, i]) => h('label', {}, label, i))),
      h('div', { class: 'switch-row' }, h('div', { class: 't' }, h('strong', {}, 'Ask older accounts to accept too'), h('span', {}, 'Accounts created before consent was added are blocked until they accept. Off by default.')), h('span', { class: 'switch' }, legacy, h('span', { class: 'track' }))),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: !isSuper(), onclick: save }, 'Save legal details')));
  }

  // --- settings ---
  async function settings() {
    const { settings: s } = await loadSettings();
    const num = (v, min) => h('input', { type: 'number', min, value: v, disabled: !isSuper() });
    const locks = num(s.limits.freeChatLocks, 0), hidden = num(s.limits.freeHiddenChats, 0), channelsMax = num(s.limits.channelsPerOwner, 1), products = num(s.limits.catalogueMax, 1), minAge = num(s.limits.minAge, 5), freePhotos = num(s.limits.freeProfilePhotos, 1), premiumPhotos = num(s.limits.premiumProfilePhotos, 1);
    const price = (id) => h('input', { type: 'number', min: 1, step: '0.01', placeholder: 'default', value: s.prices[id] ?? '', disabled: !isSuper() });
    const PLANS = [['daily', 'Daily'], ['monthly', 'Monthly'], ['quarterly', '3 months'], ['halfyearly', '6 months'], ['yearly', 'Yearly']];
    const prices = Object.fromEntries(PLANS.map(([id]) => [id, price(id)]));
    const planOn = Object.fromEntries(PLANS.map(([id]) => [id, h('input', { type: 'checkbox', checked: !(s.disabledPlans || []).includes(id), disabled: !isSuper(), 'aria-label': `Sell the ${id} plan` })]));
    return h('div', {},
      head('Settings'),
      !isSuper() && h('p', { class: 'muted' }, 'Only a super admin can change these.'),
      h('div', { class: 'card' }, h('h3', {}, 'Free account limits'),
        h('p', { class: 'muted' }, 'Premium accounts have no limits. Chats already locked or hidden are never exposed if a limit is lowered.'),
        h('div', { class: 'row' }, h('label', {}, 'Locked chats (free)', locks), h('label', {}, 'Hidden chats (free)', hidden)),
        h('div', { class: 'row' }, h('label', {}, 'Channels per owner', channelsMax), h('label', {}, 'Products per catalogue', products)),
        h('div', { class: 'row' }, h('label', {}, 'Profile photos (free account)', freePhotos), h('label', {}, 'Profile photos (Premium)', premiumPhotos)),
        h('div', { class: 'row' }, h('label', {}, 'Youngest age allowed to sign up (5 to 17; under 18 needs a parent or guardian)', minAge)),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: !isSuper(), onclick: () => saveSettings({ limits: { freeChatLocks: Number(locks.value), freeHiddenChats: Number(hidden.value), channelsPerOwner: Number(channelsMax.value), catalogueMax: Number(products.value), minAge: Number(minAge.value), freeProfilePhotos: Number(freePhotos.value), premiumProfilePhotos: Number(premiumPhotos.value) } }, 'Limits saved') }, 'Save limits'))),
      legalCard(s),
      h('div', { class: 'card' }, h('h3', {}, 'Premium plans and prices'),
        h('p', { class: 'muted' }, 'Leave a field empty to use the default price. Changes apply to new purchases.'),
        h('div', { class: 'row' }, ...PLANS.map(([id, label]) => h('label', {}, label, prices[id], h('span', { class: 'muted' }, h('label', {}, planOn[id], ' on sale')))))
        ,
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: !isSuper(), onclick: () => saveSettings({ prices: Object.fromEntries(Object.entries(prices).map(([k, el]) => [k, el.value === '' ? null : Number(el.value)])), disabledPlans: PLANS.map(([id]) => id).filter((id) => !planOn[id].checked) }, 'Plans saved') }, 'Save plans')),
        h('p', { class: 'muted' }, 'Payments are taken by Razorpay (see Overview for whether it is connected, and Payments for what was received).')));
  }

  // --- audit ---
  async function audit() {
    const { entries } = await api('GET', '/audit?limit=300');
    return h('div', {}, head('Audit log'), h('p', { class: 'muted' }, 'Every administrator action, newest first.'),
      h('div', { class: 'card tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Admin', 'Action', 'Target', 'Details'].map((t) => h('th', {}, t)))),
        h('tbody', {}, entries.map((e) => h('tr', {}, h('td', {}, fmt.date(e.ts)), h('td', {}, e.admin), h('td', {}, h('span', { class: 'tag' }, e.action)), h('td', {}, e.target || '—'), h('td', { class: 'wrap' }, e.detail || '—'))))),
        !entries.length && h('p', { class: 'muted' }, 'Nothing yet.')));
  }

  // --- administrators ---
  async function admins() {
    const own = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target;
      if (await attempt(() => api('POST', '/password', { current: f.current.value, password: f.password.value })) !== null) { toast('Password changed'); f.reset(); }
    } },
      h('label', {}, 'Current password', h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
      h('label', {}, 'New password (at least 10 characters)', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 10, required: true })),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Change my password')));
    let list = null;
    if (isSuper()) list = (await api('GET', '/admins')).admins;
    return h('div', {}, head('Administrators'),
      h('div', { class: 'card' }, h('h3', {}, 'My account'), h('p', { class: 'muted' }, `Signed in as ${state.admin.username} (${state.admin.role === 'super' ? 'super admin: can do everything' : 'support: can look and moderate'}).`), own),
      isSuper() && h('div', { class: 'card' }, h('h3', {}, 'Administrators'),
        h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Username', 'Role', 'Added', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, list.map((a) => h('tr', {}, h('td', {}, a.username), h('td', {}, h('span', { class: 'tag' }, a.role)), h('td', {}, fmt.date(a.createdAt)),
            h('td', {}, a.username !== state.admin.username && h('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Remove administrator ${a.username}?`) && await attempt(() => api('DELETE', `/admins/${a.username}`)) !== null) { toast('Removed'); route(); } } }, 'Remove'))))))),
        h('h3', { style: 'margin-top:18px' }, 'Add an administrator'),
        h('form', { class: 'form', onsubmit: async (e) => {
          e.preventDefault();
          const f = e.target;
          if (await attempt(() => api('POST', '/admins', { username: f.username.value, password: f.password.value, role: f.role.value })) !== null) { toast('Administrator added'); route(); }
        } },
          h('label', {}, 'Username', h('input', { name: 'username', required: true, autocomplete: 'off' })),
          h('label', {}, 'Password (at least 10 characters)', h('input', { name: 'password', type: 'password', minlength: 10, required: true, autocomplete: 'new-password' })),
          h('label', {}, 'Role', h('select', { name: 'role' }, h('option', { value: 'support' }, 'Support: look and moderate'), h('option', { value: 'super' }, 'Super admin: everything'))),
          h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add administrator')))));
  }

  // ---------- start ----------

  async function start() {
    $('#login').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    try {
      const me = await api('GET', '/me');
      state.admin = me.admin;
      await loadSettings();
    } catch {
      return;
    }
    $('#who-name').textContent = state.admin.username;
    $('#who-role').textContent = state.admin.role === 'super' ? 'Super admin' : 'Support';
    document.querySelector('#nav a[data-page=admins]').classList.toggle('hidden', false);
    route();
  }

  (async () => {
    if (state.token) return start();
    $('#login').classList.remove('hidden');
    const st = await fetch('/admin/api/status').then((r) => r.json()).catch(() => null);
    if (st && !st.configured) $('#login-note').textContent = 'No administrator is set up yet. Start the server with ADMIN_USERNAME and ADMIN_PASSWORD (at least 10 characters), then sign in here.';
  })();
})();
