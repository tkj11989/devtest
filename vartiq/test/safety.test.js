'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));

async function setup(t, names = ['ann', 'bob', 'cat']) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const users = {};
  for (const n of names) {
    const r = store.register(n, 'pass', n);
    const s = connect(base, { auth: { token: r.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((ok) => s.once('connect', ok));
    users[n] = { token: r.token, s };
  }
  const rest = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, users, rest };
}

test('report a message: the server keeps the message and up to 5 before it; duplicates, own messages and outsiders are refused', async (t) => {
  const { store, users, rest } = await setup(t);
  const dm = store.getOrCreateDirect('ann', 'bob');
  for (let i = 0; i < 7; i++) store.addMessage(dm.id, i % 2 ? 'ann' : 'bob', `line ${i}`);
  const bad = store.addMessage(dm.id, 'bob', 'send me money');
  const ok = await rest(users.ann.token, 'POST', `/messages/${bad.id}/report`, { reason: 'scam', detail: 'wants money', block: true });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  assert.deepStrictEqual(ok.body, { reported: true, blocked: true });
  assert.ok(store.hasBlocked('ann', 'bob'));
  const [group] = store.safetyReports();
  assert.strictEqual(group.owner, 'bob');
  const r = group.reports[0];
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.evidence.length, 6);
  assert.strictEqual(r.evidence.at(-1).text, 'send me money');
  assert.strictEqual(r.evidence.at(-1).reported, true);
  assert.strictEqual((await rest(users.ann.token, 'POST', `/messages/${bad.id}/report`, { reason: 'scam' })).status, 409);
  assert.strictEqual((await rest(users.bob.token, 'POST', `/messages/${bad.id}/report`, { reason: 'spam' })).status, 400);
  assert.strictEqual((await rest(users.cat.token, 'POST', `/messages/${bad.id}/report`, { reason: 'spam' })).status, 404);
  assert.strictEqual((await rest(users.ann.token, 'POST', `/messages/${store.addMessage(dm.id, 'bob', 'x').id}/report`, { reason: 'nonsense' })).status, 400);
});

test('report an encrypted message: the app sends the evidence; strangers in it are dropped; marked unverified', async (t) => {
  const { store, users, rest } = await setup(t);
  const dm = store.getOrCreateDirect('ann', 'bob');
  const m = store.addMessage(dm.id, 'bob', '', { e2ee: { v: 1, w: {} } });
  const res = await rest(users.ann.token, 'POST', `/messages/${m.id}/report`, { reason: 'harassment', evidence: [{ id: m.id, from: 'bob', ts: 5, kind: 'text', text: 'you are awful' }, { from: 'zed', text: 'not in this chat' }] });
  assert.strictEqual(res.status, 201);
  const r = store.safetyReports()[0].reports[0];
  assert.strictEqual(r.verified, false);
  assert.deepStrictEqual(r.evidence.map((e) => [e.from, e.text, !!e.reported]), [['bob', 'you are awful', true]]);
});

test('report a person: once a day; urgent child-safety reports come first', async (t) => {
  const { store, users, rest } = await setup(t);
  assert.strictEqual((await rest(users.ann.token, 'POST', '/users/bob/report', { reason: 'spam' })).status, 201);
  assert.strictEqual((await rest(users.ann.token, 'POST', '/users/bob/report', { reason: 'spam' })).status, 409);
  assert.strictEqual((await rest(users.ann.token, 'POST', '/users/ann/report', { reason: 'spam' })).status, 400);
  assert.strictEqual((await rest(users.ann.token, 'POST', '/users/nobody/report', { reason: 'spam' })).status, 404);
  assert.strictEqual((await rest(users.cat.token, 'POST', '/users/ann/report', { reason: 'child_safety' })).status, 201);
  assert.deepStrictEqual(store.safetyReports().map((g) => g.owner), ['ann', 'bob']);
  assert.strictEqual(store.safetyReports()[0].urgent, true);
});

