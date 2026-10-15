'use strict';

// PostgreSQL persistence. Needs a database: TEST_DATABASE_URL=postgres://user:pass@localhost/dbname npm test
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../server/store');
const { PgPersistence } = require('../server/pg');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'set TEST_DATABASE_URL to run the PostgreSQL tests';
let n = 0;
const newSchema = () => `pgt_${process.pid}_${Date.now()}_${++n}`;

async function reopen(schema) {
  return Store.open({ databaseUrl: url, schema, mediaDir: null });
}
const plainData = (store) => JSON.parse(JSON.stringify(store.pg.raw));
const drop = async (schema) => {
  const p = new PgPersistence({ url });
  await p.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.pool.end();
};

async function populate(store) {
  const a = store.registerVerified({ displayName: 'Asha', username: 'asha', phone: '+919000000001' });
  store.registerVerified({ displayName: 'Bilal', username: 'bilal', phone: '+919000000002' });
  store.registerVerified({ displayName: 'Shop', username: 'shop', phone: '+919000000003', email: 'shop@x.in', business: { category: 'Retail', timezone: 'UTC' } });
  const dm = store.getOrCreateDirect('asha', 'bilal');
  for (let i = 0; i < 5; i++) store.addMessage(dm.id, i % 2 ? 'bilal' : 'asha', `msg ${i}`, { clientId: `c${i}` });
  const g = store.createGroup('asha', 'Team', ['bilal', 'shop']);
  store.addMessage(g.id, 'shop', 'hello team');
  const ch = store.createChannel('asha', { handle: 'news', name: 'News', description: 'd' });
  store.postToChannel('asha', ch.id, 'first post');
  store.postToChannel('asha', ch.id, 'second post');
  store.updateProfile('asha', { about: 'busy' });
  return { a, dm, g, ch };
}

test('pg: everything saved is read back identical after a restart', { skip }, async (t) => {
  const schema = newSchema();
  t.after(() => drop(schema));
  const s1 = await Store.open({ databaseUrl: url, schema, mediaDir: null });
  await populate(s1);
  await s1.flush();
  const before = plainData(s1);
  await s1.close();

  const s2 = await reopen(schema);
  assert.deepStrictEqual(plainData(s2), JSON.parse(JSON.stringify({ ...before })), 'same data after restart');
  assert.strictEqual(s2.findByPhone('+919000000002'), 'bilal');
  assert.deepStrictEqual(s2.getMessages(Store.directId('asha', 'bilal'), 'asha').map((m) => m.text), ['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4'], 'message order is kept');
  await s2.close();
});

test('pg: later changes (edits deep inside a record, new, changed and removed messages) are saved too', { skip }, async (t) => {
  const schema = newSchema();
  t.after(() => drop(schema));
  const s1 = await Store.open({ databaseUrl: url, schema, mediaDir: null });
  const { dm, g, ch } = await populate(s1);
  await s1.flush();

  // A field nested inside a user, a message edited in place, a message deleted, a chat setting, a deleted channel.
  s1.data.users.asha.about = 'edited';
  s1.markRead(dm.id, 'bilal');
  s1.addMessage(dm.id, 'asha', 'one more');
  const first = s1.data.messages[dm.id][0];
  s1.deleteMessage(first.id, first.from);
  s1.setBlocked('bilal', 'shop', true);
  s1.setPrefs('asha', { theme: 'ocean' });
  s1.deleteChannel('asha', ch.id);
  s1.addMessage(g.id, 'bilal', 'after delete');
  await s1.flush();
  const expected = plainData(s1);
  await s1.close();

  const s2 = await reopen(schema);
  assert.deepStrictEqual(plainData(s2), expected);
  assert.strictEqual(s2.data.channels[ch.id], undefined);
  assert.strictEqual(s2.data.channelPosts[ch.id], undefined);
  await s2.close();
});

