'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const { allowedEndpoint } = require('../server/push');

const b64u = (n, fill = 7) => Buffer.alloc(n, fill).toString('base64url');
const sub = (id = 'abc', host = 'fcm.googleapis.com') => ({ endpoint: `https://${host}/fcm/send/${id}`, keys: { p256dh: b64u(65, 4), auth: b64u(16) } });
const once = (s, ev, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); resolve(p); });
});
const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));

async function setup(t, { push = {}, ...opts } = {}) {
  const store = new Store({ file: null });
  const sent = [];
  const behaviour = { fail: null };
  const sender = async (s, payload, options) => {
    if (behaviour.fail) throw behaviour.fail;
    sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), options });
  };
  const app = createApp({ store, push: { sender, minGapMs: 0, ...push }, ringTimeoutMs: 400, ...opts });
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
  return { store, app, client, api, sent, behaviour };
}

/** Two people with a chat; bob has one subscribed device and is not connected. */
async function pair(t, opts) {
  const env = await setup(t, opts);
  const alice = env.store.register('alice', 'pass');
  const bob = env.store.register('bob', 'pass');
  const conv = (await env.api('POST', '/conversations', alice.token, { type: 'direct', username: 'bob' })).body.conversation;
  const saved = await env.api('PUT', '/push/subscription', bob.token, { subscription: sub() });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  return { ...env, alice, bob, conv };
}
const say = (env, text = 'secret plans') => env.api('POST', `/conversations/${env.conv.id}/messages`, env.alice.token, { text });
const settle = () => new Promise((r) => setTimeout(r, 60));

test('push: only addresses of real browser push services are accepted', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    assert.ok(allowedEndpoint(ok), ok);
  }
  for (const bad of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://internal.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'not a url', '', undefined, 'https://evilgoogleapis.com/x']) {
    assert.ok(!allowedEndpoint(bad), String(bad));
  }
  assert.ok(allowedEndpoint('https://push.example.org/x', ['push.example.org']), 'an administrator can allow another host');
});

test('push: subscribe, settings, key, test, unsubscribe (REST)', async (t) => {
  const { api, store, alice, sent } = await setup(t).then((e) => ({ ...e, alice: e.store.register('alice', 'pass') }));
  const cfg = await api('GET', '/push', alice.token);
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(cfg.body.enabled, true);
  assert.ok(cfg.body.publicKey.length > 60, 'the VAPID public key');
  assert.deepStrictEqual(cfg.body.preferences, { messages: true, calls: true, preview: true });
  assert.strictEqual(cfg.body.devices, 0);

  assert.strictEqual((await api('POST', '/push/test', alice.token)).status, 409, 'nothing to test yet');
  assert.strictEqual((await api('PUT', '/push/subscription', alice.token, { subscription: sub('x', 'evil.example.com') })).status, 400, 'unknown push service');
  assert.strictEqual((await api('PUT', '/push/subscription', alice.token, { subscription: { endpoint: sub().endpoint, keys: { p256dh: 'AAAA', auth: 'AAAA' } } })).status, 400, 'bad keys');
  assert.strictEqual((await api('PUT', '/push/subscription', alice.token, {})).status, 400);

  assert.strictEqual((await api('PUT', '/push/subscription', alice.token, { subscription: sub('one') })).body.devices, 1);
  assert.strictEqual((await api('PUT', '/push/subscription', alice.token, { subscription: sub('one') })).body.devices, 1, 'the same device again is still one');
  assert.strictEqual((await api('PUT', '/push/subscription', alice.token, { subscription: sub('two', 'updates.push.services.mozilla.com') })).body.devices, 2);

  const test1 = await api('POST', '/push/test', alice.token);
  assert.strictEqual(test1.body.sent, 2);
  assert.deepStrictEqual(sent.map((s) => s.payload.kind), ['test', 'test']);

  assert.deepStrictEqual((await api('PATCH', '/push/settings', alice.token, { preview: false })).body.preferences, { messages: true, calls: true, preview: false });
  assert.strictEqual((await api('PATCH', '/push/settings', alice.token, { calls: 'yes' })).status, 400);

  for (let i = 0; i < 12; i++) await api('PUT', '/push/subscription', alice.token, { subscription: sub(`d${i}`) });
  assert.strictEqual(store.pushSubs('alice').length, Store.PUSH_MAX_DEVICES, 'a limit per account; the oldest are dropped');

  assert.strictEqual((await api('POST', '/push/unsubscribe', alice.token, { endpoint: sub('d11').endpoint })).body.devices, Store.PUSH_MAX_DEVICES - 1);
  assert.strictEqual((await api('POST', '/push/unsubscribe', alice.token, { endpoint: 'https://nothing' })).status, 200, 'unknown is fine');
  assert.strictEqual((await api('GET', '/push', 'bad-token')).status, 401);
});

