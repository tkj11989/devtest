'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const { isPrivateAddress } = require('../server/webhooks');

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  store.updateSettings({ features: { developerApi: true } }); // the developer API is off by default
  const app = createApp({ store, webhooks: { allowPrivate: true, retryDelaysMs: [30, 30] }, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });

  /** fetch wrapper: api('POST', '/conversations', { token, body }) -> { status, body, headers } */
  const api = async (method, path, { token, body, headers = {}, raw } = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* binary or empty */ }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const socketFor = async (token) => {
    const s = connect(base, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
    return s;
  };
  return { store, api, base, socketFor };
}

/** A local HTTP server that records webhook deliveries; `fail` makes it answer 500 first. */
async function webhookReceiver(t, { fail = 0 } = {}) {
  const received = [];
  const waiters = [];
  let failuresLeft = fail;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        res.writeHead(500).end();
        return;
      }
      const delivery = { headers: req.headers, raw: body, json: JSON.parse(body) };
      received.push(delivery);
      waiters.splice(0).forEach((w) => w());
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const waitFor = async (pred, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = received.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error('webhook not received');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { url: `http://127.0.0.1:${server.address().port}/hook`, received, waitFor };
}

test('api: password login for older accounts, API keys and auth errors', async (t) => {
  const { api, store } = await setup(t);

  // Sign-up is by mobile number + OTP (see auth.test.js); accounts made before that keep their password.
  const reg = store.register('alice', 'secret1', 'Alice');
  const old = await api('POST', '/auth/register', { body: { username: 'bob', password: 'secret1' } });
  assert.strictEqual(old.status, 400, 'password sign-up is gone');

  const login = await api('POST', '/auth/login', { body: { username: 'alice', password: 'secret1' } });
  assert.strictEqual(login.status, 200);
  const bad = await api('POST', '/auth/login', { body: { username: 'alice', password: 'nope' } });
  assert.deepStrictEqual([bad.status, bad.body.error.code], [401, 'invalid_credentials']);

  const noAuth = await api('GET', '/me');
  assert.deepStrictEqual([noAuth.status, noAuth.body.error.code], [401, 'unauthorized']);

  // API key: shown once, works as a bearer token, can't mint more keys, can be revoked.
  const created = await api('POST', '/api-keys', { token: login.body.token, body: { name: 'CRM' } });
  assert.strictEqual(created.status, 201);
  const { key, apiKey } = created.body;
  assert.match(key, /^cak_/);
  assert.strictEqual(apiKey.name, 'CRM');
  assert.strictEqual(apiKey.hash, undefined);
  assert.strictEqual((await api('GET', '/me', { token: key })).body.user.username, 'alice');
  assert.strictEqual((await api('POST', '/api-keys', { token: key, body: {} })).status, 403);
  const listed = await api('GET', '/api-keys', { token: login.body.token });
  assert.deepStrictEqual(listed.body.apiKeys.map((k) => k.id), [apiKey.id]);
  assert.strictEqual((await api('DELETE', `/api-keys/${apiKey.id}`, { token: login.body.token })).status, 204);
  assert.strictEqual((await api('GET', '/me', { token: key })).status, 401, 'revoked');

  // Logout ends the session.
  assert.strictEqual((await api('POST', '/auth/logout', { token: login.body.token })).status, 204);
  assert.strictEqual((await api('GET', '/me', { token: login.body.token })).status, 401);

  assert.strictEqual((await api('GET', '/nope', { token: reg.token })).body.error.code, 'not_found');
  const badJson = await api('POST', '/conversations', { token: reg.token, raw: '{oops', headers: { 'Content-Type': 'application/json' } });
  assert.deepStrictEqual([badJson.status, badJson.body.error.code], [400, 'invalid_json']);
});

