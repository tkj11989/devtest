'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

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
  return { store, client, api };
}

test('profile views: viewers listed with contact status and last view date', async (t) => {
  const { store, client, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const carol = store.register('carol', 'pass'); // a stranger
  const dave = store.register('dave', 'pass'); // has a chat with no messages yet
  store.addMessage(store.getOrCreateDirect('alice', 'bob').id, 'bob', 'hi alice');
  store.getOrCreateDirect('alice', 'dave');
  const sa = await client(alice.token);

  assert.deepStrictEqual((await call(sa, 'profile:views')).viewers, [], 'nobody yet');
  const live = next(sa, 'profile:viewed');
  assert.strictEqual((await api('POST', '/users/alice/view', { token: bob.token })).status, 204);
  await live; // the owner's app refreshes live
  await api('POST', '/users/alice/view', { token: carol.token });
  await api('POST', '/users/alice/view', { token: dave.token });

  // Last view date: viewing again only moves the date; there is one row per person.
  const before = store.data.users.alice.profileViews.bob;
  await new Promise((r) => setTimeout(r, 15));
  await api('POST', '/users/alice/view', { token: bob.token });
  assert.ok(store.data.users.alice.profileViews.bob > before);

  const res = await api('GET', '/me/profile-views', { token: alice.token });
  assert.deepStrictEqual([res.body.enabled, res.body.retentionDays], [true, 90]);
  assert.deepStrictEqual(res.body.viewers.map((v) => [v.user.username, v.inContact]), [['bob', true], ['dave', false], ['carol', false]]);
  assert.strictEqual(res.body.viewers[0].lastViewedAt, store.data.users.alice.profileViews.bob);
  assert.strictEqual(res.body.viewers[0].user.displayName, 'bob');
  assert.deepStrictEqual(Object.keys(store.data.users.alice.profileViews).sort(), ['bob', 'carol', 'dave'], 'only a date per viewer is stored');

  // Not recorded: yourself, unknown users, blocked either way.
  assert.strictEqual((await api('POST', '/users/alice/view', { token: alice.token })).status, 204);
  assert.strictEqual(store.data.users.alice.profileViews.alice, undefined);
  assert.strictEqual((await api('POST', '/users/nobody/view', { token: bob.token })).status, 404);
  store.setBlocked('alice', 'carol', true);
  const stamp = store.data.users.alice.profileViews.carol;
  await new Promise((r) => setTimeout(r, 10));
  await api('POST', '/users/alice/view', { token: carol.token });
  assert.strictEqual(store.data.users.alice.profileViews.carol, stamp, 'a blocked person is not recorded');
  // Viewing someone else doesn't show up on my own list.
  await api('POST', '/users/bob/view', { token: alice.token });
  assert.ok(store.data.users.bob.profileViews.alice);
  assert.strictEqual((await api('GET', '/me/profile-views', { token: carol.token })).body.viewers.length, 0);
  void bob; void dave;
});

test('profile views: 90-day retention and the 500 cap', async (t) => {
  const store = new Store({ file: null });
  store.register('alice', 'pass');
  // (Direct inserts: registering 505 accounts would spend the time hashing passwords.)
  for (let i = 0; i < 505; i++) {
    const name = `user${String(i).padStart(3, '0')}`;
    store.data.users[name] = { username: name, displayName: name };
  }
  for (let i = 0; i < 505; i++) store.recordProfileView(`user${String(i).padStart(3, '0')}`, 'alice');
  assert.strictEqual(Object.keys(store.data.users.alice.profileViews).length, 500);
  store.data.users.alice.profileViews.user504 = Date.now() - 91 * 86400000;
  const list = store.profileViewsOf('alice');
  assert.ok(!list.some((v) => v.username === 'user504'), 'older than 90 days is dropped');
  assert.ok(list.every((v) => Date.now() - v.lastViewedAt < 90 * 86400000));
  void t;
});

test('profile views privacy switch: off = not recorded, not visible, list erased', async (t) => {
  const { store, client, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const sa = await client(alice.token);
  assert.strictEqual((await call(sa, 'me')).privacy.profileViews, true);
  await api('POST', '/users/alice/view', { token: bob.token });
  assert.strictEqual((await api('GET', '/me/profile-views', { token: alice.token })).body.viewers.length, 1);

  // Alice turns it off: her list is erased and nobody is recorded any more.
  const off = await api('PUT', '/me/privacy', { token: alice.token, body: { profileViews: false } });
  assert.deepStrictEqual(off.body, { privacy: { profileViews: false } });
  assert.strictEqual(store.data.users.alice.profileViews, undefined);
  await api('POST', '/users/alice/view', { token: bob.token });
  assert.strictEqual(store.data.users.alice.profileViews, undefined);
  const list = await api('GET', '/me/profile-views', { token: alice.token });
  assert.deepStrictEqual([list.body.enabled, list.body.viewers], [false, []]);

  // And her own views of others are not recorded either (fair trade).
  await api('POST', '/users/bob/view', { token: alice.token });
  assert.strictEqual(store.data.users.bob.profileViews, undefined);

  // Back on: recording resumes from zero.
  await api('PUT', '/me/privacy', { token: alice.token, body: { profileViews: true } });
  await api('POST', '/users/alice/view', { token: bob.token });
  assert.deepStrictEqual((await api('GET', '/me/profile-views', { token: alice.token })).body.viewers.map((v) => v.user.username), ['bob']);
  assert.strictEqual((await call(sa, 'user:get', { username: 'bob' })).user.username, 'bob');
});
