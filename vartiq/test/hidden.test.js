'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store, webhooks: { allowPrivate: true, retryDelaysMs: [] } });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  const base = `http://localhost:${port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
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
  return { store, base, port, client, api };
}

/** A stand-in for a phone's fingerprint/face sensor: makes keys and signs like a WebAuthn platform authenticator. */
function fakePhone(origin) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rpId = new URL(origin).hostname;
  const id = b64u(crypto.randomBytes(16));
  let counter = 0;
  const authData = (flags, n) => {
    const b = Buffer.alloc(37);
    sha256(rpId).copy(b);
    b[32] = flags;
    b.writeUInt32BE(n, 33);
    return b;
  };
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin }));
  return {
    id,
    create(challenge, { flags = 0x45 } = {}) {
      return {
        id,
        clientDataJSON: b64u(clientData('webauthn.create', challenge)),
        authenticatorData: b64u(authData(flags, 0)),
        publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' })),
        alg: -7,
      };
    },
    get(challenge, { flags = 0x05, fixedCounter } = {}) {
      counter = fixedCounter ?? counter + 1;
      const cd = clientData('webauthn.get', challenge);
      const ad = authData(flags, counter);
      return { id, clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(crypto.sign('sha256', Buffer.concat([ad, sha256(cd)]), privateKey)) };
    },
  };
}

test('store: hide needs a code, replaces the chat lock, and can be cleared', () => {
  const store = new Store({ file: null });
  store.register('alice', 'pass');
  store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  assert.throws(() => store.setChatHidden('alice', dm.id, true), /secret code/);
  store.setLockCode('alice', '2468');
  store.setChatLocked('alice', dm.id, true);
  store.setChatHidden('alice', dm.id, true);
  assert.deepStrictEqual([store.isChatHidden('alice', dm.id), store.isChatLocked('alice', dm.id)], [true, false], 'hiding replaces the lock');
  assert.throws(() => store.setChatLocked('alice', dm.id, true), /already protected/);
  assert.strictEqual(store.isChatHidden('bob', dm.id), false, 'hiding is private to me');
  assert.deepStrictEqual(store.clearHidden('alice'), [dm.id]);
  assert.deepStrictEqual(store.hiddenChats('alice'), []);
});

