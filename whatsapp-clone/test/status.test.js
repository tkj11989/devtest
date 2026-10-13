'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

function people(store) {
  const tokens = {};
  for (const u of ['alice', 'bob', 'carol', 'dave']) tokens[u] = store.register(u, 'pass').token;
  store.getOrCreateDirect('alice', 'bob');
  store.getOrCreateDirect('alice', 'carol');
  // dave shares only a group with alice: not part of her status audience.
  store.createGroup('dave', 'Club', ['alice']);
  return tokens;
}

test('store: status audience, viewer privacy, blocking and expiry', () => {
  const store = new Store({ file: null, statusTtlMs: 50 });
  people(store);
  const s = store.addStatus('alice', { type: 'text', text: 'Beach day ☀️', bg: '#ff7043' });

  assert.deepStrictEqual(store.statusAudience('alice').sort(), ['bob', 'carol']);
  assert.strictEqual(store.statusesFor('bob').length, 1);
  assert.strictEqual(store.statusesFor('dave').length, 0, 'group-only contacts do not see it');

  assert.ok(store.markStatusViewed(s.id, 'bob'));
  assert.strictEqual(store.markStatusViewed(s.id, 'bob'), null, 'second view is not new');
  assert.strictEqual(store.markStatusViewed(s.id, 'alice'), null, 'own views are not counted');
  assert.deepStrictEqual(store.statusesFor('alice')[0].views.map((v) => v.username), ['bob']);
  assert.strictEqual(store.statusesFor('bob')[0].viewed, true);
  assert.strictEqual(store.statusesFor('bob')[0].views, undefined, 'only the owner sees who viewed');
  assert.strictEqual(store.statusesFor('carol')[0].viewed, undefined);

  store.setBlocked('carol', 'alice', true);
  assert.strictEqual(store.statusesFor('carol').length, 0, 'blocking hides statuses');
  assert.throws(() => store.addStatus('alice', { type: 'text', text: '  ' }), /empty/);
  assert.throws(() => store.addStatus('alice', { type: 'video' }), /Invalid/);

  return new Promise((r) => setTimeout(r, 70)).then(() => {
    assert.strictEqual(store.statusesFor('bob').length, 0, 'gone after it expires');
    assert.deepStrictEqual(store.pruneStatuses().map((x) => x.id), [s.id]);
    assert.deepStrictEqual(store.data.statuses, {});
  });
});

test('realtime: post, view and delete statuses; photos are only for the audience', async (t) => {
  const store = new Store({ file: null });
  const tokens = people(store);
  const { server, io } = createApp({ store });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); io.close(); server.close(); });
  const client = async (u) => {
    const s = connect(base, { auth: { token: tokens[u] }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r) => s.once('connect', r));
    return s;
  };
  const [alice, bob, dave] = await Promise.all(['alice', 'bob', 'dave'].map(client));
  let daveHeard = false;
  dave.on('status:new', () => { daveHeard = true; });

  // Text status reaches bob live.
  const bobSees = next(bob, 'status:new');
  const posted = await call(alice, 'status:post', { type: 'text', text: 'Hello world', bg: '#25a3e0' });
  assert.ok(posted.ok, posted.error);
  assert.deepStrictEqual(posted.status.views, []);
  const { status } = await bobSees;
  assert.strictEqual(status.text, 'Hello world');
  assert.strictEqual(status.views, undefined);

  // Bob views it: alice is told who and when.
  const viewed = next(alice, 'status:viewed');
  await call(bob, 'status:view', { id: status.id });
  const v = await viewed;
  assert.strictEqual(v.username, 'bob');
  assert.ok(v.ts);

  // Photo status: audience can download, others can't.
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const photo = await call(alice, 'status:post', { type: 'image', mime: 'image/png', data: png, caption: 'View from here' });
  assert.ok(photo.ok, photo.error);
  const get = (u) => fetch(`${base}/media/${photo.status.mediaId}`, { headers: { Authorization: `Bearer ${tokens[u]}` } });
  assert.strictEqual((await get('bob')).status, 200);
  assert.strictEqual((await get('dave')).status, 404);
  assert.match((await call(alice, 'status:post', { type: 'image', mime: 'text/html', data: png })).error, /Unsupported/);

  const list = await call(bob, 'statuses');
  assert.deepStrictEqual(list.statuses.map((s) => s.type), ['text', 'image']);
  assert.strictEqual(list.statuses[0].viewed, true);
  assert.strictEqual(list.users.alice.username, 'alice');

  // Delete: bob is told, and the photo is gone.
  const gone = next(bob, 'status:deleted');
  assert.ok((await call(alice, 'status:delete', { id: photo.status.id })).ok);
  assert.strictEqual((await gone).id, photo.status.id);
  assert.strictEqual((await get('bob')).status, 404);
  assert.match((await call(bob, 'status:delete', { id: status.id })).error, /not found/);

  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(daveHeard, false);
});

test('realtime: replying to a status sends a message in the one-to-one chat', async (t) => {
  const store = new Store({ file: null });
  const tokens = people(store);
  const { server, io } = createApp({ store });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const alice = connect(base, { auth: { token: tokens.alice }, transports: ['websocket'], forceNew: true });
  const bob = connect(base, { auth: { token: tokens.bob }, transports: ['websocket'], forceNew: true });
  t.after(() => { alice.close(); bob.close(); io.close(); server.close(); });
  await Promise.all([alice, bob].map((s) => new Promise((r) => s.once('connect', r))));

  const { status } = await call(alice, 'status:post', { type: 'text', text: 'Who wants pizza?', bg: '#e66b4f' });
  const incoming = next(alice, 'message:new');
  const res = await call(bob, 'status:reply', { id: status.id, text: 'Me! 🍕', clientId: 'r-1' });
  assert.ok(res.ok, res.error);
  const { message } = await incoming;
  assert.strictEqual(message.text, 'Me! 🍕');
  assert.strictEqual(message.convId, store.getOrCreateDirect('alice', 'bob').id);
  assert.deepStrictEqual(message.statusReply, { statusId: status.id, owner: 'alice', type: 'text', preview: 'Who wants pizza?', bg: '#e66b4f' });
  assert.match((await call(alice, 'status:reply', { id: status.id, text: 'self' })).error, /not found/);
});
