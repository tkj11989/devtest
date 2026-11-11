'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const TOKEN = `${'d'.repeat(20)}:APA91b${'x'.repeat(120)}`;

async function setup(t, { fcm } = {}) {
  const store = new Store({ file: null });
  const fcmSent = [];
  const behaviour = { fail: null };
  const fcmSender = async (sub, message) => { if (behaviour.fail) throw behaviour.fail; fcmSent.push({ sub, message }); };
  const app = createApp({ store, push: { sender: async () => {}, minGapMs: 0, fcm: fcm === undefined ? { sender: fcmSender } : fcm } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  t.after(() => { app.io.close(); app.server.close(); });
  const ann = store.register('ann', 'pass', 'Ann');
  const bob = store.register('bob', 'pass', 'Bob');
  const dm = store.getOrCreateDirect('ann', 'bob');
  const api = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, app, ann, bob, dm, fcmSent, behaviour, api };
}

test('the Android app registers its token; messages, calls and the test notification reach it', async (t) => {
  const { store, app, ann, bob, dm, fcmSent, api } = await setup(t);
  assert.strictEqual((await api(bob.token, 'GET', '/push')).body.native, true, 'the server says the app can get notifications');
  const put = await api(bob.token, 'PUT', '/push/subscription', { fcmToken: TOKEN, platform: 'android' });
  assert.deepStrictEqual([put.status, put.body.devices], [200, 1]);
  assert.strictEqual(store.pushSubs('bob')[0].endpoint, `fcm:${TOKEN}`);
  assert.strictEqual(store.pushSubs('bob')[0].keys, undefined, 'no browser keys for an app');
  assert.strictEqual((await api(bob.token, 'PUT', '/push/subscription', { fcmToken: TOKEN })).body.devices, 1, 'the same token is not added twice');

  // A message while Bob is not connected.
  await app.service.actions.sendText('ann', { convId: dm.id, text: 'hello bob' }, {});
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fcmSent.length, 1);
  const m = fcmSent[0].message;
  assert.strictEqual(m.token, TOKEN);
  assert.deepStrictEqual(m.notification, { title: 'Ann', body: 'New message' }, 'who and what kind, never the text');
  assert.deepStrictEqual([m.data.kind, m.data.convId, m.android.priority, m.android.notification.channel_id], ['message', dm.id, 'NORMAL', 'messages']);
  assert.ok(!JSON.stringify(m).includes('hello bob'));

  // A call: high priority, its own channel, short life.
  fcmSent.length = 0;
  app.push.call('bob', store.getConversation(dm.id), { id: 'call1', kind: 'video' }, 'ann');
  await new Promise((r) => setTimeout(r, 50));
  const call = fcmSent.find((x) => x.message.data.kind === 'call');
  assert.ok(call, 'the call wake-up was sent');
  assert.deepStrictEqual([call.message.android.priority, call.message.android.notification.channel_id, call.message.android.ttl, call.message.notification.body], ['HIGH', 'calls', '30s', 'Incoming video call']);

  // The settings test button reaches the app too; turning it off forgets the token.
  fcmSent.length = 0;
  assert.strictEqual((await api(bob.token, 'POST', '/push/test')).status, 200);
  assert.strictEqual(fcmSent.length, 1);
  assert.strictEqual((await api(bob.token, 'POST', '/push/unsubscribe', { endpoint: `fcm:${TOKEN}` })).body.devices, 0);
  void ann;
});

test('bad tokens are refused, a server without FCM says so, and a token Google no longer knows is forgotten', async (t) => {
  const { store, app, bob, dm, behaviour, api } = await setup(t);
  assert.strictEqual((await api(bob.token, 'PUT', '/push/subscription', { fcmToken: 'short' })).status, 400);
  assert.strictEqual((await api(bob.token, 'PUT', '/push/subscription', { fcmToken: `${TOKEN}<script>` })).status, 400);
  await api(bob.token, 'PUT', '/push/subscription', { fcmToken: TOKEN });
  behaviour.fail = Object.assign(new Error('gone'), { statusCode: 410 });
  await app.service.actions.sendText('ann', { convId: dm.id, text: 'x' }, {});
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(store.pushSubs('bob').length, 0, 'a dead token is removed');

  const off = await setup(t, { fcm: {} });
  assert.strictEqual((await off.api(off.bob.token, 'GET', '/push')).body.native, false);
  assert.strictEqual((await off.api(off.bob.token, 'PUT', '/push/subscription', { fcmToken: TOKEN })).status, 503);
});

test('the Google sign-in and the FCM call: a signed request, a cached token, a retry after 401, a 404 means the token is gone', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { project_id: 'vartiq-test', client_email: 'push@vartiq-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const { store, app, bob, dm, api } = await setup(t, { fcm: { serviceAccount: account } });
  const calls = [];
  let tokenIssued = 0;
  let fcmStatus = 200;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!/googleapis\.com/.test(String(url))) return realFetch(url, opts);
    calls.push({ url: String(url), opts });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      tokenIssued++;
      const assertion = new URLSearchParams(opts.body).get('assertion');
      const [h, c, sig] = assertion.split('.');
      assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig, 'base64url'), 'signed with the service account key');
      const claims = JSON.parse(Buffer.from(c, 'base64url'));
      assert.deepStrictEqual([claims.iss, claims.scope, claims.aud], [account.client_email, 'https://www.googleapis.com/auth/firebase.messaging', 'https://oauth2.googleapis.com/token']);
      return new Response(JSON.stringify({ access_token: `tok-${tokenIssued}`, expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const sent = JSON.parse(opts.body);
    if (fcmStatus === 401 && opts.headers.Authorization === 'Bearer tok-1') return new Response('{}', { status: 401 });
    if (fcmStatus === 404) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
    assert.strictEqual(sent.message.token, TOKEN);
    return new Response('{}', { status: 200 });
  };
  t.after(() => { global.fetch = realFetch; });

  assert.strictEqual((await api(bob.token, 'GET', '/push')).body.native, true, 'a service account is enough');
  await api(bob.token, 'PUT', '/push/subscription', { fcmToken: TOKEN });
  const send = async (text) => { await app.service.actions.sendText('ann', { convId: dm.id, text }, {}); await new Promise((r) => setTimeout(r, 80)); };

  await send('one');
  await send('two');
  assert.strictEqual(tokenIssued, 1, 'the access token is kept for the next ones');
  assert.strictEqual(calls.filter((c) => c.url.startsWith('https://fcm.googleapis.com/v1/projects/vartiq-test/messages:send')).length, 2);
  assert.strictEqual(calls.find((c) => c.url.includes('fcm.googleapis.com')).opts.headers.Authorization, 'Bearer tok-1');

  fcmStatus = 401; // the cached token was refused: sign in again and retry once
  await send('three');
  assert.strictEqual(tokenIssued, 2);
  assert.strictEqual(store.pushSubs('bob').length, 1, 'still registered');

  fcmStatus = 404;
  await send('four');
  assert.strictEqual(store.pushSubs('bob').length, 0, 'Google no longer knows the token: forgotten');
});
