'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const sha = (n) => crypto.createHash('sha256').update(n).digest('hex');

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const people = {};
  const phones = { meg: '+919800000001', asha: '+919800000002', ravi: '+919800000003', mina: '+919800000004', kid: '+919800000005', gone: '+919800000006', foe: '+919800000007' };
  for (const [name, phone] of Object.entries(phones)) {
    const r = store.register(name, 'pass', name[0].toUpperCase() + name.slice(1));
    store.setContact(name, 'sms', phone);
    const s = connect(base, { auth: { token: r.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((res) => s.once('connect', res));
    people[name] = { token: r.token, s };
  }
  const rest = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, people, phones, rest };
}

test('matching: the app sends fingerprints, gets back the accounts, never the numbers; nothing sent is kept', async (t) => {
  const { store, people, phones } = await setup(t);
  const stranger = '+919811112222';
  const res = await call(people.meg.s, 'contacts:match', { hashes: [sha(phones.asha), sha(phones.ravi), sha(stranger), sha(phones.meg)] });
  assert.ok(res.ok, res.error);
  assert.deepStrictEqual(res.matches.map((m) => [m.user.username, m.hash === sha(phones[m.user.username])]).sort(), [['asha', true], ['ravi', true]], 'yourself and unknown numbers are left out');
  assert.strictEqual(res.checked, 4);
  assert.ok(!JSON.stringify(res).includes('+9198'), 'no phone number comes back');
  assert.ok(!('phone' in res.matches[0].user), 'only the public view');
  assert.ok(!JSON.stringify(store.data).includes(sha(stranger)), 'a fingerprint that matched nobody is not stored anywhere');
  assert.strictEqual(res.matches[0].chatting, false);
  store.getOrCreateDirect('meg', 'asha');
  const again = await call(people.meg.s, 'contacts:match', { hashes: [sha(phones.asha)] });
  assert.strictEqual(again.matches[0].chatting, true, 'already chatting with them');
  // upper-case hex and repeats are fine
  assert.strictEqual((await call(people.meg.s, 'contacts:match', { hashes: [sha(phones.asha).toUpperCase(), sha(phones.asha)] })).matches.length, 1);
});

test('privacy: people who opt out, are blocked either way, deleted, or kept from new people by a guardian are not found', async (t) => {
  const { store, people, phones } = await setup(t);
  const all = Object.values(phones).map(sha);
  const names = async () => (await call(people.meg.s, 'contacts:match', { hashes: all })).matches.map((m) => m.user.username).sort();
  assert.deepStrictEqual(await names(), ['asha', 'foe', 'gone', 'kid', 'mina', 'ravi']);

  assert.deepStrictEqual((await call(people.asha.s, 'privacy:findable', { byPhone: false })), { ok: true, findableByPhone: false });
  assert.strictEqual((await call(people.asha.s, 'me', {})).privacy.findableByPhone, false);
  assert.ok(!(await names()).includes('asha'), 'turned off');

  await call(people.meg.s, 'user:block', { username: 'ravi', blocked: true });
  await call(people.foe.s, 'user:block', { username: 'meg', blocked: true });
  store.data.users.gone.deletedAt = Date.now();
  store.minorBlocks = (u, control) => u === 'kid' && control === 'discoverable';
  assert.deepStrictEqual(await names(), ['mina'], 'blocked by me, blocking me, deleted, a child kept from new people');
  store.getOrCreateDirect('meg', 'kid');
  assert.deepStrictEqual(await names(), ['kid', 'mina'], 'a child I already chat with is not a new person');
  assert.strictEqual((await call(people.meg.s, 'privacy:findable', { byPhone: 'yes' })).code, 'invalid_request');
  await call(people.asha.s, 'privacy:findable', { byPhone: true });
  assert.ok((await names()).includes('asha'));
});

test('limits and checks: well-formed fingerprints only, 1000 a call, 20 calls and 5000 numbers a day, and an administrator switch', async (t) => {
  const { store, people, phones, rest } = await setup(t);
  const bad = (hashes) => call(people.meg.s, 'contacts:match', { hashes });
  assert.strictEqual((await bad([])).code, 'invalid_request');
  assert.strictEqual((await bad('nope')).code, 'invalid_request');
  assert.strictEqual((await bad([phones.asha])).code, 'invalid_request', 'a number, not a fingerprint');
  assert.strictEqual((await bad([sha('x').slice(1)])).code, 'invalid_request');
  assert.strictEqual((await bad(Array.from({ length: 1001 }, (_, i) => sha(String(i))))).code, 'too_many');

  const batch = (from, n) => Array.from({ length: n }, (_, i) => sha(`+9190${String(from + i).padStart(8, '0')}`));
  for (let i = 0; i < 5; i++) assert.ok((await bad(batch(i * 1000, 1000))).ok);
  const over = await bad(batch(9000, 5));
  assert.deepStrictEqual([over.ok, over.code], [false, 'contact_limit'], '5000 numbers a day');
  // The allowance starts again the next day.
  store.data.users.meg.contactSync.day = '2000-01-01';
  assert.ok((await bad(batch(0, 5))).ok);
  // 20 calls a day.
  const other = people.mina;
  for (let i = 0; i < 20; i++) assert.ok((await call(other.s, 'contacts:match', { hashes: [sha(phones.asha)] })).ok);
  assert.strictEqual((await call(other.s, 'contacts:match', { hashes: [sha(phones.asha)] })).code, 'contact_limit');

  // Over HTTP, and the switch.
  const viaRest = await rest(people.ravi.token, 'POST', '/contacts/match', { hashes: [sha(phones.asha)] });
  assert.deepStrictEqual([viaRest.status, viaRest.body.matches[0].user.username], [200, 'asha']);
  assert.strictEqual((await rest(people.ravi.token, 'PUT', '/me/privacy/findable', { byPhone: false })).status, 200);
  store.updateSettings({ features: { contactDiscovery: false } });
  assert.strictEqual((await rest(people.foe.token, 'POST', '/contacts/match', { hashes: [sha(phones.asha)] })).status, 403);
});
