'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const E2EE = require('../public/e2ee');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const make = async (n) => {
    const r = store.register(n, 'pass', n);
    const s = connect(base, { auth: { token: r.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((ok) => s.once('connect', ok));
    return { token: r.token, s };
  };
  const raw = (token, method, path, body, headers = {}) => fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  return { store, make, raw };
}

test('backup: save, replace, download, status, delete; only my own; size limit', async (t) => {
  const { store, make, raw } = await setup(t);
  const ann = await make('ann');
  const bob = await make('bob');
  assert.strictEqual((await call(ann.s, 'backup:status')).backup, null);
  assert.strictEqual((await raw(ann.token, 'GET', '/backup/file')).status, 404);
  const file1 = Buffer.from('first locked file');
  const put = await raw(ann.token, 'PUT', '/backup/file', file1, { 'Content-Type': 'application/octet-stream', 'X-Backup-Messages': '42', 'X-Backup-Device': 'Pixel' });
  assert.strictEqual(put.status, 200);
  const info = (await call(ann.s, 'backup:status')).backup;
  assert.deepStrictEqual([info.size, info.messages, info.device], [file1.length, 42, 'Pixel']);
  assert.strictEqual(Buffer.from(await (await raw(ann.token, 'GET', '/backup/file')).arrayBuffer()).toString(), 'first locked file');
  // A newer one replaces it and the old file is removed from the media store.
  const before = Object.keys(store.data.media).length;
  await raw(ann.token, 'PUT', '/backup/file', Buffer.from('second'), { 'Content-Type': 'application/octet-stream' });
  assert.strictEqual(Object.keys(store.data.media).length, before);
  assert.strictEqual(Buffer.from(await (await raw(ann.token, 'GET', '/backup/file')).arrayBuffer()).toString(), 'second');
  // Nobody else gets it; it is not reachable as ordinary media either.
  assert.strictEqual((await raw(bob.token, 'GET', '/backup/file')).status, 404);
  const mediaId = store.data.users.ann.backup.mediaId;
  assert.strictEqual((await fetch(`http://localhost:${t.app?.port || 0}/media/${mediaId}`).catch(() => ({ status: 0 }))).status === 200, false);
  assert.strictEqual(store.getMedia(mediaId, 'ann'), null);
  assert.strictEqual((await raw(ann.token, 'PUT', '/backup/file', Buffer.alloc(0), { 'Content-Type': 'application/octet-stream' })).status, 400);
  assert.strictEqual((await call(ann.s, 'backup:delete')).deleted, true);
  assert.strictEqual(store.data.users.ann.backup, undefined);
  assert.strictEqual(Object.keys(store.data.media).length, before - 1);
});

test('backup: 24 a day, the administrator can switch it off, and deleting the account removes it', async (t) => {
  const { store, make, raw } = await setup(t);
  const ann = await make('ann');
  for (let i = 0; i < Store.BACKUPS_PER_DAY; i++) assert.strictEqual((await raw(ann.token, 'PUT', '/backup/file', Buffer.from(`f${i}`), { 'Content-Type': 'application/octet-stream' })).status, 200);
  assert.strictEqual((await raw(ann.token, 'PUT', '/backup/file', Buffer.from('more'), { 'Content-Type': 'application/octet-stream' })).status, 429);
  store.updateSettings({ features: { backup: false } });
  assert.strictEqual((await raw(ann.token, 'GET', '/backup/file')).status, 403);
  store.updateSettings({ features: { backup: true } });
  store.eraseAccount('ann');
  assert.strictEqual(Object.values(store.data.media).some((m) => m.backupOf === 'ann'), false);
});

test('backup keys: a message can be opened with its content key, without the device that received it', async () => {
  const a = await E2EE.generateDevice();
  const b = await E2EE.generateDevice();
  const newPhone = await E2EE.generateDevice();
  const devA = { id: 'a1', privateKey: a.privateKey, publicKey: a.publicKey };
  const devB = { id: 'b1', privateKey: b.privateKey, publicKey: b.publicKey };
  const sealed = await E2EE.encrypt({ device: devA, convId: 'dm:ann:bob', from: 'ann', recipients: [devA, devB], payload: { t: 'old news' } });
  const msg = { id: 'm1', convId: 'dm:ann:bob', from: 'ann', e2ee: sealed.envelope };
  // The old phone takes the content key out of the message ...
  const ck = await E2EE.unwrapContentKey({ device: devB, convId: msg.convId, from: 'ann', envelope: msg.e2ee, senderDevices: [{ id: 'a1', publicKey: a.publicKey }] });
  assert.strictEqual(ck.length, 32);
  // ... and the new phone, which was not a recipient, opens the message with it.
  void newPhone;
  const opened = await E2EE.openWithKey({ ck, convId: msg.convId, from: 'ann', envelope: msg.e2ee });
  assert.strictEqual(opened.payload.t, 'old news');
  // The wrong chat or sender fails (the message is bound to them).
  await assert.rejects(E2EE.openWithKey({ ck, convId: 'dm:ann:cat', from: 'ann', envelope: msg.e2ee }));
  await assert.rejects(E2EE.openWithKey({ ck, convId: msg.convId, from: 'eve', envelope: msg.e2ee }));
  // The backup file: locked with a recovery key; a wrong key opens nothing.
  const recovery = E2EE.newRecoveryKey();
  assert.match(recovery.text, /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
  const key = await E2EE.backupKeyFrom(recovery.bytes);
  const file = await E2EE.lockBackup(key, { v: 1, at: 1, keys: { m1: E2EE.toB64u(ck) } });
  const again = await E2EE.backupKeyFrom(E2EE.parseRecoveryKey(recovery.text));
  assert.strictEqual((await E2EE.unlockBackup(again, file)).keys.m1, E2EE.toB64u(ck));
  const wrong = await E2EE.backupKeyFrom(E2EE.newRecoveryKey().bytes);
  await assert.rejects(E2EE.unlockBackup(wrong, file));
  assert.throws(() => E2EE.parseRecoveryKey('not a key'));
});
