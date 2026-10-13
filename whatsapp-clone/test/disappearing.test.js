'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev, pred = () => true) => new Promise((r) => {
  const fn = (p) => { if (pred(p)) { s.off(ev, fn); r(p); } };
  s.on(ev, fn);
});

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const app = createApp({ store, messageSweepMs: 50, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token) => {
    const s = connect(base, { auth: { token, appSession: 'x' }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r) => s.once('connect', r));
    return s;
  };
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, client, api };
}

test('store: timer limits, default timer for new chats, expiry hides and prunes', () => {
  const store = new Store({ file: null });
  store.register('alice', 'pass');
  store.register('bob', 'pass');
  store.register('carol', 'pass');

  assert.throws(() => Store.checkTimer(59), /between 1 minute/);
  assert.throws(() => Store.checkTimer(366 * 86400), /365 days/);
  assert.throws(() => Store.checkTimer(90.5), /whole seconds/);
  assert.strictEqual(Store.checkTimer(0), null);
  assert.strictEqual(Store.checkTimer(2 * 86400 + 4 * 3600 + 30 * 60), 189000, '2 days 4 hours 30 minutes');

  store.setDefaultDisappear('alice', 3 * 86400);
  const started = store.getOrCreateDirect('alice', 'bob');
  assert.strictEqual(started.disappearAfter, 3 * 86400, "alice's default applies to chats she starts");
  const theirs = store.getOrCreateDirect('carol', 'alice');
  assert.strictEqual(theirs.disappearAfter, undefined, "not to chats others start");
  const grp = store.createGroup('alice', 'Trip', ['bob']);
  assert.strictEqual(grp.disappearAfter, 3 * 86400);

  const m = store.addMessage(started.id, 'bob', 'gone soon');
  assert.strictEqual(m.expiresAt - m.ts, 3 * 86400 * 1000);
  store.setDisappearing(started.id, 'bob', 0);
  assert.strictEqual(store.addMessage(started.id, 'bob', 'stays').expiresAt, undefined, 'off again');

  const media = store.saveMedia(started.id, Buffer.from('a'), 'audio/ogg');
  store.setDisappearing(started.id, 'bob', 60);
  const voice = store.addMessage(started.id, 'bob', '', { voice: { mediaId: media, duration: 1, mime: 'audio/ogg' } });
  store.setStarred(m.id, 'alice', true);
  m.expiresAt = voice.expiresAt = Date.now() - 1;
  assert.deepStrictEqual(store.getMessages(started.id, 'alice').map((x) => x.text), ['stays'], 'hidden as soon as it expires');
  assert.deepStrictEqual(store.starredFor('alice'), [], 'starred copies disappear too');
  assert.strictEqual(store.summarize(started, 'alice').lastMessage.text, 'stays');
  assert.deepStrictEqual(store.pruneMessages(), [{ convId: started.id, ids: [m.id, voice.id] }]);
  assert.strictEqual(store.data.media[media], undefined, 'voice audio deleted');
});

test('realtime: setting a timer notifies everyone, and messages vanish for all devices when it runs out', async (t) => {
  const { store, client } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  const a = await client(alice.token);
  const b = await client(bob.token);

  assert.match((await call(a, 'chat:disappearing', { convId: dm.id, seconds: 10 })).error, /1 minute/);
  const updated = next(b, 'conversation:updated');
  const notice = next(b, 'message:new');
  const res = await call(a, 'chat:disappearing', { convId: dm.id, seconds: 2 * 86400 + 4 * 3600 });
  assert.strictEqual(res.conversation.disappearAfter, 187200);
  assert.strictEqual((await updated).conversation.disappearAfter, 187200);
  const { message } = await notice;
  assert.deepStrictEqual([message.type, message.from, message.system], ['system', 'alice', { event: 'disappearing', seconds: 187200 }]);
  assert.ok(message.readBy.includes('bob'), 'notices are never unread');
  assert.strictEqual(message.expiresAt, undefined, 'notices do not disappear');

  // A short timer, then fast-forward that message's expiry.
  await call(a, 'chat:disappearing', { convId: dm.id, seconds: 60 });
  const sent = await call(b, 'message:send', { convId: dm.id, text: 'self-destructs' });
  assert.ok(sent.message.expiresAt - sent.message.ts === 60000);
  const expiredForAlice = next(a, 'message:expired');
  const expiredForBob = next(b, 'message:expired');
  store.data.messages[dm.id].find((m) => m.id === sent.message.id).expiresAt = Date.now() - 1;
  const [ea, eb] = await Promise.all([expiredForAlice, expiredForBob]);
  assert.deepStrictEqual(ea, { convId: dm.id, ids: [sent.message.id] });
  assert.deepStrictEqual(eb.ids, [sent.message.id]);
  assert.ok(!(await call(a, 'messages:get', { convId: dm.id })).messages.some((m) => m.id === sent.message.id));

  // Turning it off.
  const off = await call(b, 'chat:disappearing', { convId: dm.id, seconds: 0 });
  assert.strictEqual(off.conversation.disappearAfter, undefined);
  assert.strictEqual(off.conversation.disappearSetBy, 'bob');
});

test('api: per-chat timer and default timer over REST', async (t) => {
  const { store, api } = await setup(t);
  const alice = store.register('alice', 'pass').token;
  store.register('bob', 'pass');
  store.register('carol', 'pass');

  const def = await api('PUT', '/me/default-disappearing', alice, { seconds: 7 * 86400 });
  assert.deepStrictEqual(def.body, { defaultDisappear: 604800 });
  assert.strictEqual((await api('GET', '/me', alice)).body.defaultDisappear, 604800);
  const conv = (await api('POST', '/conversations', alice, { type: 'direct', username: 'bob' })).body.conversation;
  assert.strictEqual(conv.disappearAfter, 604800);

  const id = encodeURIComponent(conv.id);
  const set = await api('PUT', `/conversations/${id}/disappearing`, alice, { seconds: 90 * 86400 });
  assert.strictEqual(set.body.conversation.disappearAfter, 7776000);
  assert.strictEqual((await api('PUT', `/conversations/${id}/disappearing`, alice, { seconds: 5 })).status, 400);
  const carol = store.createApiKey('carol', 'k').key;
  assert.strictEqual((await api('PUT', `/conversations/${id}/disappearing`, carol, { seconds: 60 })).status, 404);
  const msg = (await api('POST', `/conversations/${id}/messages`, alice, { text: 'hi' })).body.message;
  assert.strictEqual(msg.expiresAt - msg.ts, 7776000 * 1000);
});