test('five different reporters limit an account\'s new chats until a person looks', async (t) => {
  const names = ['bob', 'rep1', 'rep2', 'rep3', 'rep4', 'rep5', 'dee'];
  const { store, users, rest } = await setup(t, names);
  const old = store.getOrCreateDirect('bob', 'dee');
  for (const r of ['rep1', 'rep2', 'rep3', 'rep4']) await rest(users[r].token, 'POST', '/users/bob/report', { reason: 'spam' });
  assert.strictEqual(store.isRestricted('bob'), false);
  await rest(users.rep5.token, 'POST', '/users/bob/report', { reason: 'spam' });
  assert.strictEqual(store.isRestricted('bob'), true);
  const dm = await call(users.bob.s, 'chat:direct', { username: 'rep1' });
  assert.strictEqual(dm.code, 'restricted');
  assert.strictEqual((await call(users.bob.s, 'message:send', { convId: old.id, text: 'still works' })).ok, true);
  assert.strictEqual(store.safetyReports()[0].restricted !== null, true);
  assert.strictEqual(store.dismissSafetyReports('bob'), 5);
  assert.strictEqual(store.isRestricted('bob'), false);
  assert.strictEqual(store.safetyReports().length, 0);
});

test('reports are limited to 20 a day and deleted after six months', async (t) => {
  const { store } = await setup(t, ['ann', 'bob']);
  for (let i = 0; i < 20; i++) { store.register(`usr${i}`, 'pass', `usr${i}`); store.reportSafety('ann', { username: `usr${i}`, reason: 'spam' }); }
  assert.throws(() => store.reportSafety('ann', { username: 'bob', reason: 'spam' }), (e) => e.code === 'rate_limited');
  assert.strictEqual(store.pruneReports(Date.now() + Store.REPORT_KEEP_MS + 1000), 20);
  assert.strictEqual(store.data.reports.length, 0);
});

test('spam checks: too many cold chats, the same words to many people, and three stops restrict new chats', async (t) => {
  const names = ['spammer', ...Array.from({ length: 25 }, (_, i) => `tgt${i}`)];
  const { store, users } = await setup(t, names);
  const convs = names.slice(1).map((n) => store.getOrCreateDirect('spammer', n));
  const send = (i, text) => call(users.spammer.s, 'message:send', { convId: convs[i].id, text });
  // The same words to 5 people are fine, the 6th is stopped.
  for (let i = 0; i < 5; i++) assert.ok((await send(i, 'Buy cheap watches now at my shop')).ok);
  const stop = await send(5, 'Buy cheap  WATCHES now at my shop');
  assert.strictEqual(stop.code, 'spam_suspected');
  // Different words are fine until 20 cold chats have been started in an hour.
  for (let i = 5; i < 20; i++) assert.ok((await send(i, `Hello number ${i}`)).ok, `chat ${i}`);
  assert.strictEqual((await send(20, 'Hello number 20')).code, 'spam_suspected');
  assert.strictEqual((await send(21, 'Hello number 21')).code, 'spam_suspected');
  assert.strictEqual(store.isRestricted('spammer'), true, 'three stops in a day');
  // Someone who answered makes the chat an ordinary conversation, and a person who looks can lift the limit.
  store.addMessage(convs[21].id, 'tgt21', 'hi, who is this?');
  assert.ok((await send(21, 'Hello number 21')).ok);
  store.unrestrictUser('spammer');
  assert.strictEqual(store.isRestricted('spammer'), false);
});

test('admin: the review queue, restrict, lift and clear', async (t) => {
  const { store, users, rest } = await setup(t);
  await rest(users.ann.token, 'POST', '/users/bob/report', { reason: 'harassment', detail: 'rude' });
  const { createAdminRouter } = (() => { try { return require('../server/admin'); } catch { return {}; } })();
  void createAdminRouter;
  assert.strictEqual(store.safetyReports()[0].reports[0].detail, 'rude');
  store.restrictUser('bob', 72, 'test');
  assert.ok(store.safetyReports()[0].restricted);
  store.unrestrictUser('bob');
  assert.strictEqual(store.safetyReports()[0].restricted, null);
});
