'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const { createLinking } = require('../server/linking');
const legal = require('../server/legal');

const CONSENT = { terms: true, version: legal.VERSION };

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({
    store,
    admin: { username: 'root', password: 'correct-horse-battery' },
    otp: { sender: async () => {}, resendMs: 0, exposeCodes: true },
    rateLimit: { max: 100000, authMax: 100000 },
  });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  t.after(() => { app.io.close(); app.server.close(); });
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const code = async (purpose, dest) => (await api('POST', '/auth/otp', null, { purpose, ...dest })).body;
  const signUp = async (name, phone, extra = {}) => {
    const sent = await code('register', { phone });
    return api('POST', '/auth/register', null, { displayName: name, phone, phoneOtp: { requestId: sent.requestId, code: sent.devCode }, consent: CONSENT, birthDate: '1990-01-01', ...extra });
  };
  const smsLogin = async (phone, extra = {}) => {
    const sent = await code('login', { phone, ...extra });
    if (!sent.requestId) return { status: 403, body: { error: sent } };
    return api('POST', '/auth/login', null, { phone, requestId: sent.requestId, code: sent.devCode, ...extra });
  };
  return { store, api, code, signUp, smsLogin };
}

test('linking: a passcode works once, expires after two minutes and allows five wrong tries', () => {
  let now = 1000;
  const l = createLinking({ now: () => now });
  const { code } = l.create('alice');
  assert.match(code, /^\d{6}$/);
  assert.throws(() => l.consume('alice', code === '000000' ? '111111' : '000000'), /Wrong passcode/);
  l.consume('alice', code);
  assert.throws(() => l.consume('alice', code), /not valid/, 'used once');
  const second = l.create('alice');
  now += 2 * 60 * 1000 + 1;
  assert.throws(() => l.consume('alice', second.code), /not valid/, 'expired');
  now += 1;
  const third = l.create('alice');
  const wrong = third.code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 4; i++) assert.throws(() => l.consume('alice', wrong), /Wrong passcode/);
  assert.throws(() => l.consume('alice', wrong), /Too many wrong tries/);
  assert.throws(() => l.consume('alice', third.code), /not valid/, 'the code is burnt after five misses');
  const m = createLinking({ now: () => now });
  for (let i = 0; i < 5; i++) m.create('bob');
  assert.throws(() => m.create('bob'), /Too many passcodes/);
});

test('web login needs a passcode from the primary phone; the phone itself still uses its SMS code', async (t) => {
  const env = await setup(t);
  const reg = await env.signUp('Alice', '+919800000001');
  assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
  const phoneToken = reg.body.token;

  // An SMS code is refused for a browser while the phone is signed in (and no code is even sent).
  const web = await env.api('POST', '/auth/otp', null, { purpose: 'login', phone: '+919800000001', clientType: 'web' });
  assert.strictEqual(web.status, 403);
  assert.strictEqual(web.body.error.code, 'passcode_required');
  const sent = await env.code('login', { phone: '+919800000001' });
  const viaSms = await env.api('POST', '/auth/login', null, { phone: '+919800000001', requestId: sent.requestId, code: sent.devCode, clientType: 'web' });
  assert.strictEqual(viaSms.body.error.code, 'passcode_required', 'even with a valid code');

  // A browser cannot make passcodes; the phone can.
  const made = await env.api('POST', '/me/link-code', phoneToken);
  assert.strictEqual(made.status, 201);
  assert.match(made.body.code, /^\d{6}$/);
  const wrong = made.body.code === '000000' ? '111111' : '000000';
  assert.strictEqual((await env.api('POST', '/auth/login', null, { phone: '+919800000001', linkCode: wrong, clientType: 'web' })).body.error.code, 'invalid_passcode');
  const browser = await env.api('POST', '/auth/login', null, { phone: '+919800000001', linkCode: made.body.code, clientType: 'web', deviceName: 'Chrome on Windows' });
  assert.strictEqual(browser.status, 200, JSON.stringify(browser.body));
  assert.strictEqual((await env.api('POST', '/auth/login', null, { phone: '+919800000001', linkCode: made.body.code, clientType: 'web' })).status, 401, 'a passcode is used once');
  assert.strictEqual((await env.api('GET', '/me', browser.body.token)).status, 200);
  const denied = await env.api('POST', '/me/link-code', browser.body.token);
  assert.strictEqual(denied.status, 403, 'a linked browser cannot hand out passcodes');
  assert.strictEqual(denied.body.error.code, 'primary_required');

  // The phone sees the browser and can sign it out.
  const list = await env.api('GET', '/me/linked-devices', phoneToken);
  assert.deepStrictEqual(list.body.devices.map((d) => d.name), ['Chrome on Windows']);
  assert.strictEqual(list.body.primary, true);
  assert.strictEqual((await env.api('DELETE', `/me/linked-devices/${list.body.devices[0].id}`, browser.body.token)).status, 204, 'a browser may sign itself out');
  const again = await env.api('POST', '/me/link-code', phoneToken);
  const second = await env.api('POST', '/auth/login', null, { phone: '+919800000001', linkCode: again.body.code, clientType: 'web' });
  const other = await env.api('POST', '/auth/login', null, { phone: '+919800000001', linkCode: (await env.api('POST', '/me/link-code', phoneToken)).body.code, clientType: 'web' });
  const id = (await env.api('GET', '/me/linked-devices', phoneToken)).body.devices.find((d) => !d.current).id;
  assert.strictEqual((await env.api('DELETE', `/me/linked-devices/${id}`, second.body.token)).status, 403, 'a browser cannot sign others out');
  assert.strictEqual((await env.api('DELETE', `/me/linked-devices/${id}`, phoneToken)).status, 204);
  assert.strictEqual((await env.api('GET', '/me', other.body.token)).status === 200 || (await env.api('GET', '/me', second.body.token)).status === 200, true);
  assert.strictEqual((await env.api('DELETE', '/me/linked-devices/nope', phoneToken)).status, 404);

  // With the phone logged out, nobody holds the number: an SMS code works for a browser again (and becomes the primary).
  await env.api('POST', '/auth/logout', phoneToken);
  const fresh = await env.smsLogin('+919800000001', { clientType: 'web' });
  assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
  assert.strictEqual((await env.api('POST', '/me/link-code', fresh.body.token)).status, 201);
});