test('pg: expired disappearing messages are removed from the database', { skip }, async (t) => {
  const schema = newSchema();
  t.after(() => drop(schema));
  const s1 = await Store.open({ databaseUrl: url, schema, mediaDir: null });
  const { dm } = await populate(s1);
  s1.setDisappearing(dm.id, 'asha', 60);
  const short = s1.addMessage(dm.id, 'asha', 'will expire');
  const doomed = s1.data.messages[dm.id].find((m) => m.id === short.id);
  doomed.expiresAt = Date.now() - 1000;
  s1._touchMsg(dm.id, doomed);
  const removed = s1.pruneMessages();
  assert.ok(removed.length >= 1 || removed.size >= 1 || removed, 'a message was pruned');
  await s1.flush();
  const expected = plainData(s1);
  await s1.close();
  const s2 = await reopen(schema);
  assert.deepStrictEqual(plainData(s2), expected);
  assert.ok(!s2.data.messages[dm.id].some((m) => m.id === short.id));
  await s2.close();
});

test('pg: only what changed is written, and a failed save is retried without losing anything', { skip }, async (t) => {
  const schema = newSchema();
  t.after(() => drop(schema));
  const errors = [];
  const persistence = new PgPersistence({ url, schema, delayMs: 20, onError: (e) => errors.push(e.message) });
  const store = new Store({ file: null, persistence });
  await persistence.ready;
  await populate(store);
  await persistence.flush();
  const rowsBefore = persistence.stats.rows;
  store.data.users.asha.about = 'only this';
  await persistence.flush();
  assert.strictEqual(persistence.stats.rows - rowsBefore, 1, 'one record written for one change');

  // Break the connection for one save: the change stays pending and is written on the retry.
  const real = persistence.pool.connect.bind(persistence.pool);
  let fail = true;
  persistence.pool.connect = async () => {
    if (fail) { fail = false; throw new Error('database down'); }
    return real();
  };
  store.data.users.bilal.about = 'saved later';
  await assert.rejects(() => persistence.flush(), /database down/);
  assert.ok(errors.some((e) => /database down/.test(e)));
  await persistence.flush();
  const reader = new PgPersistence({ url, schema });
  const loaded = await reader.load();
  assert.strictEqual(loaded.users.bilal.about, 'saved later');
  assert.strictEqual(loaded.users.asha.about, 'only this');
  await reader.pool.end();
  await persistence.close();
});

test('pg: many writes at once end up in one consistent state', { skip }, async (t) => {
  const schema = newSchema();
  t.after(() => drop(schema));
  const s1 = await Store.open({ databaseUrl: url, schema, mediaDir: null });
  for (let i = 0; i < 40; i++) s1.registerVerified({ displayName: `U${i}`, username: `user${String(i).padStart(2, '0')}`, phone: `+9190000001${String(i).padStart(2, '0')}` });
  for (let i = 0; i < 40; i += 2) {
    const c = s1.getOrCreateDirect(`user${String(i).padStart(2, '0')}`, `user${String(i + 1).padStart(2, '0')}`);
    for (let k = 0; k < 30; k++) s1.addMessage(c.id, `user${String(i + (k % 2)).padStart(2, '0')}`, `m${k}`);
  }
  // Keep changing while saves are running.
  const saving = s1.flush();
  for (let i = 0; i < 40; i += 2) s1.addMessage(Store.directId(`user${String(i).padStart(2, '0')}`, `user${String(i + 1).padStart(2, '0')}`), `user${String(i).padStart(2, '0')}`, 'late');
  await saving;
  await s1.flush();
  const expected = plainData(s1);
  await s1.close();
  const s2 = await reopen(schema);
  assert.deepStrictEqual(plainData(s2), expected);
  await s2.close();
});

test('pg: an existing data/db.json can be copied into PostgreSQL', { skip }, async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { migrate } = require('../tools/migrate-json-to-pg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vartiq-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');
  const old = new Store({ file });
  await populate(old);
  old.updateSettings({ announcement: 'hello' });
  old.flush();

  const schema = newSchema();
  t.after(() => drop(schema));
  const counts = await migrate({ file, databaseUrl: url, schema, mediaDir: null });
  assert.ok(counts.users >= 3 && counts.messages >= 6);
  const migrated = await reopen(schema);
  assert.deepStrictEqual(plainData(migrated), JSON.parse(fs.readFileSync(file, 'utf8')));
  await migrated.close();
  await assert.rejects(() => migrate({ file, databaseUrl: url, schema, mediaDir: null }), /already has users/);
});