test('push: a message to someone who is not connected sends who and what kind, never the text', async (t) => {
  const env = await pair(t);
  assert.strictEqual((await say(env)).status, 201);
  await settle();
  assert.strictEqual(env.sent.length, 1);
  const n = env.sent[0];
  assert.strictEqual(n.payload.kind, 'message');
  assert.strictEqual(n.payload.title, 'alice');
  assert.strictEqual(n.payload.body, 'New message');
  assert.strictEqual(n.payload.convId, env.conv.id);
  assert.ok(!JSON.stringify(n).includes('secret plans'), 'the message text is never in a notification');
  assert.strictEqual(n.endpoint, sub().endpoint);

  // Voice messages say so.
  const voice = await fetch(`${env.app.server.address() ? `http://localhost:${env.app.server.address().port}` : ''}/api/v1/conversations/${env.conv.id}/voice?duration=2`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.alice.token}`, 'Content-Type': 'audio/webm' }, body: Buffer.from([1, 2, 3, 4]),
  });
  assert.strictEqual(voice.status, 201);
  await settle();
  assert.strictEqual(env.sent.at(-1).payload.body, 'Voice message');
});

test('push: nothing when the person is connected, switched it off, or the feature is off', async (t) => {
  const env = await pair(t);
  const live = await env.client(env.bob.token);
  await say(env);
  await settle();
  assert.strictEqual(env.sent.length, 0, 'connected: the app shows it itself');
  live.close();
  await settle();

  await env.api('PATCH', '/push/settings', env.bob.token, { messages: false });
  await say(env);
  await settle();
  assert.strictEqual(env.sent.length, 0, 'messages switched off');
  await env.api('PATCH', '/push/settings', env.bob.token, { messages: true, preview: false });
  await say(env);
  await settle();
  assert.strictEqual(env.sent.length, 1);
  assert.deepStrictEqual([env.sent[0].payload.title, env.sent[0].payload.body], ['VartiQ', 'New message'], 'without the preview the sender is not named');
  assert.strictEqual(env.sent[0].payload.convId, env.conv.id, 'tapping still opens the chat');

  env.store.updateSettings({ features: { push: false } });
  await say(env);
  await settle();
  assert.strictEqual(env.sent.length, 1, 'feature off: nothing is sent');
  assert.strictEqual((await env.api('PUT', '/push/subscription', env.bob.token, { subscription: sub('z') })).status, 403, 'and nobody can turn it on');
  assert.strictEqual((await env.api('POST', '/push/unsubscribe', env.bob.token, { endpoint: sub().endpoint })).status, 200, 'turning off always works');
  assert.strictEqual((await env.api('GET', '/push', env.bob.token)).body.enabled, false);
});

test('push: locked and hidden chats never show a name; groups show the group and the sender', async (t) => {
  const env = await pair(t);
  env.store.setLockCode?.('bob', '1234');
  env.store.lockChat?.('bob', env.conv.id);
  if (!env.store.isChatLocked('bob', env.conv.id)) env.store.data.users.bob.lockedChats = [env.conv.id];
  await say(env);
  await settle();
  assert.deepStrictEqual([env.sent[0].payload.title, env.sent[0].payload.body, env.sent[0].payload.convId], ['VartiQ', 'New message', undefined], 'a locked chat is anonymous');
  env.store.data.users.bob.lockedChats = [];

  env.store.register('carol', 'pass');
  const g = (await env.api('POST', '/conversations', env.alice.token, { type: 'group', name: 'Trip', members: ['bob', 'carol'] })).body.conversation;
  await env.api('POST', `/conversations/${g.id}/messages`, env.alice.token, { text: 'hi all' });
  await settle();
  const n = env.sent.at(-1).payload;
  assert.deepStrictEqual([n.title, n.body], ['Trip', 'alice: New message']);
});