test('api: conversations and messages over REST reach live apps and are idempotent', async (t) => {
  const { api, store, socketFor } = await setup(t);
  const alice = store.register('alice', 'pass', 'Alice').token;
  const bob = store.register('bob', 'pass', 'Bob').token;
  store.register('carol', 'pass');
  const { key } = store.createApiKey('alice', 'bot');

  const bobApp = await socketFor(bob);
  const conv = await api('POST', '/conversations', { token: key, body: { type: 'direct', username: 'bob' } });
  assert.strictEqual(conv.status, 201);
  const id = encodeURIComponent(conv.body.conversation.id);

  const live = new Promise((r) => bobApp.once('message:new', r));
  const sent = await api('POST', `/conversations/${id}/messages`, { token: key, body: { text: 'Hello from the API' }, headers: { 'Idempotency-Key': 'order-42' } });
  assert.strictEqual(sent.status, 201);
  assert.strictEqual(sent.body.message.text, 'Hello from the API');
  assert.deepStrictEqual(sent.body.message.deliveredTo, ['bob'], 'bob is online in the app');
  assert.strictEqual((await live).message.id, sent.body.message.id);

  const again = await api('POST', `/conversations/${id}/messages`, { token: key, body: { text: 'Hello from the API' }, headers: { 'Idempotency-Key': 'order-42' } });
  assert.strictEqual(again.body.message.id, sent.body.message.id, 'same key -> same message');
  assert.strictEqual(store.data.messages[conv.body.conversation.id].length, 1);

  // Pagination
  for (let i = 0; i < 4; i++) await api('POST', `/conversations/${id}/messages`, { token: bob, body: { text: `msg ${i}` } });
  const page1 = await api('GET', `/conversations/${id}/messages?limit=3`, { token: alice });
  assert.deepStrictEqual(page1.body.messages.map((m) => m.text), ['msg 1', 'msg 2', 'msg 3']);
  assert.strictEqual(page1.body.hasMore, true);
  const page2 = await api('GET', `/conversations/${id}/messages?limit=3&before=${page1.body.nextBefore}`, { token: alice });
  assert.deepStrictEqual(page2.body.messages.map((m) => m.text), ['Hello from the API', 'msg 0']);
  assert.strictEqual(page2.body.hasMore, false);

  // List, read, star, delete
  const list = await api('GET', '/conversations', { token: alice });
  assert.strictEqual(list.body.conversations[0].unread, 4);
  assert.strictEqual(list.body.users.bob.online, true);
  assert.strictEqual((await api('POST', `/conversations/${id}/read`, { token: alice })).body.updated, 4);
  const msgId = page1.body.messages[0].id;
  assert.strictEqual((await api('PUT', `/messages/${msgId}/star`, { token: alice })).body.message.starred, true);
  assert.deepStrictEqual((await api('GET', '/starred', { token: alice })).body.messages.map((m) => m.id), [msgId]);
  assert.strictEqual((await api('DELETE', `/messages/${msgId}`, { token: alice })).status, 403, 'not mine');
  assert.strictEqual((await api('DELETE', `/messages/${sent.body.message.id}`, { token: alice })).status, 204);

  // Groups, outsiders, blocking
  const grp = await api('POST', '/conversations', { token: alice, body: { type: 'group', name: 'Team', members: ['bob', 'carol'] } });
  assert.deepStrictEqual(grp.body.conversation.members.sort(), ['alice', 'bob', 'carol']);
  const carolKey = store.createApiKey('carol', 'x').key;
  assert.strictEqual((await api('GET', `/conversations/${id}/messages`, { token: carolKey })).status, 404);
  assert.strictEqual((await api('POST', '/conversations', { token: alice, body: { type: 'nope' } })).status, 400);
  assert.deepStrictEqual((await api('PUT', '/blocked/bob', { token: alice })).body.blocked, ['bob']);
  const blockedSend = await api('POST', `/conversations/${id}/messages`, { token: alice, body: { text: 'hi' } });
  assert.deepStrictEqual([blockedSend.status, blockedSend.body.error.code], [403, 'forbidden']);
  assert.deepStrictEqual((await api('DELETE', '/blocked/bob', { token: alice })).body.blocked, []);
  assert.strictEqual((await api('GET', '/users?q=car', { token: alice })).body.users[0].username, 'carol');
  assert.strictEqual((await api('GET', `/conversations/${id}/call`, { token: alice })).body.call, null);
});

