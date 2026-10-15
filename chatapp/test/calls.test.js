'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev, filter = () => true) => new Promise((r) => {
  const fn = (p) => { if (filter(p)) { s.off(ev, fn); r(p); } };
  s.on(ev, fn);
});

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
  for (const u of ['alice', 'bob', 'carol', 'dave']) tokens[u] = store.register(u, 'pass').token;
  const dm = store.getOrCreateDirect('alice', 'bob');
  return { store, client, tokens, dm };
}

test('calls: ring, join, relay signals, hold, hang up and log the call', async (t) => {
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
  assert.strictEqual(ring.group, false);
  assert.strictEqual((await incomingPhone).callId, started.callId);

  // Alice can't start a second call while this one is ringing.
  assert.strictEqual((await call(alice, 'call:start', { convId: dm.id, kind: 'audio' })).ok, false);

  const joined = next(alice, 'call:joined');
  const phoneStops = next(bobPhone, 'call:ended');
  const accepted = await call(bob, 'call:accept', { callId: started.callId });
  assert.ok(accepted.ok, accepted.error);
  assert.deepStrictEqual(accepted.participants, ['alice'], 'the joiner learns who to send offers to');
  assert.strictEqual((await joined).username, 'bob');
  assert.strictEqual((await phoneStops).reason, 'answered-elsewhere');

  // Offer/answer relay goes to the named participant.
  const offer = next(alice, 'call:signal');
  bob.emit('call:signal', { callId: started.callId, to: 'alice', data: { description: { type: 'offer', sdp: 'x' } } });
  const got = await offer;
  assert.strictEqual(got.from, 'bob');
  assert.deepStrictEqual(got.data, { description: { type: 'offer', sdp: 'x' } });
  const answer = next(bob, 'call:signal');
  alice.emit('call:signal', { callId: started.callId, to: 'bob', data: { description: { type: 'answer', sdp: 'y' } } });
  assert.strictEqual((await answer).data.description.type, 'answer');

  // Hold is shown to the other side.
  const held = next(alice, 'call:hold');
  await call(bob, 'call:hold', { callId: started.callId, onHold: true });
  assert.deepStrictEqual(await held, { callId: started.callId, username: 'bob', onHold: true });

  const logged = next(bob, 'message:new');
  const ended = next(bob, 'call:ended', (e) => e.status);
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

test('group calls: ring everyone, join later, leave, and end when one person is left', async (t) => {
  const { client, tokens, store } = await setup(t);
  const grp = store.createGroup('alice', 'Team', ['bob', 'carol', 'dave']);
  const alice = await client(tokens.alice);
  const bob = await client(tokens.bob);
  const carol = await client(tokens.carol);
  // dave is offline: not rung, but the call is logged as missed for him.

  const state = next(carol, 'call:state', (s) => s.call);
  const rings = [next(bob, 'call:incoming'), next(carol, 'call:incoming')];
  const started = await call(alice, 'call:start', { convId: grp.id, kind: 'audio' });
  assert.ok(started.ok, started.error);
  const [ringBob] = await Promise.all(rings);
  assert.strictEqual(ringBob.group, true);
  assert.strictEqual(ringBob.title, 'Team');
  assert.deepStrictEqual((await state).call.participants, ['alice']);

  // bob joins: alice is told; bob offers to alice.
  const aliceSeesBob = next(alice, 'call:joined');
  assert.deepStrictEqual((await call(bob, 'call:accept', { callId: started.callId })).participants, ['alice']);
  assert.strictEqual((await aliceSeesBob).username, 'bob');

  // carol declines, then changes her mind and joins the running call from the chat.
  await call(carol, 'call:reject', { callId: started.callId });
  const joinedNotes = [next(alice, 'call:joined'), next(bob, 'call:joined')];
  const join = await call(carol, 'call:start', { convId: grp.id, kind: 'video' });
  assert.ok(join.ok, join.error);
  assert.strictEqual(join.callId, started.callId, 'joins the existing call instead of starting another');
  assert.strictEqual(join.kind, 'audio');
  assert.deepStrictEqual(join.participants.sort(), ['alice', 'bob']);
  await Promise.all(joinedNotes);

  // The conversation list shows the running call.
  const { conversations } = await call(alice, 'conversations');
  assert.deepStrictEqual(conversations.find((c) => c.id === grp.id).activeCall.participants.sort(), ['alice', 'bob', 'carol']);

  // alice leaves: the call carries on for bob and carol.
  const left = next(bob, 'call:left');
  await call(alice, 'call:end', { callId: started.callId });
  assert.strictEqual((await left).username, 'alice');

  // carol leaves: bob is alone, so the call ends and is logged.
  const ended = next(bob, 'call:ended');
  const logged = next(bob, 'message:new');
  await call(carol, 'call:end', { callId: started.callId });
  assert.strictEqual((await ended).status, 'completed');
  const { message } = await logged;
  assert.strictEqual(message.call.group, true);
  assert.deepStrictEqual(message.call.joined.sort(), ['alice', 'bob', 'carol']);
  assert.strictEqual(store.conversationsFor('dave').find((c) => c.id === grp.id).unread, 1, 'missed by dave');
  assert.strictEqual(store.conversationsFor('carol').find((c) => c.id === grp.id).unread, 0);
});

test('calls: blocking, groups with nobody available, and outsiders', async (t) => {
  const { client, tokens, dm, store } = await setup(t);
  const alice = await client(tokens.alice);
  const bob = await client(tokens.bob);
  const carol = await client(tokens.carol);

  // bob blocks alice: alice's call never rings him and nothing is logged for him.
  store.setBlocked('bob', 'alice', true);
  let rang = false;
  bob.on('call:incoming', () => { rang = true; });
  assert.match((await call(alice, 'call:start', { convId: dm.id, kind: 'audio' })).error, /not available/);
  // and bob can't call alice while he blocks her.
  assert.match((await call(bob, 'call:start', { convId: dm.id, kind: 'audio' })).error, /Unblock/);
  assert.strictEqual(rang, false);
  assert.strictEqual(store.data.messages[dm.id].length, 0);

  const grp = store.createGroup('carol', 'Quiet', ['dave']); // dave offline
  assert.match((await call(carol, 'call:start', { convId: grp.id, kind: 'audio' })).error, /No one/);
  assert.match((await call(alice, 'call:start', { convId: grp.id, kind: 'audio' })).error, /Not a member/);
  assert.match((await call(alice, 'call:start', { convId: dm.id, kind: 'hologram' })).error, /Invalid/);
});
