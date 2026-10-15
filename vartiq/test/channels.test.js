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

test('channels: create, discover, follow, post, read', async (t) => {
  const { store, client, api } = await setup(t);
  const owner = store.register('owner', 'pass', 'Food Guy');
  const fan = store.register('fanfan', 'pass');
  const stranger = store.register('stranger', 'pass');
  const sFan = await client(fan.token);
  const sStranger = await client(stranger.token);

  for (const bad of [{ handle: 'ab', name: 'x' }, { handle: 'has space', name: 'x' }, { handle: 'okhandle' }, { handle: 'okhandle', name: 'x'.repeat(61) }, { handle: 'okhandle', name: 'n', description: 'd'.repeat(301) }]) {
    assert.strictEqual((await api('POST', '/channels', { token: owner.token, body: bad })).status, 400, JSON.stringify(bad));
  }
  const created = await api('POST', '/channels', { token: owner.token, body: { handle: '@Pune_Food', name: 'Pune Food News', description: 'New openings and offers', category: 'Food' } });
  assert.strictEqual(created.status, 201);
  const ch = created.body.channel;
  assert.deepStrictEqual([ch.handle, ch.owner, ch.role, ch.followers, ch.following, ch.unread], ['pune_food', 'owner', 'owner', 1, true, 0]);
  assert.strictEqual((await api('POST', '/channels', { token: fan.token, body: { handle: 'PUNE_FOOD', name: 'Copy' } })).status, 409, 'handles are unique');

  // Public: anybody can find it, by handle or id, and read it without following.
  const found = await api('GET', '/channels?q=offers', { token: stranger.token });
  assert.deepStrictEqual(found.body.channels.map((c) => [c.handle, c.following, c.role]), [['pune_food', false, null]]);
  assert.strictEqual(found.body.users.owner.displayName, 'Food Guy');
  assert.strictEqual((await api('GET', '/channels/pune_food', { token: stranger.token })).body.channel.id, ch.id);
  assert.strictEqual((await api('GET', '/channels?q=nomatch', { token: stranger.token })).body.channels.length, 0);

  // Only the owner/admins post.
  assert.strictEqual((await api('POST', `/channels/${ch.id}/posts`, { token: fan.token, body: { text: 'hi' } })).status, 403);
  assert.strictEqual((await api('POST', `/channels/${ch.id}/posts`, { token: owner.token, body: { text: '   ' } })).status, 400);
  assert.strictEqual((await api('POST', `/channels/${ch.id}/posts`, { token: owner.token, body: { text: 'x'.repeat(4001) } })).status, 400);

  // Follow, then get posts live with an unread count.
  const followed = await api('PUT', `/channels/${ch.id}/follow`, { token: fan.token });
  assert.deepStrictEqual([followed.body.channel.following, followed.body.channel.followers], [true, 2]);
  const live = next(sFan, 'channel:post');
  const strangerHears = Promise.race([next(sStranger, 'channel:post').then(() => 'heard'), new Promise((r) => setTimeout(() => r('silent'), 300))]);
  const post = await api('POST', `/channels/${ch.id}/posts`, { token: owner.token, body: { text: 'We open at 9 tomorrow! 🍕' } });
  assert.strictEqual(post.status, 201);
  const got = await live;
  assert.deepStrictEqual([got.post.text, got.post.by, got.channel.unread], ['We open at 9 tomorrow! 🍕', 'owner', 1]);
  assert.strictEqual(await strangerHears, 'silent', 'non-followers are not pushed posts');
  assert.strictEqual((await api('GET', '/me/channels', { token: fan.token })).body.channels[0].unread, 1);
  assert.strictEqual((await api('GET', '/me/channels', { token: stranger.token })).body.channels.length, 0);

  // Reading marks read; a stranger can read without following.
  const read = await api('GET', `/channels/${ch.id}/posts`, { token: fan.token });
  assert.deepStrictEqual(read.body.posts.map((p) => p.text), ['We open at 9 tomorrow! 🍕']);
  assert.strictEqual((await api('GET', '/me/channels', { token: fan.token })).body.channels[0].unread, 0);
  assert.strictEqual((await api('GET', `/channels/${ch.id}/posts`, { token: stranger.token })).body.posts.length, 1);

  // Paging.
  for (let i = 0; i < 4; i++) await api('POST', `/channels/${ch.id}/posts`, { token: owner.token, body: { text: `post ${i}` } });
  const page1 = await api('GET', `/channels/${ch.id}/posts?limit=3`, { token: fan.token });
  assert.deepStrictEqual([page1.body.posts.map((p) => p.text), page1.body.hasMore], [['post 1', 'post 2', 'post 3'], true]);
  const page2 = await api('GET', `/channels/${ch.id}/posts?limit=3&before=${page1.body.nextBefore}`, { token: fan.token });
  assert.ok(page2.body.posts.length >= 1);

  // Unfollow; owner cannot.
  assert.strictEqual((await api('DELETE', `/channels/${ch.id}/follow`, { token: fan.token })).body.channel.following, false);
  assert.strictEqual((await api('DELETE', `/channels/${ch.id}/follow`, { token: owner.token })).status, 403);
  assert.strictEqual((await api('GET', '/channels/nope', { token: fan.token })).status, 404);
  void sStranger;
});

