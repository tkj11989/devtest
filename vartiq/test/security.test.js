'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const { spawnSync } = require('child_process');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const { createOtpService } = require('../server/otp');
const { createWebhookDispatcher } = require('../server/webhooks');
const totp = require('../server/totp');
const legal = require('../server/legal');

const CONSENT = { terms: true, version: legal.VERSION };

async function setup(t, opts = {}) {
  const store = opts.store || new Store({ file: null });
  const outbox = [];
  const app = createApp({
    store,
    admin: { username: 'root', password: 'correct-horse-battery' },
    otp: { sender: async (m) => { outbox.push(m); }, resendMs: 0, maxPerHour: 1000, ...(opts.otp || {}) },
    rateLimit: { max: 100000, authMax: 100000 },
    ...(opts.app || {}),
  });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const raw = (method, path, { token, body, headers } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const api = async (method, path, token, body, headers) => {
    const res = await raw(method, `/api/v1${path}`, { token, body, headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const otp = async (purpose, phone, extra = {}) => {
    const r = await api('POST', '/auth/otp', null, { purpose, phone, clientType: 'app', ...extra });
    return { res: r, code: outbox.at(-1)?.code };
  };
  const signUp = async (name, phone) => {
    const sent = await otp('register', phone);
    return api('POST', '/auth/register', null, { displayName: name, phone, phoneOtp: { requestId: sent.res.body.requestId, code: sent.code }, consent: CONSENT, birthDate: '1990-01-01' });
  };
  const login = async (phone, extra = {}) => {
    const sent = await otp('login', phone);
    return api('POST', '/auth/login', null, { phone, requestId: sent.res.body.requestId, code: sent.code, clientType: 'app', ...extra });
  };
  const client = async (token) => {
    const s = connect(base, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  return { store, app, api, raw, otp, signUp, login, client, outbox, base };
}

test('headers: the app gets a strict CSP, nosniff, HSTS over https; the guardian page allows only its own script', async (t) => {
  const env = await setup(t, { app: { trustProxy: 'loopback' } });
  const home = await env.raw('GET', '/', { headers: { 'X-Forwarded-Proto': 'https' } });
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.strictEqual(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(home.headers.get('strict-transport-security'), /max-age=31536000/);
  const plain = await env.raw('GET', '/');
  assert.strictEqual(plain.headers.get('strict-transport-security'), null, 'no HSTS over plain http');

  const page = await env.raw('GET', '/guardian/sometoken');
  const gcsp = page.headers.get('content-security-policy');
  const html = await page.text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(gcsp.includes(`'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`), 'the one inline script is allowed by hash');
  assert.doesNotMatch(gcsp, /script-src[^;]*unsafe-inline/);
});

test('production guard: a server with testing switches on refuses to start', () => {
  const r = spawnSync(process.execPath, ['server/index.js'], { cwd: require('path').join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', PREMIUM_FOR_ALL: '1', OTP_DEV_CODES: '1', PORT: '0' }, encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Refusing to start in production.*OTP_DEV_CODES.*PREMIUM_FOR_ALL/);
});

test('login PIN: asked at every login, the code survives a missing PIN, wrong PINs lock, support can reset', async (t) => {
  const env = await setup(t);
  const reg = await env.signUp('Asha', '+919800000010');
  const name = reg.body.user.username;
  assert.strictEqual((await env.api('PUT', '/me/login-pin', reg.body.token, { pin: '12ab' })).status, 400);
  assert.strictEqual((await env.api('PUT', '/me/login-pin', reg.body.token, { pin: '482913' })).body.hasPin, true);
  assert.strictEqual((await env.api('PUT', '/me/login-pin', reg.body.token, { pin: null })).body.error.code, 'pin_required', 'removing needs the current PIN');

  const sent = await env.otp('login', '+919800000010');
  const body = { phone: '+919800000010', requestId: sent.res.body.requestId, code: sent.code, clientType: 'app' };
  const none = await env.api('POST', '/auth/login', null, body);
  assert.deepStrictEqual([none.status, none.body.error.code], [401, 'pin_required']);
  const wrong = await env.api('POST', '/auth/login', null, { ...body, pin: '000000' });
  assert.strictEqual(wrong.body.error.code, 'wrong_pin');
  const ok = await env.api('POST', '/auth/login', null, { ...body, pin: '482913' });
  assert.strictEqual(ok.status, 200, 'the same code still works once the PIN is right');

  for (let i = 0; i < 5; i++) await env.login('+919800000010', { pin: '111111' });
  const locked = await env.login('+919800000010', { pin: '482913' });
  assert.strictEqual(locked.status, 429, 'even the right PIN waits after five wrong ones');
  assert.ok(env.store.data.users[name].loginPin.until > Date.now(), 'the lock is kept with the account');

  // Support removes a forgotten PIN.
  const adm = (await (await env.raw('POST', '/admin/api/login', { body: { username: 'root', password: 'correct-horse-battery' } })).json()).token;
  const reset = await env.raw('POST', `/admin/api/users/${name}/reset-pin`, { token: adm, body: {} });
  assert.strictEqual((await reset.json()).reset, true);
  assert.strictEqual((await env.login('+919800000010')).status, 200);
});

test('sessions: unused sessions expire after 30 days, use keeps them alive, "log out everywhere" cuts the others', async (t) => {
  const env = await setup(t);
  const reg = await env.signUp('Asha', '+919800000011');
  const key = Object.keys(env.store.data.sessions)[0];
  env.store.data.sessions[key].seen = Date.now() - 29 * 24 * 3600 * 1000;
  assert.strictEqual((await env.api('GET', '/me', reg.body.token)).status, 200);
  assert.ok(Date.now() - env.store.data.sessions[key].seen < 5000, 'use refreshes it');
  env.store.data.sessions[key].seen = Date.now() - 31 * 24 * 3600 * 1000;
  assert.strictEqual((await env.api('GET', '/me', reg.body.token)).status, 401);

  const a = await env.login('+919800000011', { deviceName: 'Pixel 8' });
  const b = await env.login('+919800000011', { deviceName: 'Old phone' });
  const sock = await env.client(b.body.token);
  const closed = new Promise((r) => sock.once('disconnect', r));
  const list = await env.api('GET', '/me/sessions', a.body.token);
  assert.deepStrictEqual(list.body.sessions.map((s) => s.name).sort(), ['Old phone', 'Pixel 8']);
  assert.strictEqual(list.body.sessions.find((s) => s.current).name, 'Pixel 8');
  assert.strictEqual((await env.api('DELETE', '/me/sessions', a.body.token)).body.ended, 1);
  await closed;
  assert.strictEqual((await env.api('GET', '/me', b.body.token)).status, 401);
  assert.strictEqual((await env.api('GET', '/me', a.body.token)).status, 200);
});

test('new login: the other open devices are told', async (t) => {
  const env = await setup(t);
  const reg = await env.signUp('Asha', '+919800000012');
  const sock = await env.client(reg.body.token);
  const told = new Promise((r) => sock.once('security:login', r));
  await env.login('+919800000012', { deviceName: 'Chrome on Windows' });
  const info = await told;
  assert.strictEqual(info.name, 'Chrome on Windows');
});

test('browsers: anything but clientType "app" counts as a browser', async (t) => {
  const env = await setup(t);
  await env.signUp('Asha', '+919800000013');
  const asWeb = await env.api('POST', '/auth/otp', null, { purpose: 'login', phone: '+919800000013' });
  assert.strictEqual(asWeb.body.error.code, 'passcode_required');
});

test('sign-up and login do not reveal which numbers have accounts', async (t) => {
  const env = await setup(t);
  await env.signUp('Asha', '+919800000014');
  const before = env.outbox.length;
  const known = await env.api('POST', '/auth/otp', null, { purpose: 'register', phone: '+919800000014' });
  const unknown = await env.api('POST', '/auth/otp', null, { purpose: 'login', phone: '+919800000099', clientType: 'app' });
  assert.deepStrictEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
  assert.strictEqual(env.outbox.length, before, 'no SMS for either');
  // The fake request id never works, and says nothing about accounts.
  const r = await env.api('POST', '/auth/register', null, { displayName: 'X', phone: '+919800000014', phoneOtp: { requestId: known.body.requestId, code: '123456' }, consent: CONSENT, birthDate: '1990-01-01' });
  assert.strictEqual(r.body.error.code, 'otp_expired');
});

test('SMS budget: a daily limit and an allow-list of country prefixes', async () => {
  const sent = [];
  const svc = createOtpService({ sender: async (m) => sent.push(m), resendMs: 0, dailySmsLimit: 2, allowedPrefixes: ['+91'] });
  try {
    await assert.rejects(svc.request({ channel: 'sms', to: '+14155550100', purpose: 'login' }), { code: 'country_not_supported' });
    await svc.request({ channel: 'sms', to: '+919800000001', purpose: 'login' });
    await svc.request({ channel: 'sms', to: '+919800000002', purpose: 'login' });
    await assert.rejects(svc.request({ channel: 'sms', to: '+919800000003', purpose: 'login' }), { code: 'sms_budget' });
    await svc.request({ channel: 'email', to: 'a@example.com', purpose: 'login' }); // email is not an SMS cost
    assert.strictEqual(sent.length, 3);
    // Decoys use the same limits but cost nothing and send nothing.
    await assert.rejects(svc.request({ channel: 'sms', to: '+919800000004', purpose: 'login', decoy: true }), { code: 'sms_budget' });
  } finally {
    svc.stop();
  }
});

test('webhooks: the address is checked when connecting, so DNS rebinding cannot reach internal services', async (t) => {
  const hits = [];
  const internal = http.createServer((req, res) => { hits.push(req.url); res.end('x'); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  t.after(() => internal.close());
  const store = new Store({ file: null });
  store.register('alice', 'pass');
  const settings = store.getSettings();
  settings.features.developerApi = true;
  const hook = store.createWebhook ? null : null; // eslint-disable-line no-unused-vars
  const realLookup = dns.lookup;
  const realPromise = dns.promises.lookup;
  // The pre-check sees a public address; the real connection resolves to loopback.
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  dns.lookup = (host, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, ...(opts?.all ? [[{ address: '127.0.0.1', family: 4 }]] : ['127.0.0.1', 4]));
  t.after(() => { dns.lookup = realLookup; dns.promises.lookup = realPromise; });
  const d = createWebhookDispatcher({ store, retryDelaysMs: [], timeoutMs: 2000, log: { warn() {} } });
  const res = await d.ping({ id: 'wh_1', owner: 'alice', url: `http://rebind.example:${internal.address().port}/hook`, secret: 's' });
  d.stop();
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /private address/);
  assert.deepStrictEqual(hits, [], 'nothing reached the internal server');
});

test('TOTP: matches the RFC 6238 test vector and refuses codes outside the window', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.strictEqual(totp.codeAt(secret, Math.floor(59 / 30)), '287082');
  assert.strictEqual(totp.codeAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.strictEqual(totp.verify(secret, '287082', 59 * 1000), 1);
  assert.strictEqual(totp.verify(secret, '287082', 200 * 1000), null);
  assert.strictEqual(totp.verify(secret, 'abcdef', 59 * 1000), null);
});

test('admin two-step sign-in: needs the code, a code works once, required mode limits the session, support can reset it', async (t) => {
  const env = await setup(t, { app: { admin: { username: 'root', password: 'correct-horse-battery', router: { require2fa: true } } } });
  const post = async (path, token, body) => { const r = await env.raw('POST', `/admin/api${path}`, { token, body: body || {} }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const first = await post('/login', null, { username: 'root', password: 'correct-horse-battery' });
  assert.strictEqual(first.body.limited, true, 'required but not set up: limited session');
  assert.strictEqual((await env.raw('GET', '/admin/api/users', { token: first.body.token })).status, 403);
  const setupRes = await post('/totp/setup', first.body.token);
  const bad = await post('/totp/enable', first.body.token, { code: '000000' });
  assert.strictEqual(bad.status, 400);
  const code = totp.codeAt(setupRes.body.secret, Math.floor(Date.now() / 1000 / 30));
  assert.strictEqual((await post('/totp/enable', first.body.token, { code })).status, 200);
  assert.strictEqual((await env.raw('GET', '/admin/api/users', { token: first.body.token })).status, 200, 'set up: the session is free');

  const noCode = await post('/login', null, { username: 'root', password: 'correct-horse-battery' });
  assert.deepStrictEqual([noCode.status, noCode.body.error.code], [401, 'totp_required']);
  assert.strictEqual((await post('/login', null, { username: 'root', password: 'correct-horse-battery', code })).status, 401, 'the code just used does not work again');
  const next = totp.codeAt(setupRes.body.secret, Math.floor(Date.now() / 1000 / 30) + 1);
  assert.strictEqual((await post('/login', null, { username: 'root', password: 'correct-horse-battery', code: next })).status, 200);

  // A second super admin can clear it; sessions of the cleared admin end.
  env.store.upsertAdmin('boss', 'another-long-password', 'super');
  const boss = await post('/login', null, { username: 'boss', password: 'another-long-password' });
  assert.strictEqual(boss.body.limited, true);
  assert.strictEqual((await post('/sessions/end', first.body.token, { all: true })).status, 200);
  assert.strictEqual((await env.raw('GET', '/admin/api/me', { token: boss.body.token })).status, 401, 'all administrators were signed out');
});

test('chat lock: wrong-code attempts are kept with the account (a restart does not reset them)', async (t) => {
  const env = await setup(t);
  const reg = await env.signUp('Asha', '+919800000015');
  const name = reg.body.user.username;
  assert.strictEqual((await env.api('PUT', '/chat-lock/code', reg.body.token, { code: '123456' })).status, 200);
  for (let i = 0; i < 5; i++) await env.api('PUT', '/chat-lock/code', reg.body.token, { code: '654321', currentCode: 'wrong' });
  const kept = env.store.data.users[name].lockGuard;
  assert.strictEqual(kept.fails, 5);
  assert.ok(kept.until > Date.now(), 'the wait is stored on the account itself');
  assert.strictEqual((await env.api('PUT', '/chat-lock/code', reg.body.token, { code: '654321', currentCode: '123456' })).status, 429, 'even the right code waits');
});

test('old password login: ten wrong passwords lock the account for a while', async (t) => {
  const env = await setup(t);
  env.store.register('olduser', 'right-password');
  for (let i = 0; i < 10; i++) assert.strictEqual((await env.api('POST', '/auth/login', null, { username: 'olduser', password: 'wrong' })).status, 401);
  const r = await env.api('POST', '/auth/login', null, { username: 'olduser', password: 'right-password' });
  assert.strictEqual(r.status, 429);
});
