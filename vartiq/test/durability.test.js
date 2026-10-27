'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { Store } = require('../server/store');

test('durability: a message is on disk by the time the sender is told it was sent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-dur-'));
  const file = path.join(dir, 'db.json');
  const store = new Store({ file });
  const app = createApp({ store, otp: { sender: async () => {} } });
  await new Promise((r) => app.server.listen(0, r));
  t.after(() => { app.io.close(); app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://localhost:${app.server.address().port}/api/v1`;
  const a = store.register('alice', 'pass');
  store.register('bob', 'pass');
  const conv = store.getOrCreateDirect('alice', 'bob');
  const res = await fetch(`${base}/conversations/${conv.id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'must survive a crash' }) });
  assert.strictEqual(res.status, 201);
  // No waiting: a hard kill right now must not lose it.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.messages[conv.id].some((m) => m.text === 'must survive a crash'), 'the acknowledged message is already in the file');
});

test('durability: DURABLE_ACK=0 acknowledges before saving; a failed save is reported, not hidden', async () => {
  const store = new Store({ file: null });
  store.durableAck = true;
  store.pg = { timer: 1, running: null, flush: async () => { throw new Error('database down'); } };
  await assert.rejects(store.whenSaved(), { code: 'storage_unavailable', status: 503 });
  store.durableAck = false;
  await store.whenSaved(); // returns at once
});
