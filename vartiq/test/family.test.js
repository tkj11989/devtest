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
  for (const n of ['mum', 'dad', 'kid', 'zed']) {
    const r = store.register(n, 'pass', n);
    const s = connect(base, { auth: { token: r.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((ok) => s.once('connect', ok));
    u[n] = { token: r.token, s };
  }
  const g = store.createGroup('mum', 'Home', ['dad', 'kid']);
  const rest = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, u, g, rest };
}

test('family space: only admins turn it on; tools need it', async (t) => {
  const { store, u, g } = await setup(t);
  assert.strictEqual((await call(u.kid.s, 'family:set', { convId: g.id, enabled: true })).code, 'forbidden');
  assert.strictEqual((await call(u.mum.s, 'family:overview', { convId: g.id })).code, 'invalid_request');
  assert.strictEqual((await call(u.mum.s, 'family:checkin', { convId: g.id, kind: 'home' })).code, 'invalid_request');
  const on = await call(u.mum.s, 'family:set', { convId: g.id, enabled: true });
  assert.ok(on.ok, on.error);
  assert.strictEqual(on.conversation.family, true);
  assert.strictEqual(on.conversation.lists, undefined, 'lists are not part of the chat list');
  assert.strictEqual((await call(u.zed.s, 'family:overview', { convId: g.id })).code, 'not_found');
  const ov = await call(u.kid.s, 'family:overview', { convId: g.id });
  assert.deepStrictEqual(ov.lists.map((l) => l.name), ['Groceries']);
  assert.ok(store.getConversation(g.id).family);
});

test('shared lists: everyone edits, everyone hears, limits apply', async (t) => {
  const { store, u, g, rest } = await setup(t);
  await call(u.mum.s, 'family:set', { convId: g.id, enabled: true });
  const id = encodeURIComponent(g.id);
  const lists = (await call(u.mum.s, 'family:overview', { convId: g.id })).lists;
  const gro = lists[0].id;
  const heard = once(u.dad.s, 'family:update');
  const add = await rest(u.kid.token, 'POST', `/groups/${id}/family/lists/${gro}/items`, { text: 'Milk' });
  assert.strictEqual(add.status, 201);
  assert.strictEqual((await heard).lists[0].items[0].text, 'Milk');
  const itemId = add.body.lists[0].items[0].id;
  const done = await rest(u.dad.token, 'PUT', `/groups/${id}/family/lists/${gro}/items/${itemId}`, { done: true });
  assert.deepStrictEqual([done.body.lists[0].items[0].done, done.body.lists[0].items[0].doneBy], [true, 'dad']);
  await rest(u.mum.token, 'POST', `/groups/${id}/family/lists/${gro}/items`, { text: 'Eggs' });
  assert.strictEqual((await rest(u.mum.token, 'POST', `/groups/${id}/family/lists/${gro}/clear-done`)).body.lists[0].items.length, 1);
  assert.strictEqual((await rest(u.mum.token, 'POST', `/groups/${id}/family/lists/${gro}/items`, { text: '  ' })).status, 400);
  assert.strictEqual((await rest(u.mum.token, 'POST', `/groups/${id}/family/lists`, { name: 'To do' })).status, 201);
  assert.strictEqual((await rest(u.mum.token, 'PUT', `/groups/${id}/family/lists/${gro}`, { name: 'Shopping' })).body.lists[0].name, 'Shopping');
  for (let i = 0; i < Store.MAX_LISTS; i++) await rest(u.mum.token, 'POST', `/groups/${id}/family/lists`, { name: `L${i}` });
  assert.strictEqual((await rest(u.mum.token, 'POST', `/groups/${id}/family/lists`, { name: 'one more' })).status, 409);
  assert.strictEqual((await rest(u.mum.token, 'DELETE', `/groups/${id}/family/lists/nope`)).status, 404);
  assert.strictEqual((await rest(u.zed.token, 'POST', `/groups/${id}/family/lists/${gro}/items`, { text: 'x' })).status, 404);
  void store;
});

test('check-ins: home, late with a note, help; the overview lists them and the events coming up', async (t) => {
  const { store, u, g, rest } = await setup(t);
  await call(u.mum.s, 'family:set', { convId: g.id, enabled: true });
  const heard = once(u.mum.s, 'message:new');
  const home = await call(u.kid.s, 'family:checkin', { convId: g.id, kind: 'home' });
  assert.ok(home.ok, home.error);
  assert.deepStrictEqual([home.message.type, home.message.checkin.kind], ['checkin', 'home']);
  assert.strictEqual((await heard).message.checkin.kind, 'home');
  await call(u.kid.s, 'family:checkin', { convId: g.id, kind: 'late', note: 'Bus is stuck, 20 minutes' });
  assert.strictEqual((await call(u.kid.s, 'family:checkin', { convId: g.id, kind: 'dance' })).code, 'invalid_request');
  assert.strictEqual((await rest(u.dad.token, 'POST', `/groups/${encodeURIComponent(g.id)}/family/checkins`, { kind: 'request' })).status, 201);
  const soon = store.addMessage(g.id, 'mum', 'Dinner', { event: { title: 'Dinner at nani\'s', startsAt: Date.now() + 86400000, place: 'Nani' } });
  void soon;
  store.addMessage(g.id, 'mum', 'Old', { event: { title: 'Past', startsAt: Date.now() - 5 * 86400000 } });
  const ov = (await rest(u.kid.token, 'GET', `/groups/${encodeURIComponent(g.id)}/family`)).body;
  assert.deepStrictEqual(ov.checkins.map((c) => [c.from, c.kind, c.note]), [['dad', 'request', ''], ['kid', 'late', 'Bus is stuck, 20 minutes'], ['kid', 'home', '']]);
  assert.deepStrictEqual(ov.events.map((e) => e.title), ['Dinner at nani\'s']);
});

test('bedtime: validated, overnight window, and it silences notifications except for the family and help', async (t) => {
  const { store, u, g, rest } = await setup(t);
  assert.strictEqual((await rest(u.kid.token, 'PUT', '/me/bedtime', { on: true, from: '25:00', to: '06:00' })).status, 400);
  assert.strictEqual((await rest(u.kid.token, 'PUT', '/me/bedtime', { on: true, from: '22:00', to: '06:00', timezone: 'Mars/Base' })).status, 400);
  const set = await rest(u.kid.token, 'PUT', '/me/bedtime', { on: true, from: '22:00', to: '06:00', timezone: 'Asia/Kolkata' });
  assert.strictEqual(set.status, 200);
  const at = (h, m = 0) => Date.UTC(2026, 10, 9, h, m) - 5.5 * 3600000; // IST clock h:m
  assert.strictEqual(store.inBedtime('kid', at(23, 0)), true);
  assert.strictEqual(store.inBedtime('kid', at(2, 30)), true);
  assert.strictEqual(store.inBedtime('kid', at(6, 0)), false);
  assert.strictEqual(store.inBedtime('kid', at(12, 0)), false);
  assert.strictEqual(store.inBedtime('mum', at(23, 0)), false, 'only for people who turned it on');
  await rest(u.kid.token, 'PUT', '/me/bedtime', { on: false });
  assert.strictEqual(store.inBedtime('kid', at(23, 0)), false);
  assert.strictEqual((await rest(u.kid.token, 'GET', '/me/bedtime')).body.bedtime.on, false);
  // Who counts as family.
  await call(u.mum.s, 'family:set', { convId: g.id, enabled: true });
  assert.strictEqual(store.sharesFamily('kid', 'dad'), true);
  assert.strictEqual(store.sharesFamily('kid', 'zed'), false);
});

test('bedtime and help: bedtime silences strangers but not the family; help gets through even when muted', async (t) => {
  const b64u = (n, fill = 7) => Buffer.alloc(n, fill).toString('base64url');
  const sent = [];
  const store = new Store({ file: null });
  const app = createApp({ store, push: { sender: async (s, payload) => { sent.push(JSON.parse(payload)); }, minGapMs: 0 } });
  await new Promise((r) => app.server.listen(0, r));
  t.after(() => { app.io.close(); app.server.close(); });
  const base = `http://localhost:${app.server.address().port}`;
  const api = async (method, path, token, body) => (await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  const mum = store.register('mum', 'pass'); const kid = store.register('kid', 'pass'); const zed = store.register('zed', 'pass');
  await api('PUT', '/push/subscription', kid.token, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/k1', keys: { p256dh: b64u(65, 4), auth: b64u(16) } } });
  const g = store.createGroup('mum', 'Home', ['kid']);
  const dm = store.getOrCreateDirect('zed', 'kid');
  const settle = () => new Promise((r) => setTimeout(r, 80));
  await api('PUT', '/me/bedtime', kid.token, { on: true, from: '00:00', to: '23:59', timezone: 'UTC' }); // always bedtime
  await api('POST', `/conversations/${encodeURIComponent(dm.id)}/messages`, zed.token, { text: 'hey' });
  await settle();
  assert.strictEqual(sent.length, 0, 'a non-family chat is silent in bedtime');
  await api('PUT', `/groups/${encodeURIComponent(g.id)}/family`, mum.token, { enabled: true });
  await api('POST', `/conversations/${encodeURIComponent(g.id)}/messages`, mum.token, { text: 'dinner is ready' });
  await settle();
  assert.strictEqual(sent.length, 1, 'the family still gets through');
  // A muted family chat stays silent for ordinary messages but not for help.
  await api('PUT', `/conversations/${encodeURIComponent(g.id)}/preferences`, kid.token, { mute: 'always' });
  await api('POST', `/conversations/${encodeURIComponent(g.id)}/messages`, mum.token, { text: 'another' });
  await settle();
  assert.strictEqual(sent.length, 1);
  await api('POST', `/groups/${encodeURIComponent(g.id)}/family/checkins`, mum.token, { kind: 'help' });
  await settle();
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1].body, /needs help/);
});
