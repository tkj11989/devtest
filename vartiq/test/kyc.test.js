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
  const app = createApp({ store, otp: { sender: async () => {}, resendMs: 0, exposeCodes: true }, ...opts });
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

const PAN = 'ABCDE1234F';

test('kyc: unavailable unless a gateway or the sandbox is configured', async (t) => {
  const { store, api } = await setup(t);
  const a = store.register('alice', 'pass');
  assert.deepStrictEqual((await api('GET', '/me/verification', { token: a.token })).body.available, false);
  const r = await api('POST', '/me/verification/otp', { token: a.token, body: { type: 'pan', idNumber: PAN } });
  assert.deepStrictEqual([r.status, r.body.error.code], [503, 'kyc_unavailable']);
  assert.strictEqual(store.isVerified('alice'), false);
});

test('kyc gateway: ID goes to the gateway and is never stored or logged; badge on success', async (t) => {
  const calls = [];
  const gateway = async (body) => {
    calls.push(body);
    if (body.action === 'start') return { requestId: 'gw-123' };
    return { verified: body.otp === '246810' };
  };
  const logged = [];
  const origLog = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = (...a) => logged.push(a.join(' '));
  t.after(() => { [console.log, console.error, console.warn] = origLog; });

  const { store, client, api } = await setup(t, { kyc: { gateway } });
  const a = store.register('alice', 'pass');
  const b = store.register('bob', 'pass');
  store.getOrCreateDirect('alice', 'bob');
  const sa = await client(a.token);
  const sb = await client(b.token);

  const status = (await api('GET', '/me/verification', { token: a.token })).body;
  assert.deepStrictEqual([status.available, status.sandbox, status.types.map((x) => x.id)], [true, false, ['aadhaar', 'pan', 'passport', 'driving_licence', 'voter_id']]);

  // Bad formats never reach the gateway.
  for (const bad of [{ type: 'pan', idNumber: '123' }, { type: 'aadhaar', idNumber: 'ABCDEFGHIJKL' }, { type: 'nope', idNumber: PAN }, { type: 'gstin', idNumber: PAN }]) {
    assert.strictEqual((await api('POST', '/me/verification/otp', { token: a.token, body: bad })).status, 400);
  }
  assert.strictEqual(calls.length, 0);

  const started = await api('POST', '/me/verification/otp', { token: a.token, body: { type: 'pan', idNumber: ' abcde-1234f ' } });
  assert.strictEqual(started.status, 200);
  assert.deepStrictEqual(calls[0], { action: 'start', type: 'pan', idNumber: PAN }, 'normalised ID sent to the gateway');
  assert.strictEqual(started.body.requestId, 'gw-123');
  assert.ok(!JSON.stringify(started.body).includes(PAN));

  // Someone else can't finish it; a wrong code doesn't verify; the right one does.
  assert.strictEqual((await api('POST', '/me/verification', { token: b.token, body: { requestId: 'gw-123', otp: '246810' } })).body.error.code, 'otp_expired');
  const wrong = await api('POST', '/me/verification', { token: a.token, body: { requestId: 'gw-123', otp: '111111' } });
  assert.deepStrictEqual([wrong.status, wrong.body.error.code], [400, 'otp_invalid']);
  assert.strictEqual(store.isVerified('alice'), false);

  const seen = next(sb, 'user:updated');
  const done = await api('POST', '/me/verification', { token: a.token, body: { requestId: 'gw-123', otp: '246810' } });
  assert.deepStrictEqual([done.status, done.body.verified, done.body.user.verified], [200, true, true]);
  assert.strictEqual((await seen).user.verified, true, 'peers see the badge live');
  assert.strictEqual((await api('GET', '/users/alice', { token: b.token })).body.user.verified, true);
  assert.strictEqual((await api('GET', '/users/bob', { token: a.token })).body.user.verified, undefined, 'others stay unverified');
  assert.strictEqual((await api('GET', '/users?q=alice', { token: b.token })).body.users[0].verified, true);

  // Nothing about the ID anywhere: database, API replies, logs.
  assert.ok(!JSON.stringify(store.data).includes(PAN));
  assert.ok(!JSON.stringify(store.data).includes('gw-123'));
  assert.ok(!logged.join('\n').includes(PAN));
  assert.deepStrictEqual(Object.keys(store.data.users.alice).filter((k) => /kyc|id|pan|aadhaar/i.test(k)), [], 'no KYC fields on the account');
  assert.strictEqual(typeof store.data.users.alice.verifiedAt, 'number');

  // A used code can't be replayed, and a verified account can't start again.
  assert.strictEqual((await api('POST', '/me/verification', { token: a.token, body: { requestId: 'gw-123', otp: '246810' } })).status, 400);
  assert.strictEqual((await api('POST', '/me/verification/otp', { token: a.token, body: { type: 'pan', idNumber: PAN } })).body.error.code, 'already_verified');

  // Changing the display name removes the badge until verified again.
  const changed = next(sb, 'user:updated');
  await call(sa, 'profile:update', { displayName: 'Alice Renamed' });
  assert.strictEqual((await changed).user.verified, undefined);
  assert.strictEqual(store.isVerified('alice'), false);
  await call(sa, 'profile:update', { about: 'just the about text' });
});

