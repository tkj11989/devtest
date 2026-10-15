'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const BusinessHours = require('../public/business-hours.js');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));

const ALWAYS_CLOSED = Object.fromEntries(BusinessHours.DAYS.map((d) => [d, { mode: 'closed' }]));
const ALWAYS_OPEN = Object.fromEntries(BusinessHours.DAYS.map((d) => [d, { mode: 'open24' }]));

test('business hours: open now, overnight hours and time zones', () => {
  const biz = {
    timezone: 'Asia/Kolkata',
    hours: BusinessHours.normaliseHours({
      mon: { mode: 'hours', open: '09:00', close: '18:00' },
      tue: { mode: 'hours', open: '20:00', close: '02:00' },
      sat: { mode: 'open24' },
    }),
  };
  const at = (iso) => BusinessHours.isOpenNow(biz, new Date(iso));
  // 2026-10-12 is a Monday; India is UTC+5:30.
  assert.strictEqual(at('2026-10-12T04:30:00Z'), true, 'Mon 10:00');
  assert.strictEqual(at('2026-10-12T13:30:00Z'), false, 'Mon 19:00');
  assert.strictEqual(at('2026-10-13T17:30:00Z'), true, 'Tue 23:00');
  assert.strictEqual(at('2026-10-13T19:30:00Z'), true, 'Wed 01:00, still open from Tuesday night');
  assert.strictEqual(at('2026-10-13T21:30:00Z'), false, 'Wed 03:00');
  assert.strictEqual(at('2026-10-17T10:00:00Z'), true, 'Saturday 24h');
  assert.strictEqual(at('2026-10-18T10:00:00Z'), false, 'Sunday closed by default');
  assert.strictEqual(BusinessHours.describeDay(biz.hours.tue), '8:00 PM – 2:00 AM');
  assert.throws(() => BusinessHours.normaliseHours({ mon: { mode: 'hours', open: '9am', close: '5pm' } }), /HH:MM/);
});

test('store: business profile validation; greeting/away texts stay private', () => {
  const store = new Store({ file: null });
  store.register('pizza', 'pass', 'Pizza Palace');
  assert.throws(() => store.setBusiness('pizza', { category: 'Spaceships' }), /category must be one of/);
  assert.throws(() => store.setBusiness('pizza', { category: 'Restaurant', email: 'nope' }), /email/);
  assert.throws(() => store.setBusiness('pizza', { category: 'Restaurant', timezone: 'Mars/Olympus' }), /time zone/);
  assert.throws(() => store.setBusiness('pizza', { category: 'Restaurant', greeting: { enabled: true, text: '' } }), /needs text/);

  const b = store.setBusiness('pizza', {
    category: 'Restaurant',
    website: 'pizza.example',
    email: 'hi@pizza.example',
    timezone: 'Europe/London',
    greeting: { enabled: true, text: 'Welcome!' },
  });
  assert.strictEqual(b.website, 'https://pizza.example/');
  const pub = store.publicUser('pizza').business;
  assert.deepStrictEqual([pub.category, pub.greeting, pub.away], ['Restaurant', undefined, undefined]);
  assert.strictEqual(store.searchUsers('restaur', 'x')[0].username, 'pizza', 'findable by category');
  store.removeBusiness('pizza');
  assert.strictEqual(store.publicUser('pizza').business, undefined);
});

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token) => {
    const s = connect(base, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r) => s.once('connect', r));
    return s;
  };
  return { store, client, base };
}

