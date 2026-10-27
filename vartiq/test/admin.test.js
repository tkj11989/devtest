'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));
const ADMIN_PW = 'correct-horse-battery';

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const app = createApp({
    store,
    admin: { username: 'root', password: ADMIN_PW, ...(opts.admin || {}) },
    otp: { sender: async () => {}, resendMs: 0, exposeCodes: true },
    payments: { sandbox: true },
    translate: { sandbox: true },
    webhooks: { allowPrivate: true, retryDelaysMs: [] },
    ...(opts.app || {}),
  });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token, extra = {}) => {
    const s = connect(base, { auth: { token, appSession: 'x', ...extra }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  const raw = async (prefix, method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${prefix}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const api = (method, path, o) => raw('/api/v1', method, path, o);
  const admin = (method, path, o) => raw('/admin/api', method, path, o);
  const login = async (username = 'root', password = ADMIN_PW) => (await admin('POST', '/login', { body: { username, password } }));
  const adminToken = async () => (await login()).body.token;
  return { store, app, client, api, admin, login, adminToken, base };
}

test('admin sign-in: separate accounts, roles, rate limit, sessions', async (t) => {
  const { store, admin, login, adminToken } = await setup(t);
  store.register('alice', 'pass');
  // Not configured vs configured; users are not admins.
  assert.deepStrictEqual((await admin('GET', '/status')).body, { configured: true });
  assert.strictEqual((await admin('GET', '/overview')).status, 401);
  assert.strictEqual((await admin('GET', '/overview', { token: store.login('alice', 'pass').token })).status, 401, 'a user token is not an admin session');
  assert.strictEqual((await login('alice', 'pass')).status, 401);
  assert.strictEqual((await login('root', 'wrong')).body.error.code, 'invalid_credentials');

  const ok = await login();
  assert.deepStrictEqual([ok.status, ok.body.admin, ok.body.token.startsWith('adm_')], [200, { username: 'root', role: 'super' }, true]);
  const token = ok.body.token;
  assert.deepStrictEqual((await admin('GET', '/me', { token })).body.admin, { username: 'root', role: 'super', twoStep: false, limited: false });

  // Admins: create a support admin; support can look and moderate but not change settings or admins.
  assert.strictEqual((await admin('POST', '/admins', { token, body: { username: 'helper', password: 'short', role: 'support' } })).status, 400);
  assert.strictEqual((await admin('POST', '/admins', { token, body: { username: 'helper', password: 'helper-password-1', role: 'support' } })).status, 200);
  assert.strictEqual((await admin('POST', '/admins', { token, body: { username: 'helper', password: 'helper-password-1' } })).status, 409);
  const support = (await login('helper', 'helper-password-1')).body.token;
  assert.strictEqual((await admin('GET', '/overview', { token: support })).status, 200);
  for (const [m, p, b] of [['PUT', '/settings', { features: { calls: false } }], ['GET', '/admins'], ['POST', '/admins', { username: 'xx', password: 'longenough-1' }], ['POST', '/users/alice/premium', { days: 3 }]]) {
    assert.strictEqual((await admin(m, p, { token: support, body: b })).status, 403, `${m} ${p}`);
  }
  assert.strictEqual((await admin('POST', '/users/alice/suspend', { token: support, body: { reason: 'spam' } })).status, 200, 'support can moderate');

  // Constraints.
  assert.strictEqual((await admin('DELETE', '/admins/root', { token })).status, 400, 'not yourself');
  assert.strictEqual((await admin('DELETE', '/admins/helper', { token })).status, 204);
  assert.strictEqual((await admin('GET', '/overview', { token: support })).status, 401, 'removing an admin ends their sessions');

  // Password change: the current one is needed; other sessions end.
  const other = await adminToken();
  assert.strictEqual((await admin('POST', '/password', { token, body: { current: 'nope', password: 'brand-new-password' } })).status, 403);
  assert.strictEqual((await admin('POST', '/password', { token, body: { current: ADMIN_PW, password: 'brand-new-password' } })).status, 204);
  assert.strictEqual((await admin('GET', '/me', { token: other })).status, 401);
  assert.strictEqual((await admin('GET', '/me', { token })).status, 200);
  assert.strictEqual((await login('root', 'brand-new-password')).status, 200);

  // Logout.
  assert.strictEqual((await admin('POST', '/logout', { token })).status, 204);
  assert.strictEqual((await admin('GET', '/me', { token })).status, 401);
  // Hashes never leave.
  assert.ok(!JSON.stringify((await admin('GET', '/admins', { token: (await login('root', 'brand-new-password')).body.token })).body).includes('hash'));
});

test('admin sign-in: five wrong passwords lock further tries', async (t) => {
  const { admin, login } = await setup(t);
  for (let i = 0; i < 5; i++) assert.strictEqual((await login('root', `bad${i}`)).status, 401);
  assert.strictEqual((await login('root', ADMIN_PW)).status, 429, 'even the right password waits');
  assert.strictEqual((await admin('GET', '/status')).status, 200);
});

test('feature switches: blocked on the server for every client, announced live, data untouched', async (t) => {
  const { store, client, api, admin, adminToken } = await setup(t);
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  store.setLockCode('alice', '2468');
  const sa = await client(alice.token);
  const token = await adminToken();
  const cfg = async () => (await api('GET', '/config')).body;

  const before = await cfg();
  // Everything is on except the developer tools, which an administrator has to enable.
  assert.deepStrictEqual(Object.entries(before.features).filter(([, on]) => !on).map(([id]) => id), ['developerApi']);
  assert.strictEqual(before.maintenance.on, false);
  assert.ok(Object.keys(before.features).includes('channels') && Object.keys(before.features).includes('calls'));

  // Something that already exists keeps its data when its feature is switched off.
  const ch = (await call(sa, 'channel:create', { handle: 'news', name: 'News' })).channel;
  await call(sa, 'channel:post', { id: ch.id, text: 'hello' });
  const lockedBefore = await call(sa, 'chatlock:lock', { convId: dm.id });
  assert.ok(lockedBefore.ok);

  const update = next(sa, 'config:update');
  const off = await admin('PUT', '/settings', { token, body: { features: { channels: false, calls: false, status: false, chatLock: false, voiceMessages: false, groups: false, premium: false, translation: false, profileViews: false, business: false, catalogue: false, disappearing: false, hideChat: false, verification: false } } });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.changes.length, 14);
  const pushed = await update;
  assert.strictEqual(pushed.features.channels, false, 'connected apps hear about it at once');
  assert.strictEqual((await cfg()).features.calls, false, 'and mobile apps read it from /config');

  const blocked = [
    ['channel:create', { handle: 'other', name: 'x' }], ['channels:mine'], ['channel:post', { id: ch.id, text: 'x' }],
    ['status:post', { type: 'text', text: 'hi' }], ['group:create', { name: 'g', members: ['bob'] }],
    ['chatlock:lock', { convId: store.getOrCreateDirect('alice', 'bob').id }], ['hidden:hide', { convId: dm.id }],
    ['voice:send', { convId: dm.id, mime: 'audio/webm', data: Buffer.from('x') }], ['chat:disappearing', { convId: dm.id, seconds: 3600 }],
    ['translate:languages'], ['subscription:checkout', { plan: 'daily' }], ['kyc:start', { type: 'pan', idNumber: 'ABCDE1234F' }],
    ['profile:views'], ['profile:view', { username: 'bob' }], ['catalogue:get', { username: 'bob' }],
  ];
  // (chat lock is already on for this chat, so lock a different one)
  const dm2 = store.getOrCreateDirect('alice', 'bob');
  void dm2;
  for (const [ev, payload] of blocked) {
    const r = await call(sa, ev, payload);
    if (ev === 'chatlock:lock') continue; // already locked: allowed no-op is fine, tested below with a new chat
    assert.deepStrictEqual([ev, r.ok, r.code], [ev, false, 'feature_disabled'], ev);
  }
  assert.match((await call(sa, 'channels:mine')).error, /Public channels is turned off by the administrator/);
  assert.strictEqual((await api('GET', '/channels', { token: alice.token })).status, 403);
  assert.strictEqual((await api('POST', '/me/subscription/checkout', { token: alice.token, body: { plan: 'daily' } })).body.error.code, 'feature_disabled');

  // A new lock is refused, but protection can always be removed.
  const carol = store.register('carol', 'pass');
  const withCarol = store.getOrCreateDirect('alice', 'carol');
  assert.strictEqual((await call(sa, 'chatlock:lock', { convId: withCarol.id })).code, 'feature_disabled');
  assert.ok((await call(sa, 'chatlock:remove', { convId: dm.id, code: '2468' })).ok, 'removing a lock still works');
  assert.ok((await call(sa, 'chatlock:relock')).ok);
  // Turning things off (translation off, timers off) still works.
  assert.ok((await call(sa, 'translate:set', { convId: dm.id, lang: null })).ok);
  assert.ok((await call(sa, 'chat:disappearing', { convId: dm.id, seconds: 0 })).ok);
  // Normal messaging is untouched.
  assert.ok((await call(sa, 'message:send', { convId: dm.id, text: 'still works' })).ok);

  // Registration closed: new accounts refused, login unaffected.
  await admin('PUT', '/settings', { token, body: { features: { registration: false } } });
  const otp = await api('POST', '/auth/otp', { body: { purpose: 'register', phone: '+919811100001' } });
  assert.deepStrictEqual([otp.status, otp.body.error.code], [403, 'feature_disabled']);
  assert.strictEqual((await api('POST', '/auth/register', { body: { birthDate: '1990-05-17', displayName: 'X', phone: '+919811100001', phoneOtp: { requestId: 'a', code: '123456' } } })).status, 403);
  assert.strictEqual((await api('POST', '/auth/login', { body: { username: 'alice', password: 'pass' } })).status, 200);

  // Back on: everything works again, with the data that was there.
  await admin('PUT', '/settings', { token, body: { features: Object.fromEntries(Object.keys(before.features).map((k) => [k, true])) } });
  assert.strictEqual((await call(sa, 'channels:mine')).channels.length, 1);
  assert.strictEqual((await call(sa, 'channel:posts', { id: ch.id })).posts[0].text, 'hello');
  assert.ok((await call(sa, 'chatlock:lock', { convId: withCarol.id })).ok);
  void bob; void carol;
});

test('feature switches: calls and the developer API', async (t) => {
  const { store, client, api, admin, adminToken } = await setup(t);
  const alice = store.register('alice', 'pass');
  store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  const key = store.createApiKey('alice', 'bot').key;
  const sa = await client(alice.token);
  await client(store.register('bob2', 'pass').token); // the person being called is online
  store.getOrCreateDirect('alice', 'bob2');
  const token = await adminToken();
  const hits = [];
  const sink = require('http').createServer((req, res) => { hits.push(1); res.writeHead(204).end(); });
  await new Promise((r) => sink.listen(0, r));
  t.after(() => sink.close());
  store.createWebhook('alice', { url: `http://127.0.0.1:${sink.address().port}/h`, events: ['message:new'] });

  // Restricted by default: nothing works until an administrator switches the developer API on.
  assert.strictEqual((await api('GET', '/me', { token: key })).body.error.code, 'feature_disabled', 'API keys are refused by default');
  assert.strictEqual((await api('GET', '/api-keys', { token: alice.token })).status, 403);
  await admin('PUT', '/settings', { token, body: { features: { developerApi: true } } });
  assert.strictEqual((await api('GET', '/me', { token: key })).status, 200);
  assert.ok((await call(sa, 'call:start', { convId: store.getOrCreateDirect('alice', 'bob2').id, kind: 'audio' })).ok, 'calls work');
  await call(sa, 'call:end', {});
  await admin('PUT', '/settings', { token, body: { features: { calls: false, developerApi: false } } });
  const c = await call(sa, 'call:start', { convId: dm.id, kind: 'audio' });
  assert.deepStrictEqual([c.ok, c.code], [false, 'feature_disabled']);

  assert.strictEqual((await api('GET', '/me', { token: key })).body.error.code, 'feature_disabled', 'API keys stop working');
  assert.strictEqual((await api('GET', '/me', { token: alice.token })).status, 200, 'people are unaffected');
  assert.strictEqual((await api('GET', '/api-keys', { token: alice.token })).status, 403);
  assert.strictEqual((await api('POST', '/webhooks', { token: alice.token, body: { url: 'http://x.example/h' } })).status, 403);
  await call(sa, 'message:send', { convId: dm.id, text: 'hi' });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(hits.length, 0, 'webhooks are not delivered');
  await assert.rejects(client(key), /unauthorized/);
  await admin('PUT', '/settings', { token, body: { features: { developerApi: true } } });
  assert.strictEqual((await api('GET', '/me', { token: key })).status, 200);
});

test('maintenance mode and minimum app version', async (t) => {
  const { store, client, api, admin, adminToken, base } = await setup(t);
  const alice = store.register('alice', 'pass');
  const sa = await client(alice.token);
  const token = await adminToken();

  const bad = await admin('PUT', '/settings', { token, body: { maintenance: { message: '' } } });
  assert.strictEqual(bad.status, 400);
  const update = next(sa, 'config:update');
  await admin('PUT', '/settings', { token, body: { maintenance: { on: true, message: 'Upgrading the database' }, announcement: 'Sale!' } });
  assert.deepStrictEqual((await update).maintenance, { on: true, message: 'Upgrading the database' });

  // Everything for users stops; the config and the admin dashboard keep working.
  const me = await api('GET', '/me', { token: alice.token });
  assert.deepStrictEqual([me.status, me.body.error.code, me.body.error.message], [503, 'maintenance', 'Upgrading the database']);
  assert.strictEqual((await api('POST', '/auth/login', { body: { username: 'alice', password: 'pass' } })).status, 503);
  const sock = connect(base, { auth: { token: alice.token }, transports: ['websocket'], forceNew: true });
  const err = await new Promise((r) => { sock.once('connect_error', r); });
  sock.close();
  assert.deepStrictEqual([err.message, err.data.code, err.data.message], ['maintenance', 'maintenance', 'Upgrading the database']);
  assert.deepStrictEqual((await call(sa, 'conversations')).ok, false, 'connected apps are stopped too');
  const cfg = (await api('GET', '/config')).body;
  assert.deepStrictEqual([cfg.maintenance.on, cfg.announcement], [true, 'Sale!']);
  assert.strictEqual((await admin('GET', '/overview', { token })).status, 200);
  await admin('PUT', '/settings', { token, body: { maintenance: { on: false } } });
  assert.strictEqual((await api('GET', '/me', { token: alice.token })).status, 200);

  // Minimum version: older apps get 426 (REST header or socket auth); no header = web app = fine.
  await admin('PUT', '/settings', { token, body: { minClientVersion: '2.1.0' } });
  assert.strictEqual((await api('GET', '/me', { token: alice.token, headers: { 'X-Client-Version': '2.0.9' } })).status, 426);
  assert.strictEqual((await api('GET', '/me', { token: alice.token, headers: { 'X-Client-Version': '2.1.0' } })).status, 200);
  assert.strictEqual((await api('GET', '/me', { token: alice.token, headers: { 'X-Client-Version': '10.0' } })).status, 200);
  assert.strictEqual((await api('GET', '/me', { token: alice.token })).status, 200);
  const old = connect(base, { auth: { token: alice.token, clientVersion: '1.0.0' }, transports: ['websocket'], forceNew: true });
  assert.strictEqual((await new Promise((r) => old.once('connect_error', r))).data.code, 'update_required');
  old.close();
  assert.strictEqual((await admin('PUT', '/settings', { token, body: { minClientVersion: 'abc' } })).status, 400);
});

test('moderation: suspend, force logout, Premium, Verified, listing and stats', async (t) => {
  const { store, client, api, admin, adminToken } = await setup(t);
  const alice = store.register('alice', 'pass', 'Alice A');
  const bob = store.register('bob', 'pass');
  store.setContact('alice', 'sms', '+919800000001');
  store.setContact('bob', 'sms', '+919800000002');
  store.addMessage(store.getOrCreateDirect('alice', 'bob').id, 'bob', 'hi');
  const sa = await client(alice.token);
  const sb = await client(bob.token);
  const token = await adminToken();

  // Listing and stats.
  const list = await admin('GET', '/users?q=alice', { token });
  assert.deepStrictEqual(list.body.users.map((u) => [u.username, u.phone, u.chats]), [['alice', '+919800000001', 1]]);
  assert.strictEqual((await admin('GET', '/users?q=%2B91980000000', { token })).body.total, 2, 'search by phone');
  const all = await admin('GET', '/users?pageSize=1&page=2', { token });
  assert.deepStrictEqual([all.body.total, all.body.users.length, all.body.page], [2, 1, 2]);
  const stats = (await admin('GET', '/overview', { token })).body.stats;
  assert.deepStrictEqual([stats.users.total, stats.users.online, stats.users.newToday, stats.content.messages, stats.content.chats], [2, 2, 2, 1, 1]);
  assert.strictEqual(stats.series.signups.at(-1), 2);
  assert.strictEqual(stats.series.messages.at(-1), 1);
  assert.ok(!JSON.stringify(list.body).includes('hash') && !JSON.stringify(list.body).includes('salt'));

  // Premium and Verified by hand; peers see the badges live.
  const seen = next(sb, 'user:updated');
  const grant = await admin('POST', '/users/alice/premium', { token, body: { days: 30 } });
  assert.deepStrictEqual([grant.body.user.premium, grant.body.user.plan], [true, 'granted']);
  assert.strictEqual((await seen).user.premium, true);
  assert.strictEqual((await api('GET', '/users/alice', { token: bob.token })).body.user.premium, true);
  assert.strictEqual((await admin('POST', '/users/alice/premium', { token, body: { days: 0 } })).status, 400);
  assert.strictEqual((await admin('GET', '/users?filter=premium', { token })).body.total, 1);
  assert.strictEqual((await admin('POST', '/users/alice/premium', { token, body: { revoke: true } })).body.user.premium, false);
  assert.strictEqual((await admin('POST', '/users/alice/verified', { token, body: { verified: true } })).body.user.verified, true);
  assert.strictEqual((await api('GET', '/users/alice', { token: bob.token })).body.user.verified, true);
  assert.strictEqual((await admin('GET', '/users?filter=verified', { token })).body.total, 1);
  await admin('POST', '/users/alice/verified', { token, body: { verified: false } });
  assert.strictEqual((await admin('GET', '/users/nobody', { token })).status, 404);

  // Force logout ends sessions and sockets.
  const dropped = new Promise((r) => sb.once('disconnect', r));
  assert.strictEqual((await admin('POST', '/users/bob/logout', { token })).status, 200);
  await dropped;
  assert.strictEqual((await api('GET', '/me', { token: bob.token })).status, 401);
  assert.ok(store.login('bob', 'pass').token, 'they can sign in again');

  // Suspend: sessions, sockets and logins stop; unsuspend restores.
  const gone = new Promise((r) => sa.once('disconnect', r));
  const sus = await admin('POST', '/users/alice/suspend', { token, body: { reason: 'Spamming channels' } });
  assert.deepStrictEqual([sus.body.user.suspended.reason, sus.body.user.suspended.by], ['Spamming channels', 'root']);
  await gone;
  assert.strictEqual((await api('GET', '/me', { token: alice.token })).status, 401);
  const login = await api('POST', '/auth/login', { body: { username: 'alice', password: 'pass' } });
  assert.strictEqual(login.status, 403, 'password login');
  assert.match(login.body.error.message, /suspended: Spamming channels/);
  const key = store.createApiKey('alice', 'k').key;
  assert.strictEqual((await api('GET', '/me', { token: key })).status, 401, 'API keys stop too');
  assert.strictEqual((await admin('GET', '/users?filter=suspended', { token })).body.total, 1);
  await admin('POST', '/users/alice/unsuspend', { token });
  assert.strictEqual((await api('POST', '/auth/login', { body: { username: 'alice', password: 'pass' } })).status, 200);
});

test('moderation of channels and reports; settings: limits and prices; audit log', async (t) => {
  const { store, client, api, admin, adminToken } = await setup(t);
  const owner = store.register('owner', 'pass');
  const fan = store.register('fanfan', 'pass');
  const sFan = await client(fan.token);
  const ch = store.createChannel('owner', { handle: 'spammy', name: 'Spammy' });
  store.followChannel('fanfan', ch.id);
  store.postToChannel('owner', ch.id, 'buy now');
  store.reportChannel('fanfan', ch.id, 'Spam');
  const token = await adminToken();

  const chans = await admin('GET', '/channels?q=spam', { token });
  assert.deepStrictEqual(chans.body.channels.map((c) => [c.handle, c.followers, c.posts, c.reports]), [['spammy', 2, 1, 1]]);
  const reports = await admin('GET', '/reports', { token });
  assert.deepStrictEqual(reports.body.reports.map((r) => [r.reporter, r.reason, r.channel.handle]), [['fanfan', 'Spam', 'spammy']]);
  assert.strictEqual((await admin('POST', '/reports/dismiss', { token, body: { channelId: 'nope' } })).status, 404);
  const gone = next(sFan, 'channel:deleted');
  assert.strictEqual((await admin('DELETE', `/channels/${ch.id}`, { token })).status, 204);
  assert.strictEqual((await gone).id, ch.id, 'followers are told');
  assert.strictEqual((await admin('GET', '/reports', { token })).body.reports.length, 0);
  const ch2 = store.createChannel('owner', { handle: 'fine', name: 'Fine' });
  store.reportChannel('fanfan', ch2.id, 'Not liking it');
  assert.strictEqual((await admin('POST', '/reports/dismiss', { token, body: { channelId: ch2.id } })).status, 204);
  assert.strictEqual(store.data.channels[ch2.id].handle, 'fine', 'dismissing keeps the channel');

  // Limits take effect at once; premium is unaffected.
  store.createChannel('owner', { handle: 'c3x', name: 'C3' });
  const lim = await admin('PUT', '/settings', { token, body: { limits: { freeChatLocks: 1, freeHiddenChats: 0, channelsPerOwner: 2 } } });
  assert.deepStrictEqual(lim.body.settings.limits, { freeChatLocks: 1, freeHiddenChats: 0, channelsPerOwner: 2, catalogueMax: 100, minAge: 8, freeProfilePhotos: 2, premiumProfilePhotos: 5, freePollOptions: 6, premiumPollOptions: 12 });
  assert.strictEqual((await api('POST', '/channels', { token: owner.token, body: { handle: 'c4x', name: 'C4' } })).body.error.code, 'limit_reached');
  store.register('b1x', 'pass'); store.register('b2x', 'pass');
  store.setLockCode('fanfan', '2468');
  const sub = (await api('GET', '/me/subscription', { token: fan.token })).body;
  assert.deepStrictEqual(sub.limits.free, { chatLocks: 1, hiddenChats: 0 });
  const s = await client(fan.token);
  const c1 = store.getOrCreateDirect('fanfan', 'b1x');
  const c2 = store.getOrCreateDirect('fanfan', 'b2x');
  assert.ok((await call(s, 'chatlock:lock', { convId: c1.id })).ok);
  const over = await call(s, 'chatlock:lock', { convId: c2.id });
  assert.deepStrictEqual([over.code, /lock up to 1 chat\./.test(over.error)], ['premium_required', true]);
  assert.strictEqual((await call(s, 'hidden:hide', { convId: c2.id })).code, 'premium_required');
  assert.strictEqual((await admin('PUT', '/settings', { token, body: { limits: { freeChatLocks: -1 } } })).status, 400);
  assert.strictEqual((await admin('PUT', '/settings', { token, body: { limits: { bogus: 1 } } })).status, 400);
  assert.strictEqual((await admin('PUT', '/settings', { token, body: { features: { bogus: true } } })).status, 400);
  assert.strictEqual((await admin('PUT', '/settings', { token, body: { features: { calls: 'no' } } })).status, 400);

  // Prices: override, then back to default.
  await admin('PUT', '/settings', { token, body: { prices: { monthly: 149.5 } } });
  assert.deepStrictEqual((await api('GET', '/me/subscription', { token: fan.token })).body.plans.map((p) => [p.id, p.price]), [['daily', 9], ['monthly', 149.5], ['quarterly', 279], ['halfyearly', 529], ['yearly', 999]]);
  const order = (await api('POST', '/me/subscription/checkout', { token: fan.token, body: { plan: 'monthly' } })).body;
  assert.strictEqual(order.amount, 149.5);
  await admin('PUT', '/settings', { token, body: { prices: { monthly: null } } });
  assert.strictEqual((await api('GET', '/me/subscription', { token: fan.token })).body.plans[1].price, 99);
  assert.strictEqual((await admin('PUT', '/settings', { token, body: { prices: { monthly: -5 } } })).status, 400);

  // Every change is in the audit log (newest first), with who and what.
  const audit = (await admin('GET', '/audit', { token })).body.entries;
  assert.strictEqual(audit[0].admin, 'root');
  const text = audit.map((e) => `${e.action} ${e.target || ''} ${e.detail || ''}`).join('\n');
  assert.match(text, /channel-delete @spammy/);
  assert.match(text, /settings.*limit freeChatLocks: 3 → 1/);
  assert.match(text, /price monthly: 99\.\.\.|price monthly: undefined → 149\.5|price monthly/);
  assert.match(text, /login/);
});
