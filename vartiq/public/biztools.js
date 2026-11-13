/*
 * Business tools: quick replies (type "/" in a chat), labels on chats, orders from the catalogue (with a UPI pay link),
 * how the business is doing (insights) and the "click to chat" link. The server does the work; this file is the screens.
 */
window.createBizTools = function createBizTools(o) {
  'use strict';

  const { emit, toast, dialog, openPanel, me, user, conversations, openChat, renderChatList, displayName, closePanel } = o;
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const money = (n, cur = 'INR') => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n); } catch { return `${cur} ${n}`; } };
  const STATUS = { placed: 'Placed', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
  const NEXT = { placed: ['confirmed', 'Confirm'], confirmed: ['packed', 'Mark packed'], packed: ['shipped', 'Mark shipped'], shipped: ['delivered', 'Mark delivered'] };

  const state = { quick: [], labels: [], chats: {}, colors: [], filter: null, loaded: false };

  // ----- loading (businesses only) -----

  async function load() {
    if (!me()?.business) { Object.assign(state, { quick: [], labels: [], chats: {}, loaded: false }); return; }
    try {
      state.quick = (await emit('quick:list', {})).quickReplies;
      const l = await emit('label:list', {});
      Object.assign(state, { labels: l.labels, chats: l.chats, colors: l.colors, loaded: true });
    } catch { /* not a business, or the feature is off */ }
  }

  // ----- quick replies -----

  const quickMatches = (q) => state.quick.filter((x) => x.shortcut.startsWith(q.toLowerCase())).slice(0, 6);

  async function editQuick(q) {
    await dialog({
      title: q ? 'Edit quick reply' : 'New quick reply',
      text: 'In a chat, type / and the shortcut to insert the text.',
      submit: 'Save',
      fields: [
        { name: 'shortcut', label: 'Shortcut (letters and digits, like hours)', type: 'text', maxLength: 21, value: q?.shortcut || '' },
        { name: 'text', label: 'Reply', type: 'textarea', maxLength: 1000, rows: 5, value: q?.text || '' },
      ],
      async onSubmit(v) {
        const res = await emit('quick:save', { id: q?.id, shortcut: v.shortcut, text: v.text });
        state.quick = res.quickReplies;
      },
    });
    renderTools();
  }

  // ----- labels -----

  const labelDot = (l) => { const d = el('span', 'label-dot'); d.style.background = l.color; d.title = l.name; return d; };
  const labelsOf = (convId) => (state.chats[convId] || []).map((id) => state.labels.find((l) => l.id === id)).filter(Boolean);

  async function editLabel(l) {
    await dialog({
      title: l ? 'Edit label' : 'New label',
      submit: 'Save',
      fields: [
        { name: 'name', label: 'Name (like New customer, VIP, Paid)', type: 'text', maxLength: 24, value: l?.name || '' },
        { name: 'color', label: 'Colour', options: state.colors.map((c, i) => [c, ['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'Brown', 'Grey'][i] || c]), value: l?.color || state.colors[0] },
      ],
      async onSubmit(v) {
        const res = await emit('label:save', { id: l?.id, name: v.name, color: v.color });
        Object.assign(state, { labels: res.labels, chats: res.chats });
      },
    });
    renderTools();
    renderChatList();
  }

  /** Choose the labels of one chat. */
  async function chatLabelsDialog(conv) {
    if (!state.labels.length) { toast('Make a label first: Business profile → Business tools → Labels'); return; }
    const cur = new Set(state.chats[conv.id] || []);
    await dialog({
      title: 'Labels for this chat',
      text: 'Only you see labels. At most 5 per chat.',
      submit: 'Save',
      fields: state.labels.map((l) => ({ name: l.id, label: l.name, type: 'checkbox', required: false, checked: cur.has(l.id) })),
      async onSubmit(v) {
        const ids = state.labels.filter((l) => v[l.id] === 'on').map((l) => l.id);
        const res = await emit('label:chat', { convId: conv.id, ids });
        if (res.ids.length) state.chats[conv.id] = res.ids; else delete state.chats[conv.id];
        renderChatList();
      },
    });
  }

  // ----- orders: the customer's side -----

  async function orderDialog(conv, peer) {
    let cat;
    try { cat = await emit('catalogue:get', { username: peer }); } catch (err) { return toast(err.message); }
    const products = (cat.products || []).filter((p) => p.available !== false);
    if (!products.length) return toast('This business has no products listed yet');
    return dialog({
      title: `Order from ${displayName(peer)}`,
      text: 'Choose how many of each. Prices are the business\'s catalogue prices. You pay the business directly (for example by UPI).',
      submit: 'Place order',
      fields: [
        ...products.map((p) => ({ name: `q_${p.id}`, label: `${p.name} · ${money(p.price, cat.currency)}`, type: 'number', required: false, maxLength: 2, value: '0' })),
        { name: 'note', label: 'Note for the business (optional)', type: 'text', required: false, maxLength: 300 },
      ],
      async onSubmit(v) {
        const items = products.map((p) => ({ id: p.id, qty: Math.floor(Number(v[`q_${p.id}`]) || 0) })).filter((i) => i.qty > 0);
        if (!items.length) throw new Error('Choose at least one product');
        const res = await emit('order:place', { convId: conv.id, items, note: v.note, clientId: `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
        o.onOrderPlaced?.(res.message);
      },
    });
  }

  // ----- the order card in a chat -----

  function upiLink(biz, order) {
    const q = new URLSearchParams({ pa: biz.upi, pn: biz.name || '', am: String(order.total), cu: order.currency || 'INR', tn: `Order #${order.number}` });
    return `upi://pay?${q.toString()}`;
  }

  /** `m` is an order message; `mine` is whether I wrote it (the customer). */
  function orderCard(m, mine) {
    const ord = m.order;
    const conv = conversations().get(m.convId);
    const bizName = conv?.members.find((x) => x !== m.from);
    const iAmBiz = !mine; // the customer writes the order; the business is the other person
    const box = el('div', `order-card status-${ord.status}`);
    const head = el('div', 'order-head');
    head.append(el('strong', '', `Order #${ord.number}`), el('span', `order-status ${ord.status}`, STATUS[ord.status] || ord.status));
    if (ord.paid) head.appendChild(el('span', 'order-paid', 'Paid'));
    box.appendChild(head);
    const ul = el('ul', 'order-items');
    for (const it of ord.items) ul.appendChild(el('li', '', `${it.qty} × ${it.name} — ${money(it.price * it.qty, ord.currency)}`));
    box.appendChild(ul);
    box.appendChild(el('div', 'order-total', `Total ${money(ord.total, ord.currency)}`));
    if (ord.note) box.appendChild(el('div', 'muted small-note', `Note: ${ord.note}`));
    const actions = el('div', 'order-actions');
    const act = (label, fn, cls = 'link') => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', async () => { try { await fn(); } catch (err) { toast(err.message); } }); actions.appendChild(b); };
    const update = (patch) => emit('order:update', { id: m.id, ...patch });
    const final = ord.status === 'delivered' || ord.status === 'cancelled';
    if (iAmBiz) {
      if (NEXT[ord.status]) act(NEXT[ord.status][1], () => update({ status: NEXT[ord.status][0] }), 'primary small');
      if (!final) act('Cancel order', () => { if (confirm('Cancel this order?')) return update({ status: 'cancelled' }); });
      act(ord.paid ? 'Mark as unpaid' : 'Mark as paid', () => update({ paid: !ord.paid }));
    } else {
      const biz = user(bizName)?.business;
      if (biz?.upi && !ord.paid && ord.status !== 'cancelled') {
        const a = el('a', 'primary small pay-btn', `Pay ${money(ord.total, ord.currency)} by UPI`);
        a.href = upiLink({ ...biz, name: user(bizName)?.displayName || '' }, ord);
        actions.appendChild(a);
        act('Copy UPI ID', () => navigator.clipboard.writeText(biz.upi).then(() => toast(`UPI ID ${biz.upi} copied`)));
      }
      if (['placed', 'confirmed'].includes(ord.status)) act('Cancel order', () => { if (confirm('Cancel this order?')) return update({ status: 'cancelled' }); });
    }
    if (actions.children.length) box.appendChild(actions);
    return box;
  }

  // ----- the business screens -----

  function section(title, ...kids) {
    const s = el('section', 'info-card');
    s.appendChild(el('div', 'info-label', title));
    for (const k of kids) if (k) s.appendChild(k);
    return s;
  }
  const row = (text, sub, ...buttons) => {
    const li = el('li', 'bot-item');
    const t = el('div', 'bot-item-text');
    t.append(el('strong', '', text), sub ? el('span', 'muted', sub) : null);
    const a = el('div', 'bot-item-actions');
    for (const [label, fn, cls] of buttons) { const b = el('button', cls || 'link', label); b.type = 'button'; b.addEventListener('click', fn); a.appendChild(b); }
    li.append(t, a);
    return li;
  };
  const add = (label, fn) => { const b = el('button', 'primary small', label); b.type = 'button'; b.addEventListener('click', fn); return b; };

  function renderTools() {
    const box = $('#biztools-body');
    if (!box) return;
    box.textContent = '';
    box.appendChild(el('p', 'muted', 'Tools for running a business chat: saved replies, labels, orders and how you are doing.'));

    const q = el('ul', 'bot-list');
    state.quick.forEach((x) => q.appendChild(row(`/${x.shortcut}`, x.text, ['Edit', () => editQuick(x)], ['Delete', async () => { if (confirm('Delete this quick reply?')) { state.quick = (await emit('quick:delete', { id: x.id })).quickReplies; renderTools(); } }, 'danger-link'])));
    box.appendChild(section(`Quick replies (${state.quick.length})`, el('p', 'muted small-note', 'Type / in a chat to insert one.'), q, add('Add a quick reply', () => editQuick(null))));

    const l = el('ul', 'bot-list');
    state.labels.forEach((x) => {
      const r = row(x.name, `${Object.values(state.chats).filter((ids) => ids.includes(x.id)).length} chats`, ['Edit', () => editLabel(x)], ['Delete', async () => { if (confirm(`Delete the label "${x.name}"?`)) { const res = await emit('label:delete', { id: x.id }); Object.assign(state, { labels: res.labels, chats: res.chats }); renderTools(); renderChatList(); } }, 'danger-link']);
      r.querySelector('strong').prepend(labelDot(x), ' ');
      l.appendChild(r);
    });
    box.appendChild(section(`Labels (${state.labels.length})`, el('p', 'muted small-note', 'Put labels on chats from the chat menu, then filter the chat list by label.'), l, add('Add a label', () => editLabel(null))));

    const links = el('div', 'stack');
    const chat = `${location.origin}/c/${me().username}`;
    links.appendChild(el('p', 'muted small-note', 'Anyone who opens this link starts a chat with you. Put it on your website, poster or messages. Add ?text=Hello to fill in a first message.'));
    const copy = el('button', 'link', 'Copy chat link');
    copy.type = 'button';
    copy.addEventListener('click', () => navigator.clipboard.writeText(chat).then(() => toast('Link copied'), () => prompt('Copy this link:', chat)));
    links.append(el('code', 'wrap-code', chat), copy);
    box.appendChild(section('Chat link', links));

    const nav = el('div', 'stack pad');
    const b1 = el('button', 'primary', 'Orders');
    b1.type = 'button';
    b1.addEventListener('click', openOrders);
    const b2 = el('button', 'primary', 'How am I doing?');
    b2.type = 'button';
    b2.addEventListener('click', openInsights);
    nav.append(b1, b2);
    box.appendChild(nav);
  }

  async function open() {
    await load();
    openPanel('#panel-biztools');
    renderTools();
  }

  async function openOrders(statusFilter = '') {
    openPanel('#panel-bizorders');
    const body = $('#bizorders-body');
    body.textContent = 'Loading…';
    let orders;
    try { orders = (await emit('order:list', { status: statusFilter || undefined })).orders; } catch (err) { body.textContent = err.message; return; }
    body.textContent = '';
    const sel = el('select');
    sel.appendChild(new Option('All orders', ''));
    for (const [k, v] of Object.entries(STATUS)) sel.appendChild(new Option(v, k));
    sel.value = statusFilter || '';
    sel.addEventListener('change', () => openOrders(sel.value));
    body.appendChild(el('div', 'pad', ''));
    body.lastChild.appendChild(sel);
    if (!orders.length) body.appendChild(el('p', 'muted pad', 'No orders yet. Customers order from your catalogue in a chat with you.'));
    const ul = el('ul', 'list');
    for (const r of orders) {
      const li = el('li', 'tappable');
      const b = el('div', 'body');
      const top = el('div', 'row');
      top.append(el('span', 'name', `#${r.order.number} · ${displayName(r.customer)}`), el('span', `order-status ${r.order.status}`, STATUS[r.order.status]));
      b.append(top, el('div', 'sub', `${money(r.order.total, r.order.currency)} · ${r.order.items.length} item${r.order.items.length === 1 ? '' : 's'} · ${new Date(r.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${r.order.paid ? ' · Paid' : ''}`));
      li.appendChild(b);
      li.addEventListener('click', () => { closePanel('#panel-bizorders'); closePanel('#panel-biztools'); openChat(r.convId, { highlight: r.id }); });
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  async function openInsights(days = 30) {
    openPanel('#panel-bizinsights');
    const body = $('#bizinsights-body');
    body.textContent = 'Loading…';
    let i;
    try { i = (await emit('business:insights', { days })).insights; } catch (err) { body.textContent = err.message; return; }
    body.textContent = '';
    const sel = el('select');
    for (const d of [7, 30, 90]) sel.appendChild(new Option(`Last ${d} days`, d));
    sel.value = i.days;
    sel.addEventListener('change', () => openInsights(Number(sel.value)));
    const top = el('div', 'pad');
    top.appendChild(sel);
    body.appendChild(top);
    const dur = (ms) => (ms == null ? '—' : ms < 90000 ? `${Math.round(ms / 1000)} s` : ms < 5400000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
    const tile = (label, value) => { const t = el('div', 'stat-tile'); t.append(el('div', 'stat-num', String(value)), el('div', 'muted small-note', label)); return t; };
    const tiles = el('div', 'stat-grid');
    tiles.append(
      tile('New customers', i.newCustomers), tile('Messages received', i.received), tile('Messages you sent', i.sent),
      tile('Typical time to answer', dur(i.replyTimeMs.median)), tile('Answered within an hour', i.answeredWithinHour == null ? '—' : `${i.answeredWithinHour}%`),
      tile('Waiting over an hour now', i.waitingOverHour),
    );
    body.appendChild(section('Chats', tiles, el('p', 'muted small-note', 'Automatic replies and the assistant do not count as answers. Based on who wrote when; message text is never read.')));
    const max = Math.max(1, ...i.busiestHours);
    const bars = el('div', 'hour-bars');
    i.busiestHours.forEach((n, h) => { const b = el('div', 'hour-bar'); b.style.height = `${Math.round((n / max) * 100)}%`; b.title = `${h}:00 · ${n} messages`; bars.appendChild(b); });
    const axis = el('div', 'hour-axis');
    for (const h of [0, 6, 12, 18, 23]) axis.appendChild(el('span', '', `${h}h`));
    body.appendChild(section(`When customers write (${i.timezone})`, bars, axis));
    const dmax = Math.max(1, ...Object.values(i.weekdays));
    const days7 = el('div', 'stat-grid');
    for (const [d, n] of Object.entries(i.weekdays)) days7.appendChild(tile(d, n));
    body.appendChild(section('By weekday', days7));
    const ot = el('div', 'stat-grid');
    ot.append(tile('Orders', i.orders.count), tile('Sales (not cancelled)', money(i.orders.revenue, i.orders.currency)));
    const top5 = el('ul', 'order-items');
    i.orders.topProducts.forEach((p) => top5.appendChild(el('li', '', `${p.name}: ${p.qty}`)));
    body.appendChild(section('Orders', ot, i.orders.topProducts.length ? top5 : null));
    void dmax;
  }

  // ----- filter of the chat list by label -----

  function paintFilter() {
    const box = $('#label-filter');
    if (!box) return;
    box.textContent = '';
    box.classList.toggle('hidden', !state.labels.length);
    if (!state.labels.length) { state.filter = null; return; }
    const chip = (l) => {
      const b = el('button', `chip-btn${state.filter === (l?.id || null) ? ' on' : ''}`, l ? l.name : 'All');
      b.type = 'button';
      if (l) b.prepend(labelDot(l), ' ');
      b.addEventListener('click', () => { state.filter = l ? (state.filter === l.id ? null : l.id) : null; paintFilter(); renderChatList(); });
      box.appendChild(b);
    };
    chip(null);
    state.labels.forEach(chip);
  }

  const passesFilter = (convId) => !state.filter || (state.chats[convId] || []).includes(state.filter);

  $('#btn-biztools')?.addEventListener('click', open);

  return { load, open, quickMatches, labelsOf, labelDot, chatLabelsDialog, orderDialog, orderCard, paintFilter, passesFilter, get hasLabels() { return state.labels.length > 0; }, get quick() { return state.quick; } };
};