test('channels: admins, editing, deleting posts and channels, report, limits', async (t) => {
  const { store, client, api } = await setup(t);
  const owner = store.register('owner', 'pass');
  const admin = store.register('helper', 'pass');
  const fan = store.register('fanfan', 'pass');
  const sFan = await client(fan.token);
  const ch = (await api('POST', '/channels', { token: owner.token, body: { handle: 'news', name: 'News' } })).body.channel;
  await api('PUT', `/channels/${ch.id}/follow`, { token: fan.token });

  // Admins: owner appoints; they post/edit/delete posts; they cannot delete the channel or appoint admins.
  assert.strictEqual((await api('PUT', `/channels/${ch.id}/admins/helper`, { token: fan.token })).status, 403);
  assert.strictEqual((await api('PUT', `/channels/${ch.id}/admins/nobody`, { token: owner.token })).status, 404);
  assert.strictEqual((await api('PUT', `/channels/${ch.id}/admins/owner`, { token: owner.token })).status, 400);
  const made = await api('PUT', `/channels/${ch.id}/admins/helper`, { token: owner.token });
  assert.deepStrictEqual([made.body.channel.admins, made.body.channel.followers], [['helper'], 3], 'an admin also follows');
  const p = (await api('POST', `/channels/${ch.id}/posts`, { token: admin.token, body: { text: 'from the admin' } })).body.post;
  assert.strictEqual(p.by, 'helper');
  assert.strictEqual((await api('GET', `/channels/${ch.id}`, { token: admin.token })).body.channel.role, 'admin');
  assert.strictEqual((await api('DELETE', `/channels/${ch.id}`, { token: admin.token })).status, 403);
  assert.strictEqual((await api('PUT', `/channels/${ch.id}/admins/fanfan`, { token: admin.token })).status, 403);
  const upd = await api('PATCH', `/channels/${ch.id}`, { token: admin.token, body: { description: 'Daily news', category: 'News' } });
  assert.deepStrictEqual([upd.body.channel.description, upd.body.channel.category, upd.body.channel.handle], ['Daily news', 'News', 'news']);
  assert.strictEqual((await api('PATCH', `/channels/${ch.id}`, { token: fan.token, body: { name: 'Hacked' } })).status, 403);

  // Deleting a post tells followers.
  const gone = next(sFan, 'channel:post-deleted');
  assert.strictEqual((await api('DELETE', `/channels/${ch.id}/posts/${p.id}`, { token: fan.token })).status, 403);
  assert.strictEqual((await api('DELETE', `/channels/${ch.id}/posts/${p.id}`, { token: owner.token })).status, 204);
  assert.strictEqual((await gone).postId, p.id);
  assert.strictEqual((await api('DELETE', `/channels/${ch.id}/posts/${p.id}`, { token: owner.token })).status, 404);

  // Removing the admin.
  assert.deepStrictEqual((await api('DELETE', `/channels/${ch.id}/admins/helper`, { token: owner.token })).body.channel.admins, []);
  assert.strictEqual((await api('POST', `/channels/${ch.id}/posts`, { token: admin.token, body: { text: 'no longer' } })).status, 403);

  // Reports: one per person.
  assert.strictEqual((await api('POST', `/channels/${ch.id}/report`, { token: fan.token, body: { reason: '' } })).status, 400);
  assert.strictEqual((await api('POST', `/channels/${ch.id}/report`, { token: owner.token, body: { reason: 'x' } })).status, 400);
  await api('POST', `/channels/${ch.id}/report`, { token: fan.token, body: { reason: 'Spam' } });
  await api('POST', `/channels/${ch.id}/report`, { token: fan.token, body: { reason: 'Scam' } });
  assert.deepStrictEqual(store.data.reports.map((r) => [r.reporter, r.reason]), [['fanfan', 'Scam']]);

  // Delete the channel: followers are told, posts and reports go.
  const deleted = next(sFan, 'channel:deleted');
  assert.strictEqual((await api('DELETE', `/channels/${ch.id}`, { token: owner.token })).status, 204);
  assert.strictEqual((await deleted).id, ch.id);
  assert.deepStrictEqual([store.data.channelPosts[ch.id], store.data.reports.length], [undefined, 0]);
  assert.strictEqual((await api('GET', '/channels/news', { token: fan.token })).status, 404);

  // Limits: 10 channels per owner, 5 admins.
  for (let i = 0; i < 10; i++) store.createChannel('owner', { handle: `chan${i}x`, name: `C${i}` });
  const over = await api('POST', '/channels', { token: owner.token, body: { handle: 'toomany', name: 'Too many' } });
  assert.deepStrictEqual([over.status, over.body.error.code], [409, 'limit_reached']);
  const c0 = store.getChannel('chan0x');
  for (let i = 0; i < 5; i++) { store.register(`adm${i}x`, 'pass'); store.setChannelAdmin('owner', c0.id, `adm${i}x`, true); }
  store.register('adm6x', 'pass');
  assert.throws(() => store.setChannelAdmin('owner', c0.id, 'adm6x', true), /at most 5 admins/);
});

test('channels: the socket events the app uses, and posting speed limit', async (t) => {
  const { store, client } = await setup(t);
  const owner = store.register('owner', 'pass');
  const s = await client(owner.token);
  const { channel } = await call(s, 'channel:create', { handle: 'socketchan', name: 'Socket' });
  assert.strictEqual(channel.role, 'owner');
  for (let i = 0; i < 20; i++) assert.ok((await call(s, 'channel:post', { id: channel.id, text: `p${i}` })).ok);
  const slow = await call(s, 'channel:post', { id: channel.id, text: 'one too many' });
  assert.deepStrictEqual([slow.ok, slow.code], [false, 'rate_limited']);
  assert.strictEqual((await call(s, 'channels:mine')).channels.length, 1);
  assert.strictEqual((await call(s, 'channels:search', { q: 'socket' })).channels.length, 1);
  assert.strictEqual((await call(s, 'channel:posts', { id: 'socketchan' })).posts.length, 20);
});
