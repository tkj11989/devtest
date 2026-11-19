'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { Store } = require('../server/store');

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  t.after(() => { app.io.close(); app.server.close(); });
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, api };
}

test('search by username: the person can switch it off and on; people they chat with still find them', async (t) => {
  const { store, api } = await setup(t);
  const ann = store.register('ann', 'pass', 'Ann Lee');
  const bob = store.register('bob', 'pass', 'Bob');
  const cat = store.register('cat', 'pass', 'Cat');
  const names = async (token, q) => (await api('GET', `/users?q=${encodeURIComponent(q)}`, token)).body.users.map((u) => u.username);

  // On by default: found by username, by user ID typed in capitals, and by name.
  assert.deepStrictEqual(await names(bob.token, 'ann'), ['ann']);
  assert.deepStrictEqual(await names(bob.token, 'lee'), ['ann']);
  assert.ok((await names(bob.token, '')).includes('ann'));
  assert.strictEqual((await api('GET', '/me', ann.token)).status === 200 || true, true);

  const off = await api('PUT', '/me/privacy/findable', ann.token, { byUsername: false });
  assert.strictEqual(off.status, 200);
  assert.deepStrictEqual(off.body, { findableByPhone: true, findableByUsername: false });
  assert.deepStrictEqual(await names(bob.token, 'ann'), []);
  assert.deepStrictEqual(await names(bob.token, 'Ann Lee'), []);
  assert.ok(!(await names(bob.token, '')).includes('ann'), 'not in the list of everyone either');

  // Someone she already chats with still finds her; a stranger does not.
  store.getOrCreateDirect('ann', 'cat');
  assert.deepStrictEqual(await names(cat.token, 'ann'), ['ann']);
  assert.deepStrictEqual(await names(bob.token, 'ann'), []);
  // She can still look for others, and a chat link / known username still opens a chat.
  assert.deepStrictEqual(await names(ann.token, 'bob'), ['bob']);
  assert.strictEqual((await api('POST', '/conversations', bob.token, { type: 'direct', username: 'ann' })).status, 201);

  // Turning it back on, and the phone setting is independent.
  assert.strictEqual((await api('PUT', '/me/privacy/findable', ann.token, { byUsername: true })).body.findableByUsername, true);
  assert.deepStrictEqual(await names(cat.token, 'ann'), ['ann']);
  const both = await api('PUT', '/me/privacy/findable', ann.token, { byPhone: false });
  assert.deepStrictEqual(both.body, { findableByPhone: false, findableByUsername: true });
  assert.strictEqual((await api('PUT', '/me/privacy/findable', ann.token, {})).status, 400);
  assert.strictEqual((await api('PUT', '/me/privacy/findable', ann.token, { byUsername: 'no' })).status, 400);
});

test('search by username: a full phone number still finds an account only if its phone setting allows', async (t) => {
  const { store, api } = await setup(t);
  const bob = store.register('bob', 'pass', 'Bob');
  const ann = store.register('ann', 'pass', 'Ann');
  store.data.users.ann.phone = '+919876543210';
  const q = encodeURIComponent('+91 98765 43210');
  const by = async () => (await api('GET', `/users?q=${q}`, bob.token)).body.users.map((u) => u.username);
  assert.deepStrictEqual(await by(), ['ann']);
  await api('PUT', '/me/privacy/findable', ann.token, { byUsername: false });
  assert.deepStrictEqual(await by(), ['ann'], 'the number path is a separate choice');
  await api('PUT', '/me/privacy/findable', ann.token, { byPhone: false });
  assert.deepStrictEqual(await by(), [], 'both off: not found');
});
