'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const { server, io } = createApp({ store, ...opts });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); io.close(); server.close(); });

  const client = (token) => new Promise((resolve, reject) => {
    const s = connect(url, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });

  const tokens = {};
  for (const u of ['alice', 'bob', 'carol']) tokens[u] = store.register(u, 'pass').token;
  const dm = store.getOrCreateDirect('alice', 'bob');
  return { store, client, tokens, dm };
}

test('calls: ring, accept, relay signals, hang up and log the call', async (t) => {
  const { client, tokens, dm, store } = await setup(t);
  const alice = await client(tokens.alice);
  const bob = await client(tokens.bob);
  const bobPhone = await client(tokens.bob); // second device

  const me = await call(alice, 'me');
  assert.ok(Array.isArray(me.iceServers) && me.iceServers.length > 0, 'ICE servers are provided');

  const incoming = next(bob, 'call:incoming');
  const incomingPhone = next(bobPhone, 'call:incoming');
  const started = await call(alice, 'call:start', { convId: dm.id, kind: 'video' });
  assert.ok(started.ok, started.error);
  const ring = await incoming;
  assert.strictEqual(ring.from, 'alice');
  assert.strictEqual(ring.kind, 'video');
  assert.strictEqual((await incomingPhone).callId, started.callId);

  // Alice can't start a second call while this one is ringing.
  const second = await call(alice, 'call:start', { convId: dm.id, kind: 'audio' });
  assert.strictEqual(second.ok, false);

  const accepted = next(alice, 'call:accepted');
  const phoneStops = next(bobPhone, 'call:ended');
  assert.ok((await call(bob, 'call:accept', { callId: started.callId })).ok);
  await accepted;
  assert.strictEqual((await phoneStops).reason, 'answered-elsewhere');

  // Offer/answer relay goes only between the two participating sockets.
  const offer = next(bob, 'call:signal');
  alice.emit('call:signal', { callId: started.callId, data: { description: { type: 'offer', sdp: 'x' } } });
  assert.deepStrictEqual((await offer).data, { description: { type: 'offer', sdp: 'x' } });
  const answer = next(alice, 'call:signal');
  bob.emit('call:signal', { callId: started.callId, data: { description: { type: 'answer', sdp: 'y' } } });
  assert.strictEqual((await answer).data.description.type, 'answer');

  const logged = next(bob, 'message:new');
  const ended = next(bob, 'call:ended');
  assert.ok((await call(alice, 'call:end', { callId: started.callId })).ok);
  assert.strictEqual((await ended).status, 'completed');
  const { message } = await logged;
  assert.strictEqual(message.type, 'call');
  assert.deepStrictEqual({ kind: message.call.kind, status: message.call.status }, { kind: 'video', status: 'completed' });
  assert.strictEqual(store.conversationsFor('bob')[0].unread, 0, 'answered calls are not unread');
});

test('calls: declined, unanswered, offline and busy calls are logged as such', async (t) => {
  const { client, tokens, dm, store } = await setup(t, { ringTimeoutMs: 100 });
  const alice = await client(tokens.alice);
  const bob = await client(tokens.bob);

  // Declined
  let incoming = next(bob, 'call:incoming');
  let res = await call(alice, 'call:start', { convId: dm.id, kind: 'audio' });
  await incoming;
  let ended = next(alice, 'call:ended');
  await call(bob, 'call:reject', { callId: res.callId });
  assert.strictEqual((await ended).reason, 'declined');

  // No answer (ring timeout)
  ended = next(alice, 'call:ended');
  res = await call(alice, 'call:start', { convId: dm.id, kind: 'audio' });
  assert.strictEqual((await ended).reason, 'no-answer');

  // Busy: bob is on a call with carol
  const carol = await client(tokens.carol);
  const dm2 = store.getOrCreateDirect('carol', 'bob');
  incoming = next(bob, 'call:incoming');
  const c = await call(carol, 'call:start', { convId: dm2.id, kind: 'audio' });
  await incoming;
  await call(bob, 'call:accept', { callId: c.callId });
  res = await call(alice, 'call:start', { convId: dm.id, kind: 'video' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /another call/);

  // Disconnecting ends the active call for the other side.
  ended = next(carol, 'call:ended');
  bob.close();
  assert.strictEqual((await ended).reason, 'disconnected');

  // Offline
  res = await call(alice, 'call:start', { convId: dm.id, kind: 'audio' });
  assert.match(res.error, /not available/);

  const statuses = store.data.messages[dm.id].filter((m) => m.type === 'call').map((m) => m.call.status);
  assert.deepStrictEqual(statuses, ['declined', 'missed', 'missed', 'missed']);
  assert.strictEqual(store.conversationsFor('bob').find((x) => x.id === dm.id).unread, 4);
});

test('calls: group chats and outsiders are rejected', async (t) => {
  const { client, tokens, dm, store } = await setup(t);
  const alice = await client(tokens.alice);
  const carol = await client(tokens.carol);
  const grp = store.createGroup('alice', 'Team', ['bob', 'carol']);

  assert.match((await call(alice, 'call:start', { convId: grp.id, kind: 'audio' })).error, /Group calls/);
  assert.match((await call(carol, 'call:start', { convId: dm.id, kind: 'audio' })).error, /Not a member/);
  assert.match((await call(alice, 'call:start', { convId: dm.id, kind: 'hologram' })).error, /Invalid/);
});
