'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const E2EE = require('../public/e2ee.js');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

/** A person's device: a key pair registered with the server over REST. */
async function newDevice(api, token, name) {
  const pair = await E2EE.generateDevice();
  const res = await api('POST', '/e2ee/devices', { token, body: { name, publicKey: pair.publicKey } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.device.id, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store, webhooks: { allowPrivate: true, retryDelaysMs: [] } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token, appSession = 'x') => {
    const s = connect(base, { auth: { token, appSession }, transports: ['websocket'], forceNew: true });
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

/** Encrypt as `me` for everyone in the chat, using the server's key directory. */
async function seal(api, token, device, conv, from, payload, media) {
  const keys = (await api('GET', `/conversations/${encodeURIComponent(conv)}/keys`, { token })).body.keys;
  const recipients = Object.values(keys).flat().map((d) => ({ id: d.id, publicKey: d.publicKey }));
  return E2EE.encrypt({ device, convId: conv, from, recipients, payload, media });
}

test('crypto: round trip, every device, and tampering is detected', async () => {
  const [a1, a2, b1] = await Promise.all([E2EE.generateDevice(), E2EE.generateDevice(), E2EE.generateDevice()]);
  const A1 = { id: 'a1', ...a1 };
  const A2 = { id: 'a2', ...a2 };
  const B1 = { id: 'b1', ...b1 };
  const recipients = [A1, A2, B1].map((d) => ({ id: d.id, publicKey: d.publicKey }));
  const audio = new Uint8Array([1, 2, 3, 4, 5, 250]);
  const { envelope, media } = await E2EE.encrypt({ device: A1, convId: 'dm:a:b', from: 'alice', recipients, payload: { t: 'hello 🌍' }, media: audio });
  assert.deepStrictEqual(Object.keys(envelope.w).sort(), ['a1', 'a2', 'b1']);
  assert.ok(!JSON.stringify(envelope).includes('hello'));
  assert.notDeepStrictEqual([...media], [...audio]);

  const senderDevices = [{ id: 'a1', publicKey: a1.publicKey }];
  for (const me of [A1, A2, B1]) {
    const out = await E2EE.decrypt({ device: me, convId: 'dm:a:b', from: 'alice', envelope, senderDevices, media });
    assert.deepStrictEqual([out.payload, [...out.media]], [{ t: 'hello 🌍' }, [...audio]], `device ${me.id} reads it`);
  }
  const base = { device: B1, convId: 'dm:a:b', from: 'alice', envelope, senderDevices };
  await assert.rejects(E2EE.decrypt({ ...base, convId: 'dm:a:carol' }), 'moved to another chat');
  await assert.rejects(E2EE.decrypt({ ...base, from: 'mallory' }), 'attributed to someone else');
  await assert.rejects(E2EE.decrypt({ ...base, senderDevices: [{ id: 'a1', publicKey: b1.publicKey }] }), 'wrong sender key (forged sender)');
  await assert.rejects(E2EE.decrypt({ ...base, device: { id: 'c1', privateKey: B1.privateKey } }), /not encrypted for this device/);
  await assert.rejects(E2EE.decrypt({ ...base, device: { id: 'b1', privateKey: A2.privateKey } }), 'someone else\'s private key');
  const flipped = { ...envelope, ct: envelope.ct.slice(0, -2) + (envelope.ct.endsWith('AA') ? 'BB' : 'AA') };
  await assert.rejects(E2EE.decrypt({ ...base, envelope: flipped }), 'modified ciphertext');
  // Two messages never share keys or nonces.
  const again = await E2EE.encrypt({ device: A1, convId: 'dm:a:b', from: 'alice', recipients, payload: { t: 'hello 🌍' } });
  assert.notStrictEqual(again.envelope.eph, envelope.eph);
  assert.notStrictEqual(again.envelope.ct, envelope.ct);

  const sn1 = await E2EE.safetyNumber({ username: 'alice', devices: [{ keyId: 'k1' }] }, { username: 'bob', devices: [{ keyId: 'k2' }, { keyId: 'k3' }] });
  const sn2 = await E2EE.safetyNumber({ username: 'bob', devices: [{ keyId: 'k3' }, { keyId: 'k2' }] }, { username: 'alice', devices: [{ keyId: 'k1' }] });
  assert.match(sn1, /^(\d{5} ){11}\d{5}$/);
  assert.strictEqual(sn1, sn2, 'same on both phones');
  assert.notStrictEqual(sn1, await E2EE.safetyNumber({ username: 'alice', devices: [{ keyId: 'k9' }] }, { username: 'bob', devices: [{ keyId: 'k2' }, { keyId: 'k3' }] }));
});

test('server: device directory, validation and limits', async (t) => {
  const { store, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');

  const bad = await api('POST', '/e2ee/devices', { token: alice.token, body: { publicKey: 'AAAA' } });
  assert.deepStrictEqual([bad.status, bad.body.error.code], [400, 'bad_request']);
  const dev = await newDevice(api, alice.token, 'Laptop');
  const again = await api('POST', '/e2ee/devices', { token: alice.token, body: { name: 'Same', publicKey: dev.publicKey } });
  assert.strictEqual(again.body.device.id, dev.id, 're-registering a key returns the same device');
  assert.strictEqual((await api('POST', '/e2ee/devices', { token: alice.token, body: { name: 'x', publicKey: E2EE.toB64u(new Uint8Array(65).fill(4)) } })).status, 400, 'not a point on the curve');
  for (let i = 0; i < 4; i++) await newDevice(api, alice.token, `d${i}`);
  const sixth = await api('POST', '/e2ee/devices', { token: alice.token, body: { publicKey: (await E2EE.generateDevice()).publicKey } });
  assert.deepStrictEqual([sixth.status, sixth.body.error.code], [409, 'limit_reached']);

  const keys = await api('GET', `/conversations/${encodeURIComponent(dm.id)}/keys`, { token: bob.token });
  assert.deepStrictEqual([keys.body.keys.alice.length, keys.body.keys.bob.length], [5, 0]);
  assert.strictEqual(keys.body.keys.alice[0].privateKey, undefined);
  store.register('eve', 'pass');
  const eve = store.login('eve', 'pass');
  assert.strictEqual((await api('GET', `/conversations/${encodeURIComponent(dm.id)}/keys`, { token: eve.token })).status, 404, 'members only');

  const removed = await api('DELETE', `/e2ee/devices/${dev.id}`, { token: alice.token });
  assert.strictEqual(removed.body.devices.length, 4);
  assert.strictEqual((await api('DELETE', `/e2ee/devices/${dev.id}`, { token: alice.token })).status, 404);
  assert.strictEqual((await api('DELETE', `/e2ee/devices/${removed.body.devices[0].id}`, { token: bob.token })).status, 404, "not someone else's");
});

test('end to end: the server stores and relays only ciphertext', async (t) => {
  const { store, client, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const carol = store.register('carol', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  const aPhone = await newDevice(api, alice.token, 'Phone');
  const aLaptop = await newDevice(api, alice.token, 'Laptop');
  const bPhone = await newDevice(api, bob.token, 'Phone');
  const sa = await client(alice.token);
  const sb = await client(bob.token);
  const secret = 'the launch code is 8-8-1-9';

  // Alice's phone sends; Bob gets only his own key wrap.
  const incoming = next(sb, 'message:new');
  const { envelope } = await seal(api, alice.token, aPhone, dm.id, 'alice', { t: secret });
  const sent = await call(sa, 'message:send', { convId: dm.id, e2ee: envelope, clientId: 'c1' });
  assert.ok(sent.ok, sent.error);
  assert.strictEqual(sent.message.text, '', 'no plaintext');
  const got = (await incoming).message;
  assert.deepStrictEqual(Object.keys(got.e2ee.w), [bPhone.id], 'recipient only receives its own wraps');
  assert.deepStrictEqual(Object.keys(sent.message.e2ee.w).sort(), [aLaptop.id, aPhone.id].concat(bPhone.id).filter((id) => id !== bPhone.id).sort(), "sender sees its own devices' wraps");

  // Nothing readable on the server: not in memory, not in a file dump, not in any API reply.
  assert.ok(!JSON.stringify(store.data).includes(secret));
  const history = await api('GET', `/conversations/${encodeURIComponent(dm.id)}/messages`, { token: bob.token });
  assert.ok(!JSON.stringify(history.body).includes(secret));
  const list = await call(sb, 'conversations');
  assert.ok(!JSON.stringify(list).includes(secret));
  assert.ok(list.conversations[0].lastMessage.e2ee, 'previews are ciphertext too');

  // Bob's device decrypts; so does Alice's other device.
  const keysForBob = (await call(sb, 'e2ee:keys', { convId: dm.id })).keys;
  const read = await E2EE.decrypt({ device: bPhone, convId: dm.id, from: 'alice', envelope: got.e2ee, senderDevices: keysForBob.alice });
  assert.strictEqual(read.payload.t, secret);
  const mine = history.body.messages[0];
  const read2 = await E2EE.decrypt({ device: aLaptop, convId: dm.id, from: 'alice', envelope: (await api('GET', `/conversations/${encodeURIComponent(dm.id)}/messages`, { token: alice.token })).body.messages[0].e2ee, senderDevices: keysForBob.alice });
  assert.strictEqual(read2.payload.t, secret);
  void mine;

  // Retrying with the same clientId doesn't duplicate.
  assert.strictEqual((await call(sa, 'message:send', { convId: dm.id, e2ee: envelope, clientId: 'c1' })).message.id, sent.message.id);

  // Validation: wrong sender device, missing/extra wraps, other chat, junk.
  const send = (env, c = dm.id) => call(sa, 'message:send', { convId: c, e2ee: env });
  assert.strictEqual((await send({ ...envelope, sd: bPhone.id })).code, 'keys_changed', "can't claim another person's device");
  assert.strictEqual((await send({ ...envelope, w: { [aPhone.id]: envelope.w[aPhone.id] } })).code, 'keys_changed', 'no leaving a member out');
  assert.strictEqual((await send({ ...envelope, w: { ...envelope.w, deadbeef: envelope.w[aPhone.id] } })).code, 'keys_changed', 'no wraps for unknown devices');
  assert.strictEqual((await send({ ...envelope, iv: 'AAAA' })).code, 'invalid_envelope');
  assert.strictEqual((await send({ ...envelope, v: 2 })).code, 'invalid_envelope');
  assert.strictEqual((await send('hello')).code, 'invalid_envelope');

  // A device registered meanwhile: the sender must re-fetch keys (409), then it works.
  const bLaptop = await newDevice(api, bob.token, 'Laptop');
  const stale = await send(envelope);
  assert.strictEqual(stale.code, 'keys_changed');
  const fresh = await seal(api, alice.token, aPhone, dm.id, 'alice', { t: 'second' });
  assert.ok((await send(fresh.envelope)).ok);
  // The new device cannot read earlier messages, only later ones.
  const bobHistory = (await api('GET', `/conversations/${encodeURIComponent(dm.id)}/messages`, { token: bob.token })).body.messages;
  assert.deepStrictEqual(Object.keys(bobHistory[0].e2ee.w), [bPhone.id]);
  assert.deepStrictEqual(Object.keys(bobHistory[1].e2ee.w).sort(), [bLaptop.id, bPhone.id].sort());
  await assert.rejects(E2EE.decrypt({ device: bLaptop, convId: dm.id, from: 'alice', envelope: bobHistory[0].e2ee, senderDevices: keysForBob.alice }), /not encrypted for this device/);

  // Plaintext still works (REST bots, auto replies) and is simply not marked encrypted.
  const plain = await api('POST', `/conversations/${encodeURIComponent(dm.id)}/messages`, { token: alice.token, body: { text: 'from a bot' } });
  assert.deepStrictEqual([plain.body.message.text, plain.body.message.e2ee], ['from a bot', undefined]);

  // A third person can't read or inject.
  assert.strictEqual((await call(await client(carol.token), 'message:send', { convId: dm.id, e2ee: envelope })).ok, false);

  // Deleting removes the ciphertext.
  await call(sa, 'message:delete', { id: sent.message.id });
  assert.strictEqual(store.findMessage(sent.message.id).message.e2ee, undefined);
});

test('end to end: groups and voice messages; key changes are announced', async (t) => {
  const { store, client, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const carol = store.register('carol', 'pass');
  const group = store.createGroup('alice', 'Team', ['bob', 'carol']);
  const a = await newDevice(api, alice.token, 'A');
  const b = await newDevice(api, bob.token, 'B');
  const c = await newDevice(api, carol.token, 'C');
  const sa = await client(alice.token);
  const sc = await client(carol.token);

  // Group text: one envelope, a wrap for each of the three devices.
  const text = await seal(api, alice.token, a, group.id, 'alice', { t: 'group secret' });
  assert.deepStrictEqual(Object.keys(text.envelope.w).sort(), [a.id, b.id, c.id].sort());
  const gotText = next(sc, 'message:new');
  assert.ok((await call(sa, 'message:send', { convId: group.id, e2ee: text.envelope })).ok);
  const keys = (await call(sc, 'e2ee:keys', { convId: group.id })).keys;
  assert.strictEqual((await E2EE.decrypt({ device: c, convId: group.id, from: 'alice', envelope: (await gotText).message.e2ee, senderDevices: keys.alice })).payload.t, 'group secret');

  // Voice: audio is encrypted before upload; the server keeps ciphertext and still checks the type.
  const audio = new Uint8Array(2000).map((_, i) => i % 251);
  const voice = await seal(api, alice.token, a, group.id, 'alice', { kind: 'voice' }, audio);
  assert.notDeepStrictEqual([...voice.media.subarray(0, 50)], [...audio.subarray(0, 50)]);
  const noMedia = await call(sa, 'voice:send', { convId: group.id, duration: 3, mime: 'audio/webm', data: Buffer.from(voice.media), e2ee: { ...voice.envelope, mi: undefined } });
  assert.match(noMedia.error, /Invalid encrypted message/);
  const gotVoice = next(sc, 'message:new');
  const sentVoice = await call(sa, 'voice:send', { convId: group.id, duration: 3, mime: 'audio/webm;codecs=opus', data: Buffer.from(voice.media), e2ee: voice.envelope });
  assert.ok(sentVoice.ok, sentVoice.error);
  const vm = (await gotVoice).message;
  const stored = store.getMedia(vm.voice.mediaId, 'carol');
  assert.ok(Buffer.compare(stored.buffer, Buffer.from(audio)) !== 0, 'server holds ciphertext');
  const back = await E2EE.decrypt({ device: c, convId: group.id, from: 'alice', envelope: vm.e2ee, senderDevices: keys.alice, media: new Uint8Array(stored.buffer) });
  assert.deepStrictEqual([...back.media], [...audio]);

  // Peers hear about key changes so they refresh their cache.
  const changed = next(sa, 'e2ee:update');
  await newDevice(api, bob.token, 'B2');
  assert.deepStrictEqual(await changed, { username: 'bob' });
});

test('end to end: replying to a status can be encrypted too', async (t) => {
  const { store, client, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const a = await newDevice(api, alice.token, 'A');
  const b = await newDevice(api, bob.token, 'B');
  const dm = store.getOrCreateDirect('alice', 'bob');
  const sa = await client(alice.token);
  const sb = await client(bob.token);
  const { status } = await call(sb, 'status:post', { type: 'text', text: 'my day', bg: '#0670DE' });
  const sealed = await seal(api, alice.token, a, dm.id, 'alice', { t: 'nice!' });
  const reply = await call(sa, 'status:reply', { id: status.id, e2ee: sealed.envelope });
  assert.ok(reply.ok, reply.error);
  assert.strictEqual(reply.message.text, '');
  assert.ok(reply.message.statusReply && reply.message.e2ee);
  void b;
});