test('api: webhooks are signed, filtered, retried and can be tested', async (t) => {
  const { api, store } = await setup(t);
  const hook = await webhookReceiver(t, { fail: 1 }); // first delivery fails, the retry succeeds
  store.register('alice', 'pass');
  const bob = store.register('bob', 'pass').token;
  const aliceKey = store.createApiKey('alice', 'bot').key;

  const created = await api('POST', '/webhooks', { token: aliceKey, body: { url: hook.url, events: ['message:new', 'ping'] } });
  assert.strictEqual(created.status, 201);
  const { secret, webhook } = created.body;
  assert.match(secret, /^whsec_/);
  assert.strictEqual(webhook.secret, undefined);
  assert.strictEqual((await api('POST', '/webhooks', { token: aliceKey, body: { url: 'ftp://x' } })).status, 400);
  assert.match((await api('POST', '/webhooks', { token: aliceKey, body: { url: hook.url, events: ['bogus'] } })).body.error.message, /Unknown event/);

  // bob messages alice -> alice's webhook gets message:new
  const conv = (await api('POST', '/conversations', { token: bob, body: { username: 'alice' } })).body.conversation;
  await api('POST', `/conversations/${encodeURIComponent(conv.id)}/typing`, { token: bob, body: {} }); // not subscribed
  await api('POST', `/conversations/${encodeURIComponent(conv.id)}/messages`, { token: bob, body: { text: 'ping me' } });
  const d = await hook.waitFor((x) => x.json.event === 'message:new');
  assert.strictEqual(d.json.user, 'alice');
  assert.strictEqual(d.json.data.message.text, 'ping me');
  assert.strictEqual(d.headers['x-chatapp-event'], 'message:new');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${d.headers['x-chatapp-timestamp']}.${d.raw}`).digest('hex');
  assert.strictEqual(d.headers['x-chatapp-signature'], expected, 'HMAC signature verifies');
  assert.ok(hook.received.every((x) => x.json.event !== 'typing'), 'unsubscribed events are not sent');

  const status = await api('GET', `/webhooks/${webhook.id}`, { token: aliceKey });
  assert.strictEqual(status.body.webhook.lastDelivery.ok, true);
  assert.strictEqual(status.body.webhook.lastDelivery.attempt, 2, 'delivered on the retry');

  const ping = await api('POST', `/webhooks/${webhook.id}/test`, { token: aliceKey });
  assert.strictEqual(ping.body.result.ok, true);
  await hook.waitFor((x) => x.json.event === 'ping');

  const off = await api('PATCH', `/webhooks/${webhook.id}`, { token: aliceKey, body: { active: false } });
  assert.strictEqual(off.body.webhook.active, false);
  assert.strictEqual((await api('DELETE', `/webhooks/${webhook.id}`, { token: aliceKey })).status, 204);
  assert.deepStrictEqual((await api('GET', '/webhooks', { token: aliceKey })).body.webhooks, []);
});

test('api: private webhook targets are refused unless allowed', async (t) => {
  const { api, store } = await setup(t, { webhooks: { allowPrivate: false, retryDelaysMs: [] } });
  store.register('alice', 'pass');
  const key = store.createApiKey('alice', 'x').key;
  const { webhook } = (await api('POST', '/webhooks', { token: key, body: { url: 'http://127.0.0.1:9/hook' } })).body;
  const res = await api('POST', `/webhooks/${webhook.id}/test`, { token: key });
  assert.strictEqual(res.body.result.ok, false);
  assert.match(res.body.result.error, /private address/);
  assert.ok(isPrivateAddress('192.168.0.10') && !isPrivateAddress('1.1.1.1'));
});

test('api: voice messages, status updates and media over REST', async (t) => {
  const { api, store } = await setup(t);
  const alice = store.register('alice', 'pass').token;
  const bob = store.register('bob', 'pass').token;
  const conv = (await api('POST', '/conversations', { token: alice, body: { username: 'bob' } })).body.conversation;
  const id = encodeURIComponent(conv.id);

  const audio = Buffer.from('OggS-fake-audio');
  const voice = await api('POST', `/conversations/${id}/voice?duration=4`, { token: alice, raw: audio, headers: { 'Content-Type': 'audio/ogg' } });
  assert.strictEqual(voice.status, 201);
  assert.deepStrictEqual(voice.body.message.voice.mime, 'audio/ogg');
  const media = await api('GET', `/media/${voice.body.message.voice.mediaId}`, { token: bob });
  assert.strictEqual(media.headers.get('content-type'), 'audio/ogg');
  const wrong = await api('POST', `/conversations/${id}/voice`, { token: alice, raw: audio, headers: { 'Content-Type': 'text/plain' } });
  assert.deepStrictEqual([wrong.status, wrong.body.error.code], [415, 'unsupported_media_type']);

  const text = await api('POST', '/statuses', { token: alice, body: { type: 'text', text: 'Hi all', bg: '#e66b4f' } });
  assert.strictEqual(text.status, 201);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const photo = await api('POST', '/statuses?caption=Sunset', { token: alice, raw: png, headers: { 'Content-Type': 'image/png' } });
  assert.strictEqual(photo.body.status.caption, 'Sunset');

  const seen = await api('GET', '/statuses', { token: bob });
  assert.deepStrictEqual(seen.body.statuses.map((s) => s.type), ['text', 'image']);
  assert.strictEqual((await api('POST', `/statuses/${text.body.status.id}/view`, { token: bob })).status, 204);
  const reply = await api('POST', `/statuses/${text.body.status.id}/replies`, { token: bob, body: { text: 'Hey!' } });
  assert.strictEqual(reply.body.message.statusReply.statusId, text.body.status.id);
  const mine = await api('GET', '/statuses', { token: alice });
  assert.deepStrictEqual(mine.body.statuses[0].views.map((v) => v.username), ['bob']);
  assert.strictEqual((await api('DELETE', `/statuses/${photo.body.status.id}`, { token: alice })).status, 204);
  assert.strictEqual((await api('DELETE', `/statuses/${photo.body.status.id}`, { token: alice })).status, 404);
});

test('api: rate limits, CORS and the OpenAPI document', async (t) => {
  const { api, store, base } = await setup(t, { rateLimit: { max: 3, authMax: 2, windowMs: 60000 } });
  const key = store.register('alice', 'pass') && store.createApiKey('alice', 'x').key;

  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await api('GET', '/me', { token: key })));
  assert.deepStrictEqual(statuses.map((r) => r.status), [200, 200, 200, 429]);
  assert.strictEqual(statuses[0].headers.get('ratelimit-limit'), '3');
  assert.strictEqual(statuses[3].body.error.code, 'rate_limited');
  assert.ok(Number(statuses[3].headers.get('retry-after')) > 0);

  const pre = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { Origin: 'https://crm.example', 'Access-Control-Request-Method': 'GET' } });
  assert.strictEqual(pre.status, 204);
  assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);

  const spec = await api('GET', '/openapi.json');
  assert.strictEqual(spec.status, 200);
  assert.strictEqual(spec.body.openapi, '3.1.0');
  for (const path of ['/conversations/{id}/messages', '/webhooks', '/statuses', '/api-keys']) assert.ok(spec.body.paths[path], path);
  assert.ok(spec.body.webhooks['message:new']);
  assert.match(spec.body.servers[0].url, /\/api\/v1$/);
  const docs = await fetch(`${base}/api/docs`);
  assert.match(await docs.text(), /swagger-ui/);
});

test('api: an API key also works for the real-time socket', async (t) => {
  const { store, socketFor } = await setup(t);
  store.register('alice', 'pass');
  const { key } = store.createApiKey('alice', 'bot');
  const s = await socketFor(key);
  const res = await new Promise((r) => s.emit('me', {}, r));
  assert.strictEqual(res.user.username, 'alice');
});

test('api: every route is documented in the OpenAPI spec, and vice versa', async (t) => {
  const { app } = await (async () => {
    const store = new Store({ file: null });
    const created = createApp({ store });
    t.after(() => { created.io.close(); created.server.close(); });
    return created;
  })();
  const layer = app._router.stack.find((l) => l.name === 'router' && l.regexp.test('/api/v1/health'));
  const routes = new Set();
  for (const l of layer.handle.stack) {
    if (!l.route) continue;
    for (const method of Object.keys(l.route.methods)) routes.add(`${method} ${l.route.path.replace(/:(\w+)/g, '{$1}')}`);
  }
  const { buildOpenApiSpec } = require('../server/openapi');
  const spec = buildOpenApiSpec({ serverUrl: 'http://x/api/v1', webhookEvents: Store.WEBHOOK_EVENTS });
  const documented = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) for (const m of Object.keys(methods)) documented.add(`${m} ${path}`);
  documented.add('get /openapi.json');
  assert.deepStrictEqual([...routes].filter((r) => !documented.has(r)), [], 'routes missing from the spec');
  assert.deepStrictEqual([...documented].filter((r) => !routes.has(r)), [], 'spec paths with no route');
});
