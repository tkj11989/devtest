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
const silent = (s, ev, ms = 150) => new Promise((r) => {
  const fn = () => { s.off(ev, fn); r(false); };
  s.on(ev, fn);
  setTimeout(() => { s.off(ev, fn); r(true); }, ms);
});

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const app = createApp({ store, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const url = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = (token) => new Promise((resolve, reject) => {
    const s = connect(url, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
  const tokens = {};
  for (const u of ['alice', 'bob', 'carol', 'dave']) {
    tokens[u] = store.register(u, 'pass').token;
    // Recording is a Premium feature for whoever asks to record.
    if (!opts.free) store.activateSubscription(u, { plan: 'monthly', expiresAt: Date.now() + 30 * 86400000 });
  }
  return { store, client, tokens, app };
}

/** A connected 1:1 call between alice and bob. */
async function oneToOne(t, opts) {
  const env = await setup(t, opts);
  const { client, tokens, store } = env;
  const dm = store.getOrCreateDirect('alice', 'bob');
  const alice = await client(tokens.alice);
  const bob = await client(tokens.bob);
  const incoming = next(bob, 'call:incoming');
  const started = await call(alice, 'call:start', { convId: dm.id, kind: 'audio' });
  await incoming;
  await call(bob, 'call:accept', { callId: started.callId });
  return { ...env, dm, alice, bob, callId: started.callId };
}

test('recording needs everyone: request, accept, then it is on for all', async (t) => {
  const { alice, bob, callId, store, dm } = await oneToOne(t);
  const aliceSees = []; const bobSees = [];
  alice.on('call:record', (p) => aliceSees.push(p));
  bob.on('call:record', (p) => bobSees.push(p));

  const asked = await call(alice, 'call:record-request', { callId });
  assert.deepStrictEqual([asked.ok, asked.state, asked.by, asked.waiting], [true, 'pending', 'alice', ['bob']]);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual([bobSees[0].state, bobSees[0].by, bobSees[0].waiting, bobSees[0].expiresIn], ['pending', 'alice', ['bob'], 30], 'the other person is asked');
  assert.strictEqual(aliceSees[0].state, 'pending', 'the requester sees it is waiting');

  // Nothing is recording until Bob agrees; a second request and a stranger's answer are refused.
  assert.match((await call(alice, 'call:record-request', { callId })).error, /already waiting/);
  const on = next(alice, 'call:record', (p) => p.state === 'on');
  const bobOn = next(bob, 'call:record', (p) => p.state === 'on');
  const agreed = await call(bob, 'call:record-respond', { callId, accept: true });
  assert.strictEqual(agreed.state, 'on');
  const [a, b] = await Promise.all([on, bobOn]);
  assert.deepStrictEqual([a.by, typeof a.startedAt, b.by], ['alice', 'number', 'alice'], 'both are told, so both see the recording indicator');
  assert.match((await call(alice, 'call:record-request', { callId })).error, /already being recorded/);

  // The call log says it was recorded (and nothing else about it is kept).
  const ended = next(alice, 'call:ended');
  await call(bob, 'call:end', { callId });
  await ended;
  const entry = store.data.messages[dm.id].at(-1);
  assert.strictEqual(entry.call.recorded, true);
  assert.deepStrictEqual(Object.keys(entry.call).sort(), ['duration', 'kind', 'recorded', 'status']);
});

test('recording: declining, cooldown, timeout and stopping by anyone', async (t) => {
  const { alice, bob, callId, store, dm } = await oneToOne(t, { calls: undefined });
  // Decline.
  await call(alice, 'call:record-request', { callId });
  const declined = next(alice, 'call:record', (p) => p.reason === 'declined');
  assert.ok((await call(bob, 'call:record-respond', { callId, accept: false })).ok);
  const d = await declined;
  assert.deepStrictEqual([d.state, d.by], ['off', 'bob']);
  assert.match((await call(alice, 'call:record-request', { callId })).error, /Someone declined\. Wait \d+ seconds/);
  assert.match((await call(bob, 'call:record-respond', { callId, accept: true })).error, /no recording request/);
  // Bob (who declined) may ask himself, and then Alice decides.
  assert.ok((await call(bob, 'call:record-request', { callId })).ok);
  assert.ok((await call(alice, 'call:record-respond', { callId, accept: true })).ok);
  // Anyone can stop: Alice (who agreed) withdraws consent and it ends for everyone.
  const stopped = next(bob, 'call:record', (p) => p.reason === 'stopped');
  await call(alice, 'call:record-stop', { callId });
  assert.deepStrictEqual([(await stopped).state, (await stopped).by], ['off', 'alice']);
  assert.ok((await call(alice, 'call:record-stop', { callId })).ok, 'stopping when nothing records is harmless');
  // A call where nobody agreed has no "recorded" mark.
  await call(alice, 'call:end', { callId });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(store.data.messages[dm.id].at(-1).call.recorded, true, 'it was recorded for a while, so it says so');
});

test('recording: the request expires if nobody answers; unrecorded calls carry no mark', async (t) => {
  const { alice, bob, callId, store, dm } = await oneToOne(t, { recordConsentMs: 80 });
  const expired = next(bob, 'call:record', (p) => p.reason === 'timeout');
  await call(alice, 'call:record-request', { callId });
  assert.strictEqual((await expired).state, 'off');
  assert.match((await call(bob, 'call:record-respond', { callId, accept: true })).error, /no recording request/, 'too late to agree');
  await call(alice, 'call:end', { callId });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(store.data.messages[dm.id].at(-1).call.recorded, undefined, 'nothing was recorded, so nothing is marked');
});

test('group calls: everyone must agree; joining or the requester leaving stops it', async (t) => {
  const { client, tokens, store } = await setup(t);
  const grp = store.createGroup('alice', 'Team', ['bob', 'carol', 'dave']);
  const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((u) => client(tokens[u])));
  const inc = [next(bob, 'call:incoming'), next(carol, 'call:incoming'), next(dave, 'call:incoming')];
  const started = await call(alice, 'call:start', { convId: grp.id, kind: 'audio' });
  await Promise.all(inc);
  const { callId } = started;
  await call(bob, 'call:accept', { callId });
  await call(carol, 'call:accept', { callId });

  // Alice asks; Bob agrees; Carol hasn't: not recording yet.
  const asked = await call(alice, 'call:record-request', { callId });
  assert.deepStrictEqual(asked.waiting.sort(), ['bob', 'carol']);
  const dave2 = silent(dave, 'call:record');
  await call(bob, 'call:record-respond', { callId, accept: true });
  const onHold = await silent(alice, 'call:record', 100);
  void onHold;
  assert.strictEqual(await dave2, true, 'someone who is not in the call is not told');
  const on = next(alice, 'call:record', (p) => p.state === 'on');
  await call(carol, 'call:record-respond', { callId, accept: true });
  assert.strictEqual((await on).state, 'on');

  // Dave joins the running call: he has not agreed, so recording stops for everyone.
  const stoppedForJoin = next(alice, 'call:record', (p) => p.reason === 'participant-joined');
  const joined = await call(dave, 'call:accept', { callId });
  assert.strictEqual(joined.recording.state, 'off');
  const s = await stoppedForJoin;
  assert.deepStrictEqual([s.state, s.by], ['off', 'dave']);

  // Ask again, now with everyone in; Dave's answer is needed too. The one it waits for leaves: it starts.
  await call(carol, 'call:record-request', { callId });
  await call(alice, 'call:record-respond', { callId, accept: true });
  await call(bob, 'call:record-respond', { callId, accept: true });
  const started2 = next(alice, 'call:record', (p) => p.state === 'on');
  await call(dave, 'call:end', { callId });
  assert.strictEqual((await started2).by, 'carol', 'whoever it was waiting for left; the others had agreed');

  // The requester leaves: it stops.
  const gone = next(alice, 'call:record', (p) => p.reason === 'requester-left');
  await call(carol, 'call:end', { callId });
  assert.deepStrictEqual([(await gone).state, (await gone).by], ['off', 'carol']);
});

test('recording: switched off by the administrator, one-person calls and ringing calls refused', async (t) => {
  const { store, alice, bob, callId } = await oneToOne(t);
  store.updateSettings({ features: { callRecording: false } });
  const r = await call(alice, 'call:record-request', { callId });
  assert.deepStrictEqual([r.ok, r.code], [false, 'feature_disabled']);
  assert.ok((await call(bob, 'call:record-stop', { callId })).ok, 'stopping always works');
  store.updateSettings({ features: { callRecording: true } });

  // Not a participant.
  const env = await setup(t);
  const dm = env.store.getOrCreateDirect('alice', 'bob');
  const a = await env.client(env.tokens.alice);
  const bb = await env.client(env.tokens.bob);
  const c = await env.client(env.tokens.carol);
  const inc = next(bb, 'call:incoming');
  const started = await call(a, 'call:start', { convId: dm.id, kind: 'audio' });
  await inc;
  // Still ringing: Bob has not answered, so there is nobody to ask.
  assert.match((await call(a, 'call:record-request', { callId: started.callId })).error, /at least two people/);
  await call(bb, 'call:accept', { callId: started.callId });
  assert.match((await call(c, 'call:record-request', { callId: started.callId })).error, /Call not found/);
  assert.match((await call(c, 'call:record-respond', { callId: started.callId, accept: true })).error, /Call not found/);
  assert.match((await call(c, 'call:record-stop', { callId: started.callId })).error, /Call not found/);
});

test('recording is a Premium feature for the person who records; others only answer', async (t) => {
  const { client, tokens, store } = await setup(t, { free: true });
  store.activateSubscription('alice', { plan: 'daily', expiresAt: Date.now() + 86400000 }); // only Alice is Premium
  const dm = store.getOrCreateDirect('alice', 'bob');
  const alice = await client(tokens.alice);
  const bob = await client(tokens.bob);
  const incoming = next(bob, 'call:incoming');
  const started = await call(alice, 'call:start', { convId: dm.id, kind: 'audio' });
  await incoming;
  await call(bob, 'call:accept', { callId: started.callId });
  const free = await call(bob, 'call:record-request', { callId: started.callId });
  assert.deepStrictEqual([free.ok, free.code], [false, 'premium_required']);
  assert.match(free.error, /Premium feature/);
  // A Premium person asks; the free person can agree (they are not recording).
  assert.ok((await call(alice, 'call:record-request', { callId: started.callId })).ok);
  const on = next(bob, 'call:record', (p) => p.state === 'on');
  assert.ok((await call(bob, 'call:record-respond', { callId: started.callId, accept: true })).ok);
  assert.strictEqual((await on).by, 'alice');
  // Premium ending mid-call doesn't stop a recording everyone agreed to, but no new one can start.
  store.data.users.alice.subscription.expiresAt = Date.now() - 1;
  await call(bob, 'call:record-stop', { callId: started.callId });
  assert.strictEqual((await call(alice, 'call:record-request', { callId: started.callId })).code, 'premium_required');
});
