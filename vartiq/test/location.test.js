'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const E2EE = require('../public/e2ee.js');

const once = (s, ev, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no ${ev}`)), ms);
  const fn = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, fn); resolve(p); } };
  s.on(ev, fn);
});

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const app = createApp({ store, messageSweepMs: 40, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token) => {
    const s = connect(base, { auth: { token, appSession: 'x' }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
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
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const conv = (await api('POST', '/conversations', alice.token, { type: 'direct', username: 'bob' })).body.conversation;
  return { store, app, client, api, alice, bob, conv };
}
const here = { lat: 12.9716, lon: 77.5946, acc: 20 };

test('location: share once, in the clear (API apps), with checks', async (t) => {
  const { api, alice, bob, conv, store } = await setup(t);
  const res = await api('POST', `/conversations/${conv.id}/location`, alice.token, { location: { lat: 12.97161234, lon: 77.59461234, acc: 20.4 } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const m = res.body.message;
  assert.strictEqual(m.type, 'location');
  assert.deepStrictEqual(m.location, { lat: 12.971612, lon: 77.594612, acc: 20 }, 'rounded to about 10 cm');
  assert.strictEqual(m.live, undefined, 'a one-time share has no live part');

  const seen = (await api('GET', `/conversations/${conv.id}/messages`, bob.token)).body.messages.at(-1);
  assert.strictEqual(seen.type, 'location');
  assert.strictEqual(seen.location.lat, 12.971612);

  for (const bad of [{}, { location: { lat: 91, lon: 0 } }, { location: { lat: 0, lon: 181 } }, { location: { lat: 'x', lon: 1 } }, { location: { lat: 1, lon: 1, acc: -5 } }]) {
    assert.strictEqual((await api('POST', `/conversations/${conv.id}/location`, alice.token, bad)).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await api('POST', `/conversations/${conv.id}/location`, alice.token, { live: 7, location: here })).status, 400, 'only the offered durations');
  const stranger = store.register('eve', 'pass');
  assert.strictEqual((await api('POST', `/conversations/${conv.id}/location`, stranger.token, { location: here })).status, 404, 'members only');

});

test('location: live share is updated, rate limited, replaced by a new one, and stopped; the position is erased', async (t) => {
  const { api, client, alice, bob, conv, store } = await setup(t);
  const sb = await client(bob.token);
  const started = once(sb, 'message:new');
  const res = await api('POST', `/conversations/${conv.id}/location`, alice.token, { live: 900, location: here });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const id = res.body.message.id;
  assert.strictEqual(res.body.message.live.until - res.body.message.live.startedAt, 900 * 1000);
  assert.strictEqual((await started).message.id, id, 'the other person is told at once');

  const moved = once(sb, 'location:update', (p) => p.message.id === id);
  const up = await api('PUT', `/live-locations/${id}`, alice.token, { location: { lat: 12.98, lon: 77.6, acc: 10 } });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  const got = await moved;
  assert.deepStrictEqual(got.message.location, { lat: 12.98, lon: 77.6, acc: 10 });
  assert.ok(got.message.live.updatedAt);

  assert.strictEqual((await api('PUT', `/live-locations/${id}`, alice.token, { location: here })).status, 429, 'not more often than every few seconds');
  assert.strictEqual((await api('PUT', `/live-locations/${id}`, bob.token, { location: here })).status, 404, 'only the sender moves it');

  // Starting another live share in the same chat ends the first.
  store.data.messages[conv.id].find((m) => m.id === id).live.updatedAt = 0; // pretend time passed
  const ended1 = once(sb, 'location:update', (p) => p.message.id === id && p.message.live.endedAt);
  const second = await api('POST', `/conversations/${conv.id}/location`, alice.token, { live: 3600, location: here });
  assert.strictEqual(second.status, 201);
  const e1 = await ended1;
  assert.strictEqual(e1.message.location, undefined, 'the old position is gone');
  const id2 = second.body.message.id;

  const ended2 = once(sb, 'location:update', (p) => p.message.id === id2 && p.message.live.endedAt);
  const stop = await api('DELETE', `/live-locations/${id2}`, alice.token);
  assert.strictEqual(stop.status, 200);
  const e2 = await ended2;
  assert.strictEqual(e2.message.location, undefined);
  assert.strictEqual(store.data.messages[conv.id].find((m) => m.id === id2).location, undefined, 'erased on the server too');
  assert.strictEqual((await api('PUT', `/live-locations/${id2}`, alice.token, { location: here })).status, 404, 'no updates after it ended');
  assert.strictEqual((await api('DELETE', `/live-locations/${id2}`, alice.token)).status, 404);
});

test('location: a live share ends by itself when its time is up', async (t) => {
  const { api, client, alice, bob, conv, store } = await setup(t);
  const sb = await client(bob.token);
  const res = await api('POST', `/conversations/${conv.id}/location`, alice.token, { live: 900, location: here });
  const id = res.body.message.id;
  const stored = store.data.messages[conv.id].find((m) => m.id === id);
  const ended = once(sb, 'location:update', (p) => p.message.id === id && p.message.live.endedAt);
  stored.live.until = Date.now() - 1; // time is up
  const got = await ended;
  assert.strictEqual(got.message.location, undefined);
  assert.strictEqual(store.liveDue().length, 0);
  assert.strictEqual((await api('PUT', `/live-locations/${id}`, alice.token, { location: here })).status, 404);
});

test('location: updates after the deadline are refused (409) and end the share', async (t) => {
  const { api, alice, conv, store } = await setup(t, { messageSweepMs: 60 * 1000 });
  const id = (await api('POST', `/conversations/${conv.id}/location`, alice.token, { live: 900, location: here })).body.message.id;
  store.data.messages[conv.id].find((m) => m.id === id).live.until = Date.now() - 1;
  const late = await api('PUT', `/live-locations/${id}`, alice.token, { location: here });
  assert.strictEqual(late.status, 409);
  assert.strictEqual(late.body.error.code, 'live_ended');
  assert.ok(store.data.messages[conv.id].find((m) => m.id === id).live.endedAt, 'and it is ended');
});

test('location: end-to-end encrypted chats keep the position inside the envelope (also while it moves)', async (t) => {
  const { api, client, alice, bob, conv, store } = await setup(t);
  const dev = async (token, name) => {
    const pair = await E2EE.generateDevice();
    const r = await api('POST', '/e2ee/devices', token, { name, publicKey: pair.publicKey });
    return { id: r.body.device.id, privateKey: pair.privateKey, publicKey: pair.publicKey };
  };
  const da = await dev(alice.token, 'a');
  const db = await dev(bob.token, 'b');
  const seal = async (payload) => {
    const keys = (await api('GET', `/conversations/${conv.id}/keys`, alice.token)).body.keys;
    const recipients = Object.values(keys).flat().map((d) => ({ id: d.id, publicKey: d.publicKey }));
    return (await E2EE.encrypt({ device: da, convId: conv.id, from: 'alice', recipients, payload })).envelope;
  };
  const sb = await client(bob.token);
  const first = once(sb, 'message:new');
  const res = await api('POST', `/conversations/${conv.id}/location`, alice.token, { live: 3600, e2ee: await seal({ t: 'Location', loc: { lat: 11.5, lon: 76.25, acc: 5 } }) });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const id = res.body.message.id;
  const keysOf = async (who) => (await api('GET', `/conversations/${conv.id}/keys`, bob.token)).body.keys[who];

  const stored = store.data.messages[conv.id].find((m) => m.id === id);
  assert.strictEqual(stored.location, undefined, 'no plain coordinates on the server');
  assert.ok(!JSON.stringify(stored).includes('11.5') && !JSON.stringify(stored).includes('76.25'));
  const msg = (await first).message;
  const read = await E2EE.decrypt({ device: db, convId: conv.id, from: 'alice', envelope: msg.e2ee, senderDevices: await keysOf('alice') });
  assert.deepStrictEqual(read.payload.loc, { lat: 11.5, lon: 76.25, acc: 5 });

  const moved = once(sb, 'location:update', (p) => p.message.id === id);
  const up = await api('PUT', `/live-locations/${id}`, alice.token, { e2ee: await seal({ t: 'Location', loc: { lat: 11.6, lon: 76.3, acc: 5 } }) });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  const upd = (await moved).message;
  assert.strictEqual(upd.location, undefined);
  const read2 = await E2EE.decrypt({ device: db, convId: conv.id, from: 'alice', envelope: upd.e2ee, senderDevices: await keysOf('alice') });
  assert.deepStrictEqual(read2.payload.loc, { lat: 11.6, lon: 76.3, acc: 5 });

  // A stale key list is refused like for any encrypted message.
  const bad = await api('PUT', `/live-locations/${id}`, alice.token, { e2ee: { v: 1, sd: 'nope' } });
  assert.ok([400, 409, 429].includes(bad.status));
});

test('location: deleting the message, or the account, erases the position', async (t) => {
  const { api, alice, conv, store } = await setup(t);
  const m1 = (await api('POST', `/conversations/${conv.id}/location`, alice.token, { live: 900, location: here })).body.message;
  const del = await api('DELETE', `/messages/${m1.id}`, alice.token);
  assert.ok([200, 204].includes(del.status), String(del.status));
  const stored = store.data.messages[conv.id].find((m) => m.id === m1.id);
  assert.strictEqual(stored.location, undefined);
  assert.strictEqual(stored.live, undefined);
  assert.strictEqual(store.liveDue().length, 0, 'nothing is left to expire');

  const m2 = (await api('POST', `/conversations/${conv.id}/location`, alice.token, { location: here })).body.message;
  store.requestAccountDeletion('alice');
  store.eraseAccount('alice');
  const gone = store.data.messages[conv.id].find((m) => m.id === m2.id);
  assert.strictEqual(gone.location, undefined, 'erased with the account');
});

test('location: the feature switch stops sharing and updates, but never stopping', async (t) => {
  const { api, alice, conv, store } = await setup(t);
  const id = (await api('POST', `/conversations/${conv.id}/location`, alice.token, { live: 900, location: here })).body.message.id;
  store.updateSettings({ features: { location: false } });
  assert.strictEqual((await api('POST', `/conversations/${conv.id}/location`, alice.token, { location: here })).status, 403);
  store.data.messages[conv.id].find((m) => m.id === id).live.updatedAt = 0;
  assert.strictEqual((await api('PUT', `/live-locations/${id}`, alice.token, { location: here })).status, 403);
  assert.strictEqual((await api('DELETE', `/live-locations/${id}`, alice.token)).status, 200, 'stopping always works');
});

test('location: sending over the socket works like the REST API', async (t) => {
  const { client, alice, bob, conv } = await setup(t);
  const sa = await client(alice.token);
  const sb = await client(bob.token);
  const got = once(sb, 'message:new');
  const ack = await new Promise((r) => sa.emit('location:send', { convId: conv.id, location: here }, r));
  assert.strictEqual(ack.ok, true, JSON.stringify(ack));
  assert.strictEqual((await got).message.type, 'location');
});
