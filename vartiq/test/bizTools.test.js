'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const u = {};
  for (const n of ['shop', 'cust', 'cust2']) {
    const r = store.register(n, 'pass', n);
    const s = connect(base, { auth: { token: r.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((ok) => s.once('connect', ok));
    u[n] = { token: r.token, s };
  }
  store.setBusiness('shop', { category: 'Retail', timezone: 'Asia/Kolkata', upi: 'Shop@OkBank' });
  const tea = store.addProduct('shop', { name: 'Tea', price: 120 });
  const cake = store.addProduct('shop', { name: 'Cake', price: 450.5 });
  const dm = store.getOrCreateDirect('shop', 'cust');
  const rest = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, u, dm, tea, cake, rest, base };
}

test('quick replies: business only, unique shortcut, edit, delete, limit', async (t) => {
  const { store, u, rest } = await setup(t);
  assert.strictEqual((await call(u.cust.s, 'quick:list')).code, 'forbidden');
  const made = await rest(u.shop.token, 'POST', '/business/quick-replies', { shortcut: '/Hours', text: 'Open 9 to 6' });
  assert.strictEqual(made.status, 201);
  assert.deepStrictEqual(made.body.quickReplies.map((q) => q.shortcut), ['hours']);
  assert.strictEqual((await rest(u.shop.token, 'POST', '/business/quick-replies', { shortcut: 'hours', text: 'again' })).status, 409);
  assert.strictEqual((await rest(u.shop.token, 'POST', '/business/quick-replies', { shortcut: 'bad shortcut', text: 'x' })).status, 400);
  assert.strictEqual((await rest(u.shop.token, 'POST', '/business/quick-replies', { shortcut: 'empty', text: ' ' })).status, 400);
  const id = made.body.quickReplies[0].id;
  assert.strictEqual((await rest(u.shop.token, 'PUT', `/business/quick-replies/${id}`, { shortcut: 'hours', text: 'Open 10 to 7' })).body.quickReplies[0].text, 'Open 10 to 7');
  assert.strictEqual((await rest(u.shop.token, 'DELETE', `/business/quick-replies/${id}`)).body.quickReplies.length, 0);
  for (let i = 0; i < Store.MAX_QUICK_REPLIES; i++) store.saveQuickReply('shop', { shortcut: `q${i}`, text: 'x' });
  assert.strictEqual((await rest(u.shop.token, 'POST', '/business/quick-replies', { shortcut: 'one_more', text: 'x' })).status, 409);
});

test('labels: make, put on chats, rename, delete removes them from chats', async (t) => {
  const { store, u, dm, rest } = await setup(t);
  const a = (await rest(u.shop.token, 'POST', '/business/labels', { name: 'VIP', color: '#43a047' })).body.labels[0];
  const b = (await rest(u.shop.token, 'POST', '/business/labels', { name: 'New', color: 'nonsense' })).body.labels[1];
  assert.strictEqual(b.color, Store.LABEL_COLORS[0], 'unknown colours become the first one');
  assert.strictEqual((await rest(u.shop.token, 'POST', '/business/labels', { name: 'vip' })).status, 409);
  const set = await rest(u.shop.token, 'PUT', `/conversations/${encodeURIComponent(dm.id)}/labels`, { ids: [a.id, b.id, 'ghost'] });
  assert.deepStrictEqual(set.body.ids, [a.id, b.id]);
  assert.deepStrictEqual((await rest(u.shop.token, 'GET', '/business/labels')).body.chats[dm.id], [a.id, b.id]);
  await rest(u.shop.token, 'PUT', `/business/labels/${a.id}`, { name: 'Very important' });
  assert.strictEqual(store.data.users.shop.labels[0].name, 'Very important');
  await rest(u.shop.token, 'DELETE', `/business/labels/${a.id}`);
  assert.deepStrictEqual((await rest(u.shop.token, 'GET', '/business/labels')).body.chats[dm.id], [b.id]);
  assert.strictEqual((await rest(u.cust.token, 'GET', '/business/labels')).status, 403);
  assert.strictEqual((await rest(u.shop.token, 'PUT', '/conversations/nope/labels', { ids: [] })).status, 404);
});

test('orders: the catalogue sets the prices; the business moves it on; the customer can cancel early; UPI id is public', async (t) => {
  const { store, u, dm, tea, cake, rest } = await setup(t);
  assert.strictEqual(store.getBusiness('shop').upi, 'shop@okbank');
  assert.strictEqual((await rest(u.cust.token, 'GET', '/users/shop')).body.user.business.upi, 'shop@okbank');
  assert.strictEqual((await rest(u.cust.token, 'GET', '/users/shop')).body.user.business.orderSeq, undefined);
  const heard = once(u.shop.s, 'message:new');
  const res = await call(u.cust.s, 'order:place', { convId: dm.id, items: [{ id: tea.id, qty: 2 }, { id: cake.id, qty: 1, price: 1 }], note: 'after 6 pm', clientId: 'c1' });
  assert.ok(res.ok, res.error);
  const o = res.message.order;
  assert.deepStrictEqual([o.number, o.total, o.currency, o.status, o.paid, res.message.type, res.message.text], [1, 690.5, 'INR', 'placed', false, 'order', 'Order #1']);
  assert.strictEqual((await heard).message.order.items[1].price, 450.5, 'price from the catalogue');
  assert.strictEqual((await call(u.cust.s, 'order:place', { convId: dm.id, items: [{ id: tea.id, qty: 2 }], clientId: 'c1' })).message.id, res.message.id, 'retry gives the same order');
  assert.strictEqual(store.getBusiness('shop').orderSeq, 1);
  for (const bad of [[], [{ id: 'nope', qty: 1 }], [{ id: tea.id, qty: 0 }], [{ id: tea.id, qty: 100 }], [{ id: tea.id, qty: 1 }, { id: tea.id, qty: 1 }]]) {
    assert.strictEqual((await call(u.cust.s, 'order:place', { convId: dm.id, items: bad })).code, 'invalid_request');
  }
  assert.strictEqual((await call(u.shop.s, 'order:place', { convId: dm.id, items: [{ id: tea.id, qty: 1 }] })).code, 'invalid_request', 'a business does not order');
  // The business moves it on; it cannot go back; the customer cannot confirm or mark paid.
  const upd = once(u.cust.s, 'order:update');
  assert.strictEqual((await call(u.shop.s, 'order:update', { id: res.message.id, status: 'confirmed' })).message.order.status, 'confirmed');
  assert.strictEqual((await upd).message.order.status, 'confirmed');
  assert.strictEqual((await call(u.cust.s, 'order:update', { id: res.message.id, status: 'shipped' })).code, 'forbidden');
  assert.strictEqual((await call(u.cust.s, 'order:update', { id: res.message.id, paid: true })).code, 'forbidden');
  assert.strictEqual((await call(u.shop.s, 'order:update', { id: res.message.id, status: 'placed' })).code, 'conflict');
  assert.strictEqual((await call(u.shop.s, 'order:update', { id: res.message.id, paid: true })).message.order.paid, true);
  assert.strictEqual((await call(u.shop.s, 'order:update', { id: res.message.id, status: 'packed' })).message.order.status, 'packed');
  assert.strictEqual((await call(u.cust.s, 'order:update', { id: res.message.id, status: 'cancelled' })).code, 'forbidden', 'too late once packed');
  await call(u.shop.s, 'order:update', { id: res.message.id, status: 'delivered' });
  assert.strictEqual((await call(u.shop.s, 'order:update', { id: res.message.id, status: 'cancelled' })).code, 'conflict');
  assert.deepStrictEqual(store.findMessage(res.message.id).message.order.history.map((h) => h.status), ['placed', 'confirmed', 'paid', 'packed', 'delivered']);
  // A second order, cancelled by the customer early; the list for the business.
  const two = (await call(u.cust.s, 'order:place', { convId: dm.id, items: [{ id: cake.id, qty: 1 }] })).message;
  assert.strictEqual((await call(u.cust.s, 'order:update', { id: two.id, status: 'cancelled' })).message.order.status, 'cancelled');
  const list = await rest(u.shop.token, 'GET', '/business/orders');
  assert.deepStrictEqual(list.body.orders.map((x) => x.order.number), [2, 1]);
  assert.deepStrictEqual((await rest(u.shop.token, 'GET', '/business/orders?status=delivered')).body.orders.map((x) => x.order.number), [1]);
  assert.strictEqual((await call(u.cust2.s, 'order:update', { id: res.message.id, status: 'cancelled' })).code, 'not_found');
  // The catalogue price changing later does not change an order already placed.
  store.updateProduct('shop', tea.id, { price: 999 });
  assert.strictEqual(store.findMessage(res.message.id).message.order.total, 690.5);
});

test('insights: new customers, answer time without automatic replies, busiest hours, waiting, orders', async (t) => {
  const { store, dm, tea } = await setup(t);
  const H = 3600000;
  const day = Date.UTC(2026, 10, 9, 0, 0, 0); // Monday 9 Nov 2026
  const at = (hourUtc, min = 0) => day + hourUtc * H + min * 60000;
  const push = (from, ts, extra = {}) => { const m = store.addMessage(dm.id, from, 'x', extra); m.ts = ts; store._touchMsg(dm.id, m); return m; };
  push('cust', at(4, 0));           // 09:30 IST: customer writes
  push('shop', at(4, 5), { auto: 'greeting' }); // automatic: not an answer
  push('shop', at(4, 20));          // answered after 20 minutes
  push('cust', at(8, 0));           // 13:30 IST
  push('shop', at(11, 0));          // answered after 3 hours
  push('cust', at(12, 0));          // still waiting
  const order = store.buildOrder('shop', [{ id: tea.id, qty: 3 }], '');
  push('cust', at(12, 30), { order });
  const now = at(20);
  const i = store.businessInsights('shop', { days: 30 }, now);
  assert.strictEqual(i.newCustomers, 1);
  assert.deepStrictEqual([i.received, i.sent, i.automatic], [4, 2, 1]);
  assert.strictEqual(i.answered, 2);
  assert.deepStrictEqual(i.replyTimeMs, { median: 3 * H, p90: 3 * H });
  assert.strictEqual(i.answeredWithinHour, 50);
  assert.strictEqual(i.waitingOverHour, 1);
  assert.strictEqual(i.busiestHours[9], 1);
  assert.strictEqual(i.weekdays.Mon, 4);
  assert.deepStrictEqual(i.orders, { count: 1, revenue: 360, currency: 'INR', byStatus: { placed: 1 }, topProducts: [{ name: 'Tea', qty: 3 }] });
  assert.throws(() => store.businessInsights('cust'), (e) => e.code === 'forbidden');
  assert.strictEqual(store.businessInsights('shop', { days: 1 }, now + 5 * 86400000).received, 0, 'only the days asked for');
});

test('UPI id is checked, kept when the profile is saved without it; click-to-chat link redirects', async (t) => {
  const { store, base } = await setup(t);
  assert.throws(() => store.setBusiness('shop', { category: 'Retail', upi: 'not a upi' }), /UPI/);
  store.setBusiness('shop', { category: 'Retail', timezone: 'Asia/Kolkata' });
  assert.strictEqual(store.getBusiness('shop').upi, 'shop@okbank');
  store.setBusiness('shop', { category: 'Retail', timezone: 'Asia/Kolkata', upi: '' });
  assert.strictEqual(store.getBusiness('shop').upi, undefined);
  const res = await fetch(`${base}/c/shop?text=${encodeURIComponent('Hi, price?')}`, { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/#chat=shop&text=Hi%2C%20price%3F');
});