test('registration: mobile is mandatory, email optional but verified when given', async (t) => {
  const env = await setup(t);
  const noPhone = await env.api('POST', '/auth/register', null, { displayName: 'Z', consent: CONSENT, birthDate: '1990-01-01' });
  assert.strictEqual(noPhone.status, 400);

  const plain = await env.signUp('Asha', '+919800000002');
  assert.strictEqual(plain.status, 201, JSON.stringify(plain.body));
  assert.strictEqual((await env.api('GET', '/me', plain.body.token)).body.contact.email, null);

  // An email must come with its own code.
  const sent = await env.code('register', { phone: '+919800000003' });
  const unproved = await env.api('POST', '/auth/register', null, { displayName: 'Ben', phone: '+919800000003', phoneOtp: { requestId: sent.requestId, code: sent.devCode }, email: 'ben@example.com', consent: CONSENT, birthDate: '1990-01-01' });
  assert.strictEqual(unproved.status >= 400 && unproved.status < 500, true, 'an email without a code is refused');
  const withEmail = await (async () => {
    const p = await env.code('register', { phone: '+919800000003' });
    const e = await env.code('register', { email: 'ben@example.com' });
    return env.api('POST', '/auth/register', null, { displayName: 'Ben', phone: '+919800000003', phoneOtp: { requestId: p.requestId, code: p.devCode }, email: 'ben@example.com', emailOtp: { requestId: e.requestId, code: e.devCode }, consent: CONSENT, birthDate: '1990-01-01' });
  })();
  assert.strictEqual(withEmail.status, 201, JSON.stringify(withEmail.body));
  assert.strictEqual((await env.api('GET', '/me', withEmail.body.token)).body.contact.email, 'ben@example.com');
});

test('photo rotation: Premium, a full set of photos, every 7 days', async (t) => {
  const env = await setup(t);
  const { store } = env;
  const a = store.register('alice', 'pass');
  const ids = [];
  const limits = store.getSettings().limits;
  for (let i = 0; i < limits.premiumProfilePhotos; i++) ids.push(store.addPhoto('alice', { full: Buffer.from(`i${i}`), thumb: Buffer.from(`t${i}`), mime: 'image/png', thumbMime: 'image/png' }).id);
  assert.strictEqual((await env.api('PUT', '/me/photo-rotation', a.token, { on: true })).body.error.code, 'premium_required');
  store.setPremiumByAdmin('alice', Date.now() + 30 * 24 * 3600 * 1000);
  assert.strictEqual((await env.api('PUT', '/me/photo-rotation', a.token, { on: 'yes' })).status, 400);
  const on = await env.api('PUT', '/me/photo-rotation', a.token, { on: true });
  assert.strictEqual(on.status, 200, JSON.stringify(on.body));
  assert.strictEqual(on.body.rotation.active, true);
  const first = on.body.photos[0].id;

  assert.deepStrictEqual(store.rotatePhotos(Date.now() + 6 * 24 * 3600 * 1000), [], 'not before a week');
  assert.deepStrictEqual(store.rotatePhotos(Date.now() + 7 * 24 * 3600 * 1000 + 1000), ['alice']);
  const after = (await env.api('GET', '/me/photos', a.token)).body;
  assert.strictEqual(after.photos[0].id, ids[1], 'the next photo is now the picture');
  assert.strictEqual(after.photos.at(-1).id, first, 'the old one goes to the back');

  // Without Premium it pauses; with fewer than a full set it is refused.
  store.setPremiumByAdmin('alice', 0);
  assert.deepStrictEqual(store.rotatePhotos(Date.now() + 30 * 24 * 3600 * 1000), []);
  store.setPremiumByAdmin('alice', Date.now() + 30 * 24 * 3600 * 1000);
  await env.api('DELETE', `/me/photos/${ids[2]}`, a.token);
  assert.strictEqual((await env.api('PUT', '/me/photo-rotation', a.token, { on: true })).body.error.code, 'not_enough_photos');
  assert.deepStrictEqual(store.rotatePhotos(Date.now() + 60 * 24 * 3600 * 1000), [], 'a broken set does not rotate');
});
