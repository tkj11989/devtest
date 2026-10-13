'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const app = createApp({ store, webhooks: { allowPrivate: true, retryDelaysMs: [] }, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  /** One "app session" = one page load: a token plus an appSession id. */
  const client = async (token, appSession) => {
    const s = connect(base, { auth: { token, appSession }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  const api = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { store, base, client, api };
}

test('store: secret code set, change, verify and reset', () => {
  const store = new Store({ file: null });
  store.register('alice', 'password1');
  const dm = (store.register('bob', 'pass'), store.getOrCreateDirect('alice', 'bob'));

  assert.strictEqual(store.hasLockCode('alice'), false);
  assert.throws(() => store.setChatLocked('alice', dm.id, true), /Set a secret code first/);
  assert.throws(() => store.setLockCode('alice', '12'), /4 to 32/);
  store.setLockCode('alice', '2468');
  assert.ok(store.verifyLockCode('alice', '2468'));
  assert.ok(!store.verifyLockCode('alice', '1357'));
  assert.strictEqual(store.data.users.alice.chatLock.hash.includes('2468'), false, 'stored hashed');
  assert.throws(() => store.setLockCode('alice', '9999', 'wrong'), /Current secret code is wrong/);
  store.setLockCode('alice', '9999', '2468');
  assert.ok(store.verifyLockCode('alice', '9999'));
  assert.throws(() => store.resetLockCode('alice', 'nope', '1111'), /Password is wrong/);
  store.resetLockCode('alice', 'password1', '1111');
  assert.ok(store.verifyLockCode('alice', '1111'));
  store.setChatLocked('alice', dm.id, true);
  assert.deepStrictEqual(store.lockedChats('alice'), [dm.id]);
  assert.strictEqual(store.isChatLocked('bob', dm.id), false, 'locks are per person');
});

test('chat lock: content only for the app session that unlocked it, every new session starts locked', async (t) => {
  const { store, client } = await setup(t);
  const alice = store.register('alice', 'password1');
  const bob = store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  store.addMessage(dm.id, 'bob', 'the secret plan');

  const tabA = await client(alice.token, 'tab-A');
  const tabB = await client(alice.token, 'tab-B');
  const b = await client(bob.token, 'bob-1');

  assert.match((await call(tabA, 'chatlock:lock', { convId: dm.id })).error, /Set a secret code first/);
  const updated = next(tabB, 'chatlock:update');
  assert.ok((await call(tabA, 'chatlock:set-code', { code: '2468' })).ok);
  assert.strictEqual((await updated).hasCode, true, 'other devices are told');
  assert.deepStrictEqual((await call(tabA, 'chatlock:lock', { convId: dm.id })).lockedChats, [dm.id]);

  // Locked: list preview has no content, history is refused.
  const list = await call(tabA, 'conversations');
  const conv = list.conversations.find((c) => c.id === dm.id);
  assert.deepStrictEqual([conv.locked, conv.unlocked], [true, false]);
  assert.strictEqual(conv.lastMessage.text, undefined);
  assert.strictEqual(conv.lastMessage.locked, true);
  assert.match((await call(tabA, 'messages:get', { convId: dm.id })).error, /locked/);
  assert.match((await call(tabA, 'message:send', { convId: dm.id, text: 'x' })).error, /locked/);
  assert.match((await call(tabA, 'chatlock:unlock', { convId: dm.id, code: '0000' })).error, /Wrong secret code \(4 tries left\)/);

  // Unlock in tab A only.
  const opened = await call(tabA, 'chatlock:unlock', { convId: dm.id, code: '2468' });
  assert.deepStrictEqual([opened.conversation.locked, opened.conversation.unlocked], [true, true]);
  assert.strictEqual(opened.conversation.lastMessage.text, 'the secret plan');
  assert.strictEqual((await call(tabA, 'messages:get', { convId: dm.id })).messages[0].text, 'the secret plan');
  assert.match((await call(tabB, 'messages:get', { convId: dm.id })).error, /locked/, 'tab B is a separate session');

  // New messages: tab A gets the text, tab B only that something arrived.
  const inA = next(tabA, 'message:new');
  const inB = next(tabB, 'message:new');
  await call(b, 'message:send', { convId: dm.id, text: 'meet at 9' });
  assert.strictEqual((await inA).message.text, 'meet at 9');
  const redacted = (await inB).message;
  assert.deepStrictEqual([redacted.text, redacted.locked, redacted.from], [undefined, true, 'bob']);
  assert.strictEqual((await call(b, 'messages:get', { convId: dm.id })).messages.length, 2, "bob's own view is unaffected");

  // A reconnect of the same page keeps it open; a reload (new app session) or a new login does not.
  tabA.close();
  await new Promise((r) => setTimeout(r, 100)); // let the server see the disconnect
  const tabAagain = await client(alice.token, 'tab-A');
  assert.match((await call(tabAagain, 'messages:get', { convId: dm.id })).error, /locked/, 'closing the last tab of a session locks it');
  await call(tabAagain, 'chatlock:unlock', { convId: dm.id, code: '2468' });
  const sameSession = await client(alice.token, 'tab-A'); // e.g. a reconnect while the page stays open
  assert.ok((await call(sameSession, 'messages:get', { convId: dm.id })).ok);
  const relogin = store.login('alice', 'password1');
  const fresh = await client(relogin.token, 'tab-A');
  assert.match((await call(fresh, 'messages:get', { convId: dm.id })).error, /locked/, 'new login = new session');

  // Lock now.
  await call(sameSession, 'chatlock:relock');
  assert.match((await call(sameSession, 'messages:get', { convId: dm.id })).error, /locked/);

  // Removing the lock needs the code.
  assert.match((await call(fresh, 'chatlock:remove', { convId: dm.id, code: 'nope' })).error, /Wrong/);
  assert.ok((await call(fresh, 'chatlock:remove', { convId: dm.id, code: '2468' })).ok);
  assert.ok((await call(tabB, 'messages:get', { convId: dm.id })).ok, 'open everywhere again');
});

test('chat lock: wrong codes lock out further tries', async (t) => {
  const { store, client } = await setup(t);
  const alice = store.register('alice', 'password1');
  store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  store.setLockCode('alice', '2468');
  store.setChatLocked('alice', dm.id, true);
  const s = await client(alice.token, 'x');

  for (let i = 0; i < 5; i++) await call(s, 'chatlock:unlock', { convId: dm.id, code: `bad${i}` });
  const blocked = await call(s, 'chatlock:unlock', { convId: dm.id, code: '2468' });
  assert.match(blocked.error, /Too many wrong attempts. Try again in \d+ seconds/);
  // The password reset is throttled by the same counter.
  assert.match((await call(s, 'chatlock:reset-code', { password: 'password1', newCode: '1111' })).error, /Too many/);
});

test('chat lock over REST: 423 until unlocked, per credential; webhooks, stars and voice notes stay redacted', async (t) => {
  const { store, api, base, client } = await setup(t);
  const received = [];
  const hookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(204).end(); });
  });
  await new Promise((r) => hookServer.listen(0, r));
  t.after(() => hookServer.close());

  const alice = store.register('alice', 'password1');
  const bob = store.register('bob', 'pass');
  const keyA = store.createApiKey('alice', 'crm').key;
  const keyB = store.createApiKey('alice', 'other').key;
  const dm = store.getOrCreateDirect('alice', 'bob');
  const id = encodeURIComponent(dm.id);
  const star = store.addMessage(dm.id, 'bob', 'starred secret');
  store.setStarred(star.id, 'alice', true);
  const voiceMedia = store.saveMedia(dm.id, Buffer.from('ogg'), 'audio/ogg');
  store.addMessage(dm.id, 'bob', '', { voice: { mediaId: voiceMedia, duration: 2, mime: 'audio/ogg' } });
  store.createWebhook('alice', { url: `http://127.0.0.1:${hookServer.address().port}/`, events: ['message:new'] });

  assert.strictEqual((await api('PUT', `/conversations/${id}/lock`, { token: keyA })).status, 400, 'needs a code first');
  assert.deepStrictEqual((await api('PUT', '/chat-lock/code', { token: keyA, body: { code: '2468' } })).body, { hasCode: true, lockedChats: [] });
  assert.deepStrictEqual((await api('PUT', `/conversations/${id}/lock`, { token: keyA })).body.lockedChats, [dm.id]);

  const locked = await api('GET', `/conversations/${id}/messages`, { token: keyA });
  assert.deepStrictEqual([locked.status, locked.body.error.code], [423, 'chat_locked']);
  const starred = await api('GET', '/starred', { token: keyA });
  assert.deepStrictEqual([starred.body.messages[0].text, starred.body.messages[0].locked], [undefined, true]);
  const media = await fetch(`${base}/api/v1/media/${voiceMedia}`, { headers: { Authorization: `Bearer ${keyA}` } });
  assert.strictEqual(media.status, 423);

  const wrong = await api('POST', `/conversations/${id}/unlock`, { token: keyA, body: { code: '1111' } });
  assert.deepStrictEqual([wrong.status, wrong.body.error.code], [403, 'wrong_code']);
  assert.strictEqual((await api('POST', `/conversations/${id}/unlock`, { token: keyA, body: { code: '2468' } })).status, 200);
  assert.strictEqual((await api('GET', `/conversations/${id}/messages`, { token: keyA })).status, 200);
  assert.strictEqual((await fetch(`${base}/api/v1/media/${voiceMedia}`, { headers: { Authorization: `Bearer ${keyA}` } })).status, 200);
  assert.strictEqual((await api('GET', `/conversations/${id}/messages`, { token: keyB })).status, 423, 'another credential is another session');
  assert.strictEqual((await api('GET', `/conversations/${id}/messages`, { token: keyA, headers: { 'X-App-Session': 'tab-9' } })).status, 423, 'X-App-Session narrows it further');

  // Webhooks never get the content of a locked chat.
  const b = await client(bob.token, 'b');
  await call(b, 'message:send', { convId: dm.id, text: 'for your eyes only' });
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual([received[0].data.message.text, received[0].data.message.locked], [undefined, true]);

  // Relock, reset with the password, remove.
  await api('POST', '/chat-lock/relock', { token: keyA });
  assert.strictEqual((await api('GET', `/conversations/${id}/messages`, { token: keyA })).status, 423);
  assert.strictEqual((await api('POST', '/chat-lock/reset', { token: keyA, body: { password: 'wrong', newCode: '1357' } })).status, 403);
  assert.strictEqual((await api('POST', '/chat-lock/reset', { token: keyA, body: { password: 'password1', newCode: '1357' } })).status, 200);
  assert.strictEqual((await api('DELETE', `/conversations/${id}/lock`, { token: keyA, body: { code: '1357' } })).body.lockedChats.length, 0);
  assert.strictEqual((await api('GET', `/conversations/${id}/messages`, { token: alice.token })).status, 200);
});
