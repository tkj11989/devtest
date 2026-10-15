'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const { addPeriod } = require('../server/payments');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const app = createApp({ store, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token) => {
    const s = connect(base, { auth: { token, appSession: 'x' }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { store, app, client, api };
}

const enc = encodeURIComponent;

test('plans: a month is a calendar month, a year is a year', () => {
  const at = (s) => Date.parse(s);
  assert.strictEqual(addPeriod(at('2026-01-31T10:00:00Z'), { months: 1 }), at('2026-02-28T10:00:00Z'));
  assert.strictEqual(addPeriod(at('2028-01-31T10:00:00Z'), { months: 1 }), at('2028-02-29T10:00:00Z'));
  assert.strictEqual(addPeriod(at('2026-12-15T00:00:00Z'), { months: 1 }), at('2027-01-15T00:00:00Z'));
  assert.strictEqual(addPeriod(at('2028-02-29T00:00:00Z'), { years: 1 }), at('2029-02-28T00:00:00Z'));
  assert.strictEqual(addPeriod(at('2026-03-01T08:00:00Z'), { days: 1 }), at('2026-03-02T08:00:00Z'));
});

test('free accounts: 3 locked chats and 1 hidden chat, then Premium is required', async (t) => {
  const { store, client, api } = await setup(t, { payments: { sandbox: true } });
  const alice = store.register('alice', 'pass');
  const chats = ['bob1', 'bob2', 'bob3', 'bob4', 'bob5'].map((u) => { store.register(u, 'pass'); return store.getOrCreateDirect('alice', u).id; });
  store.setLockCode('alice', '2468');
  const s = await client(alice.token);

  for (const id of chats.slice(0, 3)) assert.ok((await call(s, 'chatlock:lock', { convId: id })).ok);
  const fourth = await call(s, 'chatlock:lock', { convId: chats[3] });
  assert.deepStrictEqual([fourth.ok, fourth.code], [false, 'premium_required']);
  assert.match(fourth.error, /up to 3 chats/);
  const rest = await api('PUT', `/conversations/${enc(chats[3])}/lock`, { token: alice.token });
  assert.deepStrictEqual([rest.status, rest.body.error.code], [402, 'premium_required']);
  assert.strictEqual((await call(s, 'chatlock:lock', { convId: chats[0] })).ok, true, 'locking a chat that is already locked is fine');
  assert.strictEqual((await call(s, 'chatlock:remove', { convId: chats[0], code: '2468' })).ok, true);
  assert.ok((await call(s, 'chatlock:lock', { convId: chats[3] })).ok, 'a freed slot can be reused');

  // One hidden chat; hiding a locked chat swaps its lock for hiding.
  assert.ok((await call(s, 'hidden:hide', { convId: chats[1] })).ok);
  const second = await call(s, 'hidden:hide', { username: 'bob5' });
  assert.deepStrictEqual([second.ok, second.code], [false, 'premium_required']);
  assert.match(second.error, /hide 1 chat/);
  assert.strictEqual((await api('PUT', '/hidden-contacts/bob5', { token: alice.token })).status, 402);
  assert.strictEqual((await call(s, 'hidden:hide', { convId: chats[1] })).ok, true, 'already hidden: no change');
  assert.strictEqual(store.getConversation('dm:alice:bob5') !== undefined, true);

  const sub = (await api('GET', '/me/subscription', { token: alice.token })).body;
  assert.deepStrictEqual([sub.premium, sub.plan, sub.usage, sub.limits.free], [false, null, { chatLocks: 2, hiddenChats: 1 }, { chatLocks: 3, hiddenChats: 1 }]);
  assert.deepStrictEqual(sub.plans.map((p) => [p.id, p.currency]), [['daily', 'INR'], ['monthly', 'INR'], ['yearly', 'INR']]);
});

test('premium (sandbox payment): unlimited, badge for everyone, plans stack', async (t) => {
  const { store, client, api } = await setup(t, { payments: { sandbox: true } });
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  store.getOrCreateDirect('alice', 'bob');
  const sa = await client(alice.token);
  const sb = await client(bob.token);
  const pay = async (plan) => {
    const order = await api('POST', '/me/subscription/checkout', { token: alice.token, body: { plan } });
    assert.deepStrictEqual([order.status, order.body.paymentUrl, order.body.sandbox, order.body.currency], [200, null, true, 'INR']);
    return api('POST', '/me/subscription/confirm', { token: alice.token, body: { orderId: order.body.orderId } });
  };
  assert.strictEqual((await api('POST', '/me/subscription/checkout', { token: alice.token, body: { plan: 'weekly' } })).status, 400);
  assert.strictEqual((await api('POST', '/me/subscription/confirm', { token: alice.token, body: { orderId: 'nope' } })).status, 404);

  const seen = next(sb, 'user:updated');
  const daily = await pay('daily');
  assert.deepStrictEqual([daily.status, daily.body.premium, daily.body.plan], [200, true, 'daily']);
  assert.strictEqual((await seen).user.premium, true, 'others see the Premium badge live');
  assert.strictEqual((await api('GET', '/users/alice', { token: bob.token })).body.user.premium, true);
  assert.strictEqual((await api('GET', '/users/bob', { token: alice.token })).body.user.premium, undefined);
  const dayEnd = daily.body.expiresAt;
  assert.ok(Math.abs(dayEnd - (Date.now() + 86400000)) < 5000);

  // Buying again while Premium extends it from the current end.
  const monthly = await pay('monthly');
  assert.strictEqual(monthly.body.expiresAt, addPeriod(dayEnd, { months: 1 }));
  const yearly = await pay('yearly');
  assert.strictEqual(yearly.body.expiresAt, addPeriod(monthly.body.expiresAt, { years: 1 }));

  // No limits now.
  store.setLockCode('alice', '2468');
  for (let i = 0; i < 6; i++) {
    store.register(`cat${i}`, 'pass');
    const id = store.getOrCreateDirect('alice', `cat${i}`).id;
    assert.ok((await call(sa, 'chatlock:lock', { convId: id })).ok);
    if (i < 3) assert.ok((await call(sa, 'hidden:hide', { convId: id })).ok);
  }
  assert.deepStrictEqual((await call(sa, 'subscription:status')).usage, { chatLocks: 3, hiddenChats: 3 });
  // Nothing about payments but the plan and dates is stored.
  assert.deepStrictEqual(Object.keys(store.data.users.alice.subscription).sort(), ['expiresAt', 'plan', 'since']);
});

test('premium ending: badge goes, existing chats stay protected, no new ones', async (t) => {
  const { store, client, api } = await setup(t, { payments: { sandbox: true }, subscriptionSweepMs: 30 });
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const chats = ['bob1', 'bob2', 'bob3', 'bob4', 'bob5'].map((u) => { store.register(u, 'pass'); return store.getOrCreateDirect('alice', u).id; });
  store.getOrCreateDirect('alice', 'bob');
  store.setLockCode('alice', '2468');
  const sa = await client(alice.token);
  const sb = await client(bob.token);
  store.activateSubscription('alice', { plan: 'daily', expiresAt: Date.now() + 250 });
  assert.strictEqual(store.isPremium('alice'), true);
  for (const id of chats) assert.ok((await call(sa, 'chatlock:lock', { convId: id })).ok);
  assert.strictEqual(store.lockedChats('alice').length, 5, 'Premium lets you lock all five');

  const updated = next(sa, 'subscription:update');
  const peers = next(sb, 'user:updated');
  const view = await updated;
  assert.deepStrictEqual([view.premium, view.expired], [false, true]);
  assert.strictEqual((await peers).user.premium, undefined, 'badge removed everywhere');
  assert.strictEqual(store.lockedChats('alice').length, 5, 'chats that were locked stay locked (never exposed)');
  const more = await call(sa, 'chatlock:lock', { convId: store.getOrCreateDirect('alice', 'bob').id });
  assert.strictEqual(more.code, 'premium_required');
  assert.strictEqual((await call(sa, 'chatlock:remove', { convId: chats[0], code: '2468' })).ok, true, 'removing is always allowed');
  assert.strictEqual((await api('GET', '/me/subscription', { token: alice.token })).body.expired, true);
});

test('payment gateway: unpaid orders, one-time orders, other users, failures, unavailable', async (t) => {
  const paid = new Set();
  let down = false;
  const created = [];
  const gateway = async (body) => {
    if (down) throw new Error('boom');
    if (body.action === 'create') { created.push(body); return { paymentUrl: `https://pay.example/${body.reference}` }; }
    return { paid: paid.has(body.reference) };
  };
  const { store, api } = await setup(t, { payments: { gateway } });
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');

  const order = (await api('POST', '/me/subscription/checkout', { token: alice.token, body: { plan: 'monthly' } })).body;
  assert.deepStrictEqual([order.paymentUrl.startsWith('https://pay.example/ord_'), order.sandbox, order.amount], [true, false, 99]);
  assert.deepStrictEqual(created[0], { action: 'create', reference: order.orderId, plan: 'monthly', amount: 99, currency: 'INR', user: 'alice' });
  const confirm = (token, orderId) => api('POST', '/me/subscription/confirm', { token, body: { orderId } });

  const pending = await confirm(alice.token, order.orderId);
  assert.deepStrictEqual([pending.status, pending.body.error.code], [402, 'payment_pending']);
  assert.strictEqual(store.isPremium('alice'), false);
  paid.add(order.orderId);
  assert.strictEqual((await confirm(bob.token, order.orderId)).status, 404, "someone else's order");
  assert.strictEqual((await confirm(alice.token, order.orderId)).body.premium, true);
  assert.strictEqual((await confirm(alice.token, order.orderId)).status, 404, 'a paid order works once');

  down = true;
  assert.strictEqual((await api('POST', '/me/subscription/checkout', { token: bob.token, body: { plan: 'daily' } })).body.error.code, 'payment_gateway_failed');
  down = false;
  const o2 = (await api('POST', '/me/subscription/checkout', { token: bob.token, body: { plan: 'daily' } })).body;
  down = true;
  assert.strictEqual((await confirm(bob.token, o2.orderId)).status, 502);
  assert.strictEqual(store.isPremium('bob'), false);

  const none = await setup(t);
  const c = none.store.register('carol', 'pass');
  assert.deepStrictEqual((await none.api('GET', '/me/subscription', { token: c.token })).body.available, false);
  const r = await none.api('POST', '/me/subscription/checkout', { token: c.token, body: { plan: 'daily' } });
  assert.deepStrictEqual([r.status, r.body.error.code], [503, 'payments_unavailable']);
});