test('kyc: wrong-code limit, attempt limit, gateway errors, business ID types', async (t) => {
  let fail = false;
  const gateway = async (body) => {
    if (fail) throw new Error('boom');
    return body.action === 'start' ? { requestId: `r${Math.random()}` } : { verified: false };
  };
  const { store, client, api } = await setup(t, { kyc: { gateway, maxAttempts: 3, startsPerHour: 2 } });
  const a = store.register('alice', 'pass');
  const start = (token, body) => api('POST', '/me/verification/otp', { token, body });

  const s1 = (await start(a.token, { type: 'aadhaar', idNumber: '1234 5678 9012' })).body;
  const verify = (requestId, otp = '000000') => api('POST', '/me/verification', { token: a.token, body: { requestId, otp } });
  assert.match((await verify(s1.requestId)).body.error.message, /2 tries left/);
  await verify(s1.requestId);
  assert.match((await verify(s1.requestId)).body.error.message, /Too many wrong tries/);
  assert.strictEqual((await verify(s1.requestId)).body.error.code, 'otp_expired');

  assert.strictEqual((await start(a.token, { type: 'aadhaar', idNumber: '123456789012' })).status, 200);
  assert.strictEqual((await start(a.token, { type: 'aadhaar', idNumber: '123456789012' })).body.error.code, 'kyc_rate_limited');

  fail = true;
  const b = store.register('bob', 'pass');
  const down = await start(b.token, { type: 'pan', idNumber: PAN });
  assert.deepStrictEqual([down.status, down.body.error.code], [502, 'kyc_gateway_failed']);
  assert.ok(!JSON.stringify(down.body).includes(PAN));

  // Business accounts verify with business IDs.
  fail = false;
  store.setContact('bob', 'sms', '+919800000099');
  store.setContact('bob', 'email', 'b@shop.example');
  store.setBusiness('bob', { category: 'Retail' });
  const types = (await api('GET', '/me/verification', { token: b.token })).body.types.map((x) => x.id);
  assert.deepStrictEqual(types, ['gstin', 'cin', 'pan']);
  assert.strictEqual((await start(b.token, { type: 'aadhaar', idNumber: '123456789012' })).status, 400);
  assert.strictEqual((await start(b.token, { type: 'gstin', idNumber: '27ABCDE1234F1Z5' })).status, 200);
  void client;
});

test('kyc sandbox: code goes to the account mobile number; any well-formed ID works', async (t) => {
  const { store, api } = await setup(t, { kyc: { sandbox: true } });
  const a = store.register('alice', 'pass');
  assert.strictEqual((await api('POST', '/me/verification/otp', { token: a.token, body: { type: 'pan', idNumber: PAN } })).body.error.code, 'verification_required');
  store.setContact('alice', 'sms', '+919800000001');
  const status = (await api('GET', '/me/verification', { token: a.token })).body;
  assert.deepStrictEqual([status.available, status.sandbox], [true, true]);
  const s = await api('POST', '/me/verification/otp', { token: a.token, body: { type: 'pan', idNumber: PAN } });
  assert.match(s.body.devCode, /^\d{6}$/);
  assert.strictEqual((await api('POST', '/me/verification', { token: a.token, body: { requestId: s.body.requestId, otp: s.body.devCode } })).body.verified, true);
  assert.ok(!JSON.stringify(store.data).includes(PAN));
});