test('push: a burst from one chat is one notification; a gone device is forgotten; errors never break sending', async (t) => {
  const env = await pair(t, { push: { minGapMs: 60 * 1000 } });
  await say(env, 'one');
  await say(env, 'two');
  await say(env, 'three');
  await settle();
  assert.strictEqual(env.sent.length, 1, 'collapsed');

  const env2 = await pair(t);
  env2.behaviour.fail = Object.assign(new Error('Gone'), { statusCode: 410 });
  assert.strictEqual(env2.store.pushSubs('bob').length, 1);
  assert.strictEqual((await say(env2)).status, 201);
  await settle();
  assert.strictEqual(env2.store.pushSubs('bob').length, 0, 'the push service says it is gone: forgotten');

  const env3 = await pair(t);
  env3.behaviour.fail = Object.assign(new Error('boom'), { statusCode: 500 });
  assert.strictEqual((await say(env3)).status, 201, 'a failing push service does not break the message');
  await settle();
  assert.strictEqual(env3.store.pushSubs('bob').length, 1, 'and the device is kept');
});

test('push: a call rings someone whose app is closed, and rings when they open the app', async (t) => {
  const env = await pair(t, { ringTimeoutMs: 3000 });
  const a = await env.client(env.alice.token);
  const started = await call(a, 'call:start', { convId: env.conv.id, kind: 'video' });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  await settle();
  const n = env.sent.find((x) => x.payload.kind === 'call');
  assert.ok(n, 'a call notification was sent');
  assert.deepStrictEqual([n.payload.title, n.payload.body], ['alice', 'Incoming video call']);
  assert.strictEqual(n.options.urgency, 'high');
  assert.ok(n.options.ttl <= 60, 'short lived: a call that stopped ringing is not worth showing');

  // Bob taps the notification: the app opens and the call is still ringing.
  const b = connect(`http://localhost:${env.app.server.address().port}`, { auth: { token: env.bob.token, appSession: 'x' }, transports: ['websocket'], forceNew: true });
  t.after(() => b.close());
  const ring = await once(b, 'call:incoming');
  assert.strictEqual(ring.from, 'alice');
  assert.strictEqual(ring.kind, 'video');
});

test('push: calls to someone with no subscription still say "not available"; calls switched off', async (t) => {
  const env = await pair(t);
  env.store.register('carol', 'pass');
  const carol = env.store.register('dave', 'pass');
  const c2 = (await env.api('POST', '/conversations', env.alice.token, { type: 'direct', username: 'dave' })).body.conversation;
  const a = await env.client(env.alice.token);
  const res = await call(a, 'call:start', { convId: c2.id, kind: 'audio' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /not available/);
  assert.ok(carol);

  await env.api('PATCH', '/push/settings', env.bob.token, { calls: false });
  const res2 = await call(a, 'call:start', { convId: env.conv.id, kind: 'audio' });
  assert.strictEqual(res2.ok, false, 'bob turned call notifications off, so an offline call cannot ring him');
});

test('push: a missed call notifies; closing an account stops notifications; the export lists devices', async (t) => {
  const env = await pair(t, { ringTimeoutMs: 100 });
  const a = await env.client(env.alice.token);
  await call(a, 'call:start', { convId: env.conv.id, kind: 'audio' });
  await new Promise((r) => setTimeout(r, 400));
  const kinds = env.sent.map((x) => x.payload.kind);
  assert.ok(kinds.includes('call'), 'ring');
  assert.ok(kinds.includes('missed'), 'and a missed-call notice afterwards');
  assert.strictEqual(env.sent.find((x) => x.payload.kind === 'missed').payload.body, 'Missed voice call');

  const exp = env.store.exportAccount('bob');
  assert.strictEqual(exp.account.pushNotifications.devices.length, 1);
  assert.ok(!JSON.stringify(exp.account.pushNotifications).includes('fcm.googleapis.com'), 'the push address itself is not exported');

  env.store.requestAccountDeletion('bob');
  assert.strictEqual(env.store.pushSubs('bob').length, 0, 'a disabled account stops getting notifications at once');
});