test('auto replies: greeting for new conversations, away outside hours (rate-limited)', async (t) => {
  const { store, client } = await setup(t);
  const shop = store.register('shop', 'pass', 'Corner Shop');
  store.setContact('shop', 'sms', '+919800000001');
  store.setContact('shop', 'email', 'hi@shop.example');
  const cust = store.register('cust', 'pass');
  const shopApp = await client(shop.token);
  const custApp = await client(cust.token);

  const setRes = await call(shopApp, 'business:set', {
    category: 'Retail',
    timezone: 'UTC',
    hours: ALWAYS_CLOSED,
    greeting: { enabled: true, text: 'Hi! Thanks for contacting Corner Shop.' },
    away: { enabled: true, text: "We're closed right now." },
  });
  assert.ok(setRes.ok, setRes.error);
  assert.strictEqual(setRes.user.business.category, 'Retail');

  const dm = (await call(custApp, 'chat:direct', { username: 'shop' })).conversation;
  await call(custApp, 'message:send', { convId: dm.id, text: 'Do you have milk?' });
  let msgs = (await call(custApp, 'messages:get', { convId: dm.id })).messages;
  assert.deepStrictEqual(msgs.map((m) => [m.from, m.auto || null]), [['cust', null], ['shop', 'greeting'], ['shop', 'away']]);

  // A second message right after: no new greeting, and the away message isn't repeated.
  await call(custApp, 'message:send', { convId: dm.id, text: 'Hello?' });
  msgs = (await call(custApp, 'messages:get', { convId: dm.id })).messages;
  assert.strictEqual(msgs.filter((m) => m.auto).length, 2);

  // Open hours: no away message. Two quiet weeks later: greeted again.
  await call(shopApp, 'business:set', { ...store.getBusiness('shop'), hours: ALWAYS_OPEN });
  store.data.messages[dm.id].forEach((m) => { m.ts -= 15 * 24 * 3600 * 1000; store._touchMsg(dm.id, m); });
  await call(custApp, 'message:send', { convId: dm.id, text: 'Back again' });
  msgs = (await call(custApp, 'messages:get', { convId: dm.id })).messages;
  assert.deepStrictEqual(msgs.slice(-2).map((m) => m.auto || m.text), ['Back again', 'greeting']);

  // The business's own messages never trigger auto replies; blocked customers get none.
  const before = store.data.messages[dm.id].length;
  await call(shopApp, 'message:send', { convId: dm.id, text: 'Here you go' });
  assert.strictEqual(store.data.messages[dm.id].length, before + 1);
  store.setBlocked('shop', 'cust', true);
  store.data.messages[dm.id].forEach((m) => { m.ts -= 15 * 24 * 3600 * 1000; store._touchMsg(dm.id, m); });
  await call(custApp, 'message:send', { convId: dm.id, text: 'hello??' });
  assert.ok(!store.data.messages[dm.id].slice(-1)[0].auto);

  // Customers see the public business profile, without the auto-reply texts.
  const seen = (await call(custApp, 'conversations')).users.shop;
  assert.strictEqual(seen.business.category, 'Retail');
  assert.strictEqual(seen.business.greeting, undefined);
  assert.strictEqual((await call(shopApp, 'business:get')).business.greeting.enabled, true);
});

test('api: business profile over REST', async (t) => {
  const { store, base } = await setup(t);
  const token = store.register('cafe', 'pass', 'Cafe').token;
  const other = store.register('visitor', 'pass').token;
  const api = async (method, path, tok, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  assert.deepStrictEqual((await api('GET', '/me/business', token)).body, { business: null });
  // A business needs a verified mobile number and email (verified over OTP in auth.test.js).
  const unverified = await api('PUT', '/me/business', token, { category: 'Restaurant' });
  assert.deepStrictEqual([unverified.status, unverified.body.error.code], [400, 'verification_required']);
  store.setContact('cafe', 'sms', '+919800000002');
  store.setContact('cafe', 'email', 'hello@cafe.example');
  const put = await api('PUT', '/me/business', token, {
    category: 'Restaurant',
    timezone: 'Asia/Kolkata',
    hours: { mon: { mode: 'hours', open: '08:00', close: '20:00' } },
    away: { enabled: true, text: 'Closed now' },
  });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.business.hours.tue.mode, 'closed');
  assert.strictEqual(put.body.business.email, 'hello@cafe.example', 'contact email is the verified email');
  assert.strictEqual((await api('PUT', '/me/business', token, { category: 'Nope' })).status, 400);
  const seen = await api('GET', '/users/cafe', other);
  assert.deepStrictEqual([seen.body.user.business.category, seen.body.user.business.away], ['Restaurant', undefined]);
  assert.strictEqual((await api('GET', '/me', token)).body.business.away.text, 'Closed now');
  assert.strictEqual((await api('DELETE', '/me/business', token)).body.business, null);
});