test('hidden chats: left out of the list; nothing reaches a session until revealed', async (t) => {
  const { store, client, api, base } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  store.addMessage(dm.id, 'bob', 'secret plans');
  const c = encodeURIComponent(dm.id);

  // A webhook should never hear about hidden chats.
  const hooked = [];
  const sink = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hooked.push(JSON.parse(b)); res.writeHead(204).end(); }); });
  await new Promise((r) => sink.listen(0, r));
  t.after(() => sink.close());
  store.createWebhook('alice', { url: `http://127.0.0.1:${sink.address().port}/h`, events: ['*', 'message:new', 'conversation:updated'] });

  // No secret code yet.
  assert.strictEqual((await api('PUT', `/conversations/${c}/hide`, { token: alice.token })).body.error.code, 'code_required');
  await api('PUT', '/chat-lock/code', { token: alice.token, body: { code: '2468' } });
  const hide = await api('PUT', `/conversations/${c}/hide`, { token: alice.token });
  assert.deepStrictEqual([hide.status, hide.body.hiddenCount], [200, 1]);
  assert.strictEqual((await api('PUT', `/conversations/${c}/lock`, { token: alice.token })).status, 409);

  const list = await api('GET', '/conversations', { token: alice.token });
  assert.deepStrictEqual(list.body.conversations.map((x) => x.id), [], 'not on the dashboard');
  assert.strictEqual(list.body.hiddenCount, 1);
  assert.strictEqual((await api('GET', `/conversations/${c}/messages`, { token: alice.token })).status, 423);
  assert.strictEqual((await api('GET', '/hidden-chats', { token: alice.token })).status, 423);
  assert.strictEqual((await api('DELETE', `/conversations/${c}/hide`, { token: alice.token })).status, 423, 'cannot unhide without revealing');

  // Two app sessions of Alice; Bob keeps writing.
  const tabA = await client(alice.token, 'A');
  const tabB = await client(alice.token, 'B');
  const bobApp = await client(bob.token, 'bob');
  const seen = { A: [], B: [] };
  for (const [k, s] of Object.entries({ A: tabA, B: tabB })) {
    for (const ev of ['message:new', 'conversation:updated', 'typing']) s.on(ev, (p) => seen[k].push([ev, p]));
  }
  assert.strictEqual((await call(tabA, 'conversations')).conversations.length, 0);
  assert.match((await call(tabA, 'messages:get', { convId: dm.id })).error, /locked/);

  // Wrong code, then the right one reveals this session only.
  assert.match((await call(tabA, 'hidden:reveal', { code: '0000' })).error, /Wrong secret code/);
  const revealed = await call(tabA, 'hidden:reveal', { code: '2468' });
  assert.deepStrictEqual(revealed.conversations.map((x) => [x.id, x.hidden, x.locked]), [[dm.id, true, false]]);
  assert.strictEqual((await call(tabA, 'messages:get', { convId: dm.id })).messages[0].text, 'secret plans');
  assert.match((await call(tabB, 'hidden:list')).error, /secret code/);

  await call(bobApp, 'typing', { convId: dm.id, isTyping: true });
  await call(bobApp, 'message:send', { convId: dm.id, text: 'second message' });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(seen.A.map(([ev]) => ev).sort(), ['message:new', 'typing'], 'revealed session gets live updates');
  assert.strictEqual(seen.A.find(([ev]) => ev === 'message:new')[1].message.text, 'second message');
  assert.deepStrictEqual(seen.B, [], 'other session hears nothing: no message, preview or typing');
  assert.deepStrictEqual(hooked.filter((h) => h.event !== 'chatlock:update'), [], 'webhooks hear nothing about the chat');
  assert.ok(hooked.every((h) => JSON.stringify(h).includes(dm.id) === false), 'no hook mentions the hidden chat');
  assert.strictEqual((await call(tabB, 'conversations')).conversations.length, 0);
  // Opening the chat directly (e.g. from New chat) is still locked, and its preview is redacted.
  const direct = (await call(tabB, 'chat:direct', { username: 'bob' })).conversation;
  assert.deepStrictEqual([direct.hidden, direct.locked, direct.lastMessage.text], [true, true, undefined]);
  const rest = await api('GET', `/conversations/${c}/messages`, { token: alice.token });
  assert.strictEqual(rest.status, 423, 'a REST credential is its own session');

  // The voice-note/star paths use the same gate.
  const starred = (await call(tabB, 'messages:starred')).messages;
  assert.deepStrictEqual(starred, []);

  // Closing hidden chats ("lock now") hides them again in this session; reconnect keeps session state, closing last tab ends it.
  await call(tabA, 'hidden:close');
  assert.match((await call(tabA, 'hidden:list')).error, /secret code/);
  await call(tabA, 'hidden:reveal', { code: '2468' });
  tabA.close();
  await new Promise((r) => setTimeout(r, 150));
  const tabA2 = await client(alice.token, 'A');
  assert.match((await call(tabA2, 'hidden:list')).error, /secret code/, 'closing the last tab ends the reveal');

  // Unhiding (while revealed) puts it back on the dashboard everywhere.
  await call(tabA2, 'hidden:reveal', { code: '2468' });
  const unhidden = await call(tabA2, 'hidden:unhide', { convId: dm.id });
  assert.deepStrictEqual([unhidden.conversation.hidden, unhidden.conversation.locked, unhidden.hiddenCount], [undefined, false, 0]);
  assert.strictEqual((await call(tabB, 'conversations')).conversations.length, 1);
  assert.ok((await call(tabB, 'messages:get', { convId: dm.id })).ok);
  void base;
});

