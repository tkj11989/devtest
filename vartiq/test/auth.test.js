'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const { createOtpService, normalisePhone, normaliseEmail } = require('../server/otp');

async function setup(t) {
  const store = new Store({ file: null });
  const outbox = []; // codes "sent" by SMS/email
  const app = createApp({
    store,
    otp: { sender: async (msg) => { outbox.push(msg); }, resendMs: 0 },
  });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}/api/v1`;
  t.after(() => { app.io.close(); app.server.close(); });
  const api = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  /** Ask for a code and read it from the outbox, like a phone would. */
  const codeFor = async (body, path = '/auth/otp', token) => {
    const res = await api('POST', path, body, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.devCode, undefined, 'codes are not returned unless OTP_DEV_CODES=1');
    return { requestId: res.body.requestId, code: outbox[outbox.length - 1].code, sent: res.body };
  };
  return { store, api, codeFor, outbox };
}

test('otp: phone/email formats, wrong tries, single use, resend limits', async () => {
  assert.strictEqual(normalisePhone('+91 98765-43210'), '+919876543210');
  assert.strictEqual(normalisePhone('0044 (20) 7946 0958'), '+442079460958');
  assert.throws(() => normalisePhone('98765 43210'), /country code/);
  assert.throws(() => normalisePhone('+12'), /valid mobile/);
  assert.strictEqual(normaliseEmail(' Hello@Pizza.Example '), 'hello@pizza.example');
  assert.throws(() => normaliseEmail('nope'), /valid email/);

  const sent = [];
  const otp = createOtpService({ sender: async (m) => sent.push(m), resendMs: 1000, maxPerHour: 3, exposeCodes: true });
  const to = '+919876543210';
  const r = await otp.request({ channel: 'sms', to, purpose: 'login' });
  assert.match(r.devCode, /^\d{6}$/);
  assert.strictEqual(sent[0].code, r.devCode);
  assert.match(sent[0].text, new RegExp(`^${r.devCode} is your VartiQ verification code`));
  assert.strictEqual(r.sentTo, '+91•••••••210');
  const wrong = r.devCode === '000000' ? '111111' : '000000';

  // Codes are tied to the address and purpose they were sent for.
  assert.throws(() => otp.verify({ requestId: r.requestId, code: r.devCode, channel: 'sms', to: '+919876543211', purpose: 'login' }), { code: 'otp_expired' });
  assert.throws(() => otp.verify({ requestId: r.requestId, code: r.devCode, channel: 'sms', to, purpose: 'register' }), { code: 'otp_expired' });
  assert.throws(() => otp.verify({ requestId: r.requestId, code: wrong, channel: 'sms', to, purpose: 'login' }), /4 tries left/);
  assert.deepStrictEqual(otp.verify({ requestId: r.requestId, code: r.devCode, channel: 'sms', to, purpose: 'login' }), { channel: 'sms', to });
  assert.throws(() => otp.verify({ requestId: r.requestId, code: r.devCode, channel: 'sms', to, purpose: 'login' }), { code: 'otp_expired' }, 'single use');

  // 30-second style cooldown, then an hourly cap.
  await assert.rejects(otp.request({ channel: 'sms', to, purpose: 'login' }), { code: 'otp_too_soon', status: 429 });
  await otp.request({ channel: 'sms', to, purpose: 'register' }); // the wait is per purpose
  const opts = { channel: 'email', to: 'a@b.co', purpose: 'register' };
  const fast = createOtpService({ sender: async () => {}, resendMs: 0, maxPerHour: 2, maxAttempts: 2, exposeCodes: true });
  const first = await fast.request(opts);
  const second = await fast.request(opts);
  await assert.rejects(fast.request(opts), { code: 'otp_limit' });
  // A newer code replaces the older one.
  assert.throws(() => fast.verify({ ...opts, requestId: first.requestId, code: first.devCode }), { code: 'otp_expired' });
  // Too many wrong tries kill the code.
  const bad = second.devCode === '000000' ? '111111' : '000000';
  assert.throws(() => fast.verify({ ...opts, requestId: second.requestId, code: bad }), /1 try left/);
  assert.throws(() => fast.verify({ ...opts, requestId: second.requestId, code: bad }), /Too many wrong tries/);
  assert.throws(() => fast.verify({ ...opts, requestId: second.requestId, code: second.devCode }), { code: 'otp_expired' });

  // Expired codes don't work.
  const quick = createOtpService({ sender: async () => {}, ttlMs: 20, exposeCodes: true });
  const q = await quick.request({ channel: 'sms', to, purpose: 'login' });
  await new Promise((res) => setTimeout(res, 40));
  assert.throws(() => quick.verify({ requestId: q.requestId, code: q.devCode, channel: 'sms', to, purpose: 'login' }), { code: 'otp_expired' });

  // A gateway failure is reported, and doesn't count as a send.
  const down = createOtpService({ sender: async () => { throw new Error('boom'); } });
  await assert.rejects(down.request({ channel: 'sms', to, purpose: 'login' }), { code: 'otp_delivery_failed', status: 502 });
  [otp, fast, quick, down].forEach((o) => o.stop());
});

test('api: individual signs up and logs in with mobile number + OTP', async (t) => {
  const { api, codeFor, outbox, store } = await setup(t);

  const bad = await api('POST', '/auth/otp', { purpose: 'register', phone: '98765' });
  assert.deepStrictEqual([bad.status, bad.body.error.code], [400, 'invalid_phone']);
  const notYet = await api('POST', '/auth/otp', { purpose: 'login', phone: '+919876543210' });
  assert.deepStrictEqual([notYet.status, notYet.body.error.code], [404, 'not_registered']);

  const phone = '+91 98765 43210';
  const { requestId, code, sent } = await codeFor({ purpose: 'register', phone });
  assert.deepStrictEqual([sent.channel, sent.sentTo, sent.expiresIn], ['sms', '+91•••••••210', 300]);
  assert.strictEqual(outbox[0].to, '+919876543210');

  const wrong = await api('POST', '/auth/register', { displayName: 'Anita Rao', phone, phoneOtp: { requestId, code: code === '000000' ? '111111' : '000000' } });
  assert.deepStrictEqual([wrong.status, wrong.body.error.code], [400, 'otp_invalid']);
  const noName = await api('POST', '/auth/register', { phone, phoneOtp: { requestId, code } });
  assert.strictEqual(noName.status, 400);

  const reg = await api('POST', '/auth/register', { displayName: 'Anita Rao', phone, phoneOtp: { requestId, code } });
  assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
  assert.strictEqual(reg.body.user.username, 'anitarao');
  assert.strictEqual(reg.body.user.phone, undefined, 'numbers are private');
  const me = await api('GET', '/me', null, reg.body.token);
  assert.deepStrictEqual(me.body.contact, { phone: '+919876543210', email: null });
  assert.strictEqual(me.body.business, null);

  // The code was used up; the number is taken now.
  const again = await api('POST', '/auth/register', { displayName: 'Copy', phone, phoneOtp: { requestId, code } });
  assert.strictEqual(again.status, 409);
  assert.strictEqual((await api('POST', '/auth/otp', { purpose: 'register', phone })).body.error.code, 'phone_taken');

  // Same name again gets a different username.
  const other = await codeFor({ purpose: 'register', phone: '+14155550100' });
  const twin = await api('POST', '/auth/register', { displayName: 'Anita Rao', phone: '+14155550100', phoneOtp: other });
  assert.match(twin.body.user.username, /^anitarao\d+$/);

  // Log in with a code by SMS. Wrong code, then right code.
  const login = await codeFor({ purpose: 'login', phone: '+919876543210' });
  const nope = await api('POST', '/auth/login', { phone, requestId: login.requestId, code: login.code === '123456' ? '654321' : '123456' });
  assert.deepStrictEqual([nope.status, nope.body.error.code], [400, 'otp_invalid']);
  const ok = await api('POST', '/auth/login', { phone, requestId: login.requestId, code: login.code });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.user.username, 'anitarao');
  // A register code can't be used to log in.
  const reg2 = await codeFor({ purpose: 'register', phone: '+14155550111' });
  assert.strictEqual((await api('POST', '/auth/login', { phone: '+14155550111', ...reg2 })).body.error.code, 'otp_expired');
  // No password login for OTP accounts.
  assert.strictEqual((await api('POST', '/auth/login', { username: 'anitarao', password: '' })).status, 401);

  // Friends find you by your full number.
  assert.deepStrictEqual(store.searchUsers('+91 98765 43210', 'x').map((u) => u.username), ['anitarao']);
  assert.deepStrictEqual(store.searchUsers('9876543210', 'x'), [], 'without the country code it is not a full number');
});

test('api: business sign-up needs both mobile and email verified', async (t) => {
  const { api, codeFor } = await setup(t);
  const phone = '+919811122233';
  const email = 'Hello@Pizza.Example';

  const sms = await codeFor({ purpose: 'register', phone });
  const base = { accountType: 'business', displayName: 'Pizza Palace', phone, phoneOtp: sms, business: { category: 'Restaurant', timezone: 'Asia/Kolkata' } };
  const noEmail = await api('POST', '/auth/register', base);
  assert.deepStrictEqual([noEmail.status, noEmail.body.error.message], [400, 'Email is required for a business account']);

  const mail = await codeFor({ purpose: 'register', email });
  assert.strictEqual(mail.sent.channel, 'email');
  assert.strictEqual(mail.sent.sentTo, 'he•••@pizza.example');
  const noCategory = await api('POST', '/auth/register', { ...base, email, emailOtp: mail, business: {} });
  assert.strictEqual(noCategory.status, 400);

  // A wrong email code fails the sign-up but doesn't use up the SMS code.
  const typo = await api('POST', '/auth/register', { ...base, email, emailOtp: { ...mail, code: mail.code === '000000' ? '111111' : '000000' } });
  assert.deepStrictEqual([typo.status, typo.body.error.code], [400, 'otp_invalid']);
  assert.match(typo.body.error.message, /email code is wrong/);

  const reg = await api('POST', '/auth/register', { ...base, email, emailOtp: mail });
  assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
  assert.strictEqual(reg.body.user.business.category, 'Restaurant');
  assert.strictEqual(reg.body.user.business.email, 'hello@pizza.example');
  const me = await api('GET', '/me', null, reg.body.token);
  assert.deepStrictEqual(me.body.contact, { phone, email: 'hello@pizza.example' });
  assert.strictEqual(me.body.business.timezone, 'Asia/Kolkata');

  // The email is taken now; a business can log in with a code by email too.
  assert.strictEqual((await api('POST', '/auth/otp', { purpose: 'register', email })).body.error.code, 'email_taken');
  const login = await codeFor({ purpose: 'login', email });
  assert.strictEqual((await api('POST', '/auth/login', { email, ...login })).body.user.username, reg.body.user.username);
});

test('api: change a verified number/email; reset the chat lock code by SMS', async (t) => {
  const { api, codeFor, store } = await setup(t);
  const sms = await codeFor({ purpose: 'register', phone: '+447700900123' });
  const { body: { token } } = await api('POST', '/auth/register', { displayName: 'Sam', phone: '+447700900123', phoneOtp: sms });
  store.register('legacy', 'pass');
  store.setContact('legacy', 'email', 'taken@example.com');

  // Personal account -> business: needs an email first.
  assert.strictEqual((await api('PUT', '/me/business', { category: 'Retail' }, token)).body.error.code, 'verification_required');
  assert.strictEqual((await api('POST', '/me/contact/otp', { email: 'taken@example.com' }, token)).body.error.code, 'email_taken');
  const mail = await codeFor({ email: 'sam@shop.example' }, '/me/contact/otp', token);
  const wrongAddress = await api('PUT', '/me/contact', { email: 'other@shop.example', ...mail }, token);
  assert.strictEqual(wrongAddress.body.error.code, 'otp_expired');
  const saved = await api('PUT', '/me/contact', { email: 'sam@shop.example', ...mail }, token);
  assert.deepStrictEqual(saved.body.contact, { phone: '+447700900123', email: 'sam@shop.example' });
  const biz = await api('PUT', '/me/business', { category: 'Retail', email: 'ignored@x.example' }, token);
  assert.strictEqual(biz.body.business.email, 'sam@shop.example');

  // New number.
  const newSms = await codeFor({ phone: '+447700900999' }, '/me/contact/otp', token);
  await api('PUT', '/me/contact', { phone: '+447700900999', ...newSms }, token);
  assert.strictEqual((await api('GET', '/me', null, token)).body.contact.phone, '+447700900999');

  // Forgot the chat lock code: an SMS code to the account's number sets a new one.
  await api('PUT', '/chat-lock/code', { code: '1234' }, token);
  const reset = await codeFor(undefined, '/chat-lock/reset/otp', token);
  assert.strictEqual(reset.sent.sentTo, '+44•••••••999');
  const tooShort = await api('POST', '/chat-lock/reset', { ...reset, newCode: '1' }, token);
  assert.strictEqual(tooShort.status, 400);
  const done = await api('POST', '/chat-lock/reset', { ...reset, newCode: '9876' }, token);
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.ok(store.verifyLockCode('sam', '9876'));
  assert.strictEqual((await api('POST', '/chat-lock/reset', { ...reset, newCode: '1111' }, token)).body.error.code, 'otp_expired', 'single use');
});

test('api: OTP_DEV_CODES returns codes; resend cooldown answers 429 with Retry-After', async (t) => {
  const store = new Store({ file: null });
  const app = createApp({ store, otp: { sender: async () => {}, exposeCodes: true } });
  await new Promise((r) => app.server.listen(0, r));
  t.after(() => { app.io.close(); app.server.close(); });
  const post = (body) => fetch(`http://localhost:${app.server.address().port}/api/v1/auth/otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const first = await (await post({ purpose: 'register', phone: '+919000000001' })).json();
  assert.match(first.devCode, /^\d{6}$/);
  const again = await post({ purpose: 'register', phone: '+919000000001' });
  assert.strictEqual(again.status, 429);
  assert.ok(Number(again.headers.get('retry-after')) > 0);
  assert.strictEqual((await again.json()).error.code, 'otp_too_soon');
});