test('settings: clear all hidden chats, remove all chat locks (code required)', async (t) => {
  const { store, client, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  for (const u of ['bob1', 'bob2', 'bob3']) store.register(u, 'pass');
  const chats = ['bob1', 'bob2', 'bob3'].map((u) => store.getOrCreateDirect('alice', u).id);
  store.setLockCode('alice', '2468');
  store.setChatHidden('alice', chats[0], true);
  store.setChatHidden('alice', chats[1], true);
  store.setChatLocked('alice', chats[2], true);
  const s = await client(alice.token, 'A');

  assert.match((await call(s, 'hidden:clear', { code: 'nope' })).error, /Wrong/);
  assert.strictEqual(store.hiddenChats('alice').length, 2, 'nothing changed');
  const changed = new Promise((r) => s.once('hidden:update', r));
  const cleared = await call(s, 'hidden:clear', { code: '2468' });
  await changed;
  assert.deepStrictEqual([cleared.cleared, cleared.hiddenCount, cleared.lockedChats], [2, 0, [chats[2]]]);
  assert.strictEqual((await call(s, 'conversations')).conversations.length, 3, 'all back on the dashboard');

  assert.strictEqual((await api('POST', '/chat-lock/clear', { token: alice.token, body: { code: '1' } })).status, 403);
  const locks = await api('POST', '/chat-lock/clear', { token: alice.token, body: { code: '2468' } });
  assert.deepStrictEqual([locks.status, locks.body.cleared, locks.body.lockedChats], [200, 1, []]);
  assert.ok((await call(s, 'messages:get', { convId: chats[2] })).ok);
  // REST for hide/reveal/close/clear.
  const c = encodeURIComponent(chats[0]);
  await api('PUT', `/conversations/${c}/hide`, { token: alice.token });
  assert.strictEqual((await api('POST', '/hidden-chats/reveal', { token: alice.token, body: { code: '2468' } })).body.conversations.length, 1);
  assert.strictEqual((await api('GET', '/hidden-chats', { token: alice.token })).status, 200);
  await api('POST', '/hidden-chats/close', { token: alice.token });
  assert.strictEqual((await api('GET', '/hidden-chats', { token: alice.token })).status, 423);
  assert.strictEqual((await api('POST', '/hidden-chats/clear', { token: alice.token, body: { code: '2468' } })).body.cleared, 1);
});

test('fingerprint/face lock: enrol a device, reveal and unlock with it, replays and fakes fail', async (t) => {
  const { store, client, api, base } = await setup(t);
  const alice = store.register('alice', 'pass');
  store.register('bob', 'pass');
  const hidden = store.getOrCreateDirect('alice', 'bob');
  const locked = store.getOrCreateDirect('alice', store.register('carol', 'pass') && 'carol');
  store.setLockCode('alice', '2468');
  store.setChatHidden('alice', hidden.id, true);
  store.setChatLocked('alice', locked.id, true);
  const phone = fakePhone(base);
  const s = await client(alice.token, 'A');
  const challenge = async () => (await api('POST', '/biometric/challenge', { token: alice.token })).body;

  // Enrolling needs the code, a verified user (UV flag) and a fresh challenge.
  const ch = await challenge();
  assert.strictEqual((await api('POST', '/biometric', { token: alice.token, body: { code: 'bad', credential: phone.create(ch.challenge) } })).status, 403);
  const ch2 = await challenge();
  const weak = await api('POST', '/biometric', { token: alice.token, body: { code: '2468', credential: phone.create(ch2.challenge, { flags: 0x41 }) } });
  assert.deepStrictEqual([weak.status, weak.body.error.code], [400, 'biometric_failed']);
  const ch3 = await challenge();
  const added = await api('POST', '/biometric', { token: alice.token, body: { code: '2468', name: 'My phone', credential: phone.create(ch3.challenge) } });
  assert.deepStrictEqual([added.status, added.body.biometric.map((d) => d.name)], [201, ['My phone']]);
  assert.strictEqual(added.body.biometric[0].id, phone.id);
  assert.strictEqual((await api('POST', '/biometric', { token: alice.token, body: { code: '2468', credential: phone.create(ch3.challenge) } })).status, 400, 'challenges are single use');

  // Reveal hidden chats with a fingerprint.
  const reveal = await call(s, 'hidden:reveal', { biometric: phone.get((await challenge()).challenge) });
  assert.deepStrictEqual(reveal.conversations.map((c) => c.id), [hidden.id]);

  // Unlock a locked chat with it too.
  const unlock = await call(s, 'chatlock:unlock', { convId: locked.id, biometric: phone.get((await challenge()).challenge) });
  assert.strictEqual(unlock.conversation.unlocked, true);

  // Replays, wrong challenges, other devices, unverified users and forged signatures fail.
  const good = phone.get((await challenge()).challenge);
  assert.ok((await call(s, 'hidden:reveal', { biometric: good })).ok);
  assert.match((await call(s, 'hidden:reveal', { biometric: good })).error, /Wrong fingerprint or face check/, 'a proof works once');
  assert.match((await call(s, 'hidden:reveal', { biometric: phone.get('made-up-challenge') })).error, /Wrong fingerprint/);
  assert.match((await call(s, 'hidden:reveal', { biometric: phone.get((await challenge()).challenge, { flags: 0x01 }) })).error, /Wrong fingerprint/, 'no user verification');
  const other = fakePhone(base);
  assert.match((await call(s, 'hidden:reveal', { biometric: other.get((await challenge()).challenge) })).error, /Wrong fingerprint/, 'unknown device');
  const forged = phone.get((await challenge()).challenge);
  forged.signature = b64u(Buffer.alloc(70, 1));
  assert.match((await call(s, 'hidden:reveal', { biometric: forged })).error, /Wrong fingerprint/);
  const elsewhere = fakePhone('http://evil.example');
  const stolen = elsewhere.get((await challenge()).challenge);
  stolen.id = phone.id;
  assert.match((await call(s, 'hidden:reveal', { biometric: stolen })).error, /Wrong fingerprint|Too many/, 'signed for another site');

  // Settings and removal.
  assert.deepStrictEqual((await api('GET', '/chat-lock', { token: alice.token })).body.biometric.map((d) => d.id), [phone.id]);
  assert.strictEqual(store.passkeysOf('alice')[0].publicKey === undefined, false);
  assert.strictEqual(JSON.stringify((await api('GET', '/chat-lock', { token: alice.token })).body).includes('publicKey'), false, 'keys are never returned');
});

test('fingerprint/face: wrong tries share the lockout; removing a device needs proof', async (t) => {
  const { store, client, api, base } = await setup(t);
  const alice = store.register('alice', 'pass');
  store.setLockCode('alice', '2468');
  const phone = fakePhone(base);
  const ch = (await api('POST', '/biometric/challenge', { token: alice.token })).body;
  await api('POST', '/biometric', { token: alice.token, body: { code: '2468', credential: phone.create(ch.challenge) } });
  const s = await client(alice.token, 'A');
  for (let i = 0; i < 5; i++) await call(s, 'hidden:reveal', { code: `x${i}` });
  assert.match((await call(s, 'hidden:reveal', { code: '2468' })).error, /Too many wrong attempts/);
  assert.match((await call(s, 'hidden:reveal', { biometric: phone.get('x') })).error, /Too many wrong attempts/);

  const { store: store2, api: api2 } = await setup(t);
  const bob = store2.register('bob', 'pass');
  store2.setLockCode('bob', '1357');
  const ph = fakePhone(base);
  void ph; // different server instance: origin differs from rpId only by port, which WebAuthn ignores
  const chb = (await api2('POST', '/biometric/challenge', { token: bob.token })).body;
  const base2 = `http://localhost:1`;
  const ph2 = fakePhone(base2);
  await api2('POST', '/biometric', { token: bob.token, body: { code: '1357', credential: ph2.create(chb.challenge) } });
  assert.strictEqual((await api2('DELETE', `/biometric/${ph2.id}`, { token: bob.token, body: { code: 'bad' } })).status, 403);
  assert.strictEqual((await api2('DELETE', `/biometric/${ph2.id}`, { token: bob.token, body: { code: '1357' } })).body.biometric.length, 0);
  assert.strictEqual((await api2('DELETE', `/biometric/${ph2.id}`, { token: bob.token, body: { code: '1357' } })).status, 404);
});

test('hide a specific contact before they ever write: their first message stays hidden', async (t) => {
  const { store, client, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  store.register('carol', 'pass');
  assert.strictEqual((await api('PUT', '/hidden-contacts/bob', { token: alice.token })).body.error.code, 'code_required');
  store.setLockCode('alice', '2468');
  assert.strictEqual((await api('PUT', '/hidden-contacts/nobody', { token: alice.token })).status, 404);
  const res = await api('PUT', '/hidden-contacts/Bob', { token: alice.token });
  assert.deepStrictEqual([res.status, res.body.hiddenCount, res.body.convId], [200, 1, 'dm:alice:bob']);

  const tab = await client(alice.token, 'A');
  const seen = [];
  for (const ev of ['message:new', 'conversation:new', 'conversation:updated']) tab.on(ev, (p) => seen.push(ev, p));
  const bobApp = await client(bob.token, 'b');
  await call(bobApp, 'chat:direct', { username: 'alice' }).then((r) => call(bobApp, 'message:send', { convId: r.conversation.id, text: 'hi, first message' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(seen, [], 'no notification of any kind');
  assert.deepStrictEqual((await call(tab, 'conversations')).conversations, [], 'not on the dashboard');
  // Only Bob is hidden: other contacts behave normally.
  const carol = store.register('dave', 'pass');
  const carolApp = await client(carol.token, 'c');
  await call(carolApp, 'chat:direct', { username: 'alice' }).then((r) => call(carolApp, 'message:send', { convId: r.conversation.id, text: 'hello' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual((await call(tab, 'conversations')).conversations.map((c) => c.members.sort().join()), ['alice,dave']);
  assert.strictEqual((await call(tab, 'hidden:reveal', { code: '2468' })).conversations[0].lastMessage.text, 'hi, first message');
});
