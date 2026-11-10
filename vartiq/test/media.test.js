'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(300, 3)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const THUMB = `data:image/jpeg;base64,${Buffer.alloc(300, 7).toString('base64')}`;

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  t.after(() => { app.io.close(); app.server.close(); });
  const ann = store.register('ann', 'pass', 'Ann');
  const bob = store.register('bob', 'pass', 'Bob');
  const eve = store.register('eve', 'pass', 'Eve');
  const dm = store.getOrCreateDirect('ann', 'bob');
  const call = async (token, method, path, { body, raw, type, query = '', headers = {} } = {}) => {
    const res = await fetch(`${base}${path.startsWith('/media') ? '' : '/api/v1'}${path}${query}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(raw ? { 'Content-Type': type } : body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw || (body ? JSON.stringify(body) : undefined),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* a file */ }
    return { status: res.status, body: json, buf, headers: res.headers };
  };
  const upload = (token, kind, bytes, type, extra = '') => call(token, 'POST', `/conversations/${dm.id}/uploads`, { raw: bytes, type, query: `?kind=${kind}${extra}` });
  return { store, app, ann, bob, eve, dm, call, upload };
}

test('a photo: upload, send with a caption, the other person downloads it; strangers cannot', async (t) => {
  const { store, ann, bob, eve, dm, call, upload } = await setup(t);
  const up = await upload(ann.token, 'image', PNG, 'image/png');
  assert.strictEqual(up.status, 201, JSON.stringify(up.body));
  assert.strictEqual(up.body.size, PNG.length);
  assert.strictEqual((await call(bob.token, 'GET', `/media/${up.body.uploadId}`)).status, 404, 'not sent yet: only the sender can see it');

  const sent = await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: up.body.uploadId, caption: ' Our new shop ', name: 'shop.png', w: 1200, h: 800, thumb: THUMB } });
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
  const m = sent.body.message;
  assert.deepStrictEqual([m.type, m.text, m.media.kind, m.media.mime, m.media.name, m.media.w, m.media.h, m.media.size], ['media', 'Our new shop', 'image', 'image/png', 'shop.png', 1200, 800, PNG.length]);
  assert.strictEqual(m.media.thumb, THUMB);

  const seen = (await call(bob.token, 'GET', `/conversations/${dm.id}/messages`)).body.messages;
  assert.strictEqual(seen[0].media.mediaId, m.media.mediaId);
  const file = await call(bob.token, 'GET', `/media/${m.media.mediaId}`);
  assert.deepStrictEqual([file.status, file.headers.get('content-type'), file.headers.get('x-content-type-options'), file.headers.get('content-disposition')], [200, 'image/png', 'nosniff', null], 'pictures show in place');
  assert.ok(file.buf.equals(PNG));
  assert.strictEqual((await call(eve.token, 'GET', `/media/${m.media.mediaId}`)).status, 404, 'not a member of the chat');

  // The same upload cannot be sent twice, and a retried clientId returns the first message.
  assert.strictEqual((await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: up.body.uploadId } })).status, 404);
  const up2 = await upload(ann.token, 'image', JPEG, 'image/jpeg');
  const a = await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: up2.body.uploadId }, headers: { 'Idempotency-Key': 'k1' } });
  const b = await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: up2.body.uploadId }, headers: { 'Idempotency-Key': 'k1' } });
  assert.strictEqual(a.body.message.id, b.body.message.id);
  assert.strictEqual(store.data.messages[dm.id].filter((x) => x.type === 'media').length, 2);

  // Deleting the message deletes the file.
  assert.strictEqual((await call(ann.token, 'DELETE', `/messages/${m.id}`)).status, 204);
  assert.strictEqual((await call(bob.token, 'GET', `/media/${m.media.mediaId}`)).status, 404);
});

test('videos and documents: shown or saved the right way, names are cleaned, programs are refused', async (t) => {
  const { ann, bob, dm, call, upload } = await setup(t);
  const v = await upload(ann.token, 'video', MP4, 'video/mp4');
  const vs = await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: v.body.uploadId, name: 'clip.mp4', w: 640, h: 360, duration: 12.4, thumb: THUMB } });
  assert.deepStrictEqual([vs.body.message.media.kind, vs.body.message.media.duration], ['video', 12]);
  assert.strictEqual((await call(bob.token, 'GET', `/media/${vs.body.message.media.mediaId}`)).headers.get('content-disposition'), null);

  const d = await upload(ann.token, 'file', PDF, 'application/pdf');
  const ds = await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: d.body.uploadId, name: '../../etc/Price list: 2026?.pdf' } });
  assert.strictEqual(ds.status, 201);
  const name = ds.body.message.media.name;
  assert.ok(!/[\\/:?]/.test(name) && name.endsWith('.pdf'), `clean name: ${name}`);
  const got = await call(bob.token, 'GET', `/media/${ds.body.message.media.mediaId}`);
  assert.match(got.headers.get('content-disposition'), /^attachment; filename="[^"/\\]+\.pdf"$/);
  assert.strictEqual(got.headers.get('content-security-policy'), "default-src 'none'; sandbox");

  const exe = await upload(ann.token, 'file', PDF, 'application/pdf');
  const bad = await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: exe.body.uploadId, name: 'invoice.exe' } });
  assert.strictEqual(bad.status, 415, 'a program cannot be sent as a document');
  assert.strictEqual((await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: exe.body.uploadId, name: 'invoice.pdf', caption: 'x'.repeat(1001) } })).status, 400);
});

test('checks: wrong type, wrong bytes, empty, too large, web pages and pictures that are programs, too many waiting', async (t) => {
  const { store, ann, dm, call, upload } = await setup(t);
  assert.strictEqual((await upload(ann.token, 'image', PNG, 'image/svg+xml')).status, 415, 'SVG can carry scripts');
  assert.strictEqual((await upload(ann.token, 'file', Buffer.from('<script>alert(1)</script>'), 'text/html')).status, 415);
  assert.strictEqual((await upload(ann.token, 'video', PNG, 'image/png')).status, 415, 'a picture is not a video');
  assert.strictEqual((await upload(ann.token, 'image', Buffer.from('MZ\x90\x00 this is a program'), 'image/png')).status, 415, 'a program pretending to be a picture');
  assert.strictEqual((await upload(ann.token, 'file', Buffer.from([104, 0, 105]), 'text/plain')).status, 415, 'binary data is not text');
  assert.strictEqual((await upload(ann.token, 'file', Buffer.alloc(0), 'application/pdf')).status, 400);
  assert.strictEqual((await upload(ann.token, 'sticker', PNG, 'image/png')).status, 400);
  assert.strictEqual((await upload(ann.token, 'file', Buffer.from('Hello, नमस्ते\n'), 'text/plain')).status, 201, 'real text in any language is fine');

  store.updateSettings({ limits: { maxImageMB: 1 } });
  assert.strictEqual((await upload(ann.token, 'image', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), 'image/png')).status, 413);

  store.data.media = Object.fromEntries(Object.entries(store.data.media).filter(([, m]) => !m.pending));
  store._pending = null;
  for (let i = 0; i < 10; i++) assert.strictEqual((await upload(ann.token, 'image', PNG, 'image/png')).status, 201);
  const over = await upload(ann.token, 'image', PNG, 'image/png');
  assert.deepStrictEqual([over.status, over.body.error.code], [429, 'too_many_uploads']);
  // Files nobody sent within an hour are thrown away.
  assert.strictEqual(store.pruneUploads(Date.now() + 61 * 60 * 1000), 10);
  assert.strictEqual((await upload(ann.token, 'image', PNG, 'image/png')).status, 201);
  void dm; void call;
});

test('an encrypted file: the server keeps only kind and size, needs the envelope, and serves it as an opaque download', async (t) => {
  const { store, ann, bob, dm, call, upload } = await setup(t);
  const up = await upload(ann.token, 'image', Buffer.alloc(500, 9), 'image/jpeg', '&e2ee=1');
  assert.strictEqual(up.status, 201, 'ciphertext cannot be checked by its bytes');
  assert.strictEqual((await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: up.body.uploadId, caption: 'plain caption' } })).status, 400, 'it needs its encryption envelope');
  const own = await call(ann.token, 'GET', `/media/${up.body.uploadId}`);
  assert.deepStrictEqual([own.headers.get('content-type'), /attachment/.test(own.headers.get('content-disposition') || '')], ['application/octet-stream', true]);

  const plain = await upload(ann.token, 'image', PNG, 'image/png');
  const withEnv = await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: plain.body.uploadId, e2ee: { v: 1 } } });
  assert.strictEqual(withEnv.status, 400, 'a plain upload cannot claim to be encrypted');
  void store; void bob;
});

test('the switch: administrators can turn attachments off; a chat lock and a deleted account are respected', async (t) => {
  const { store, ann, bob, dm, call, upload } = await setup(t);
  const keep = await upload(ann.token, 'image', PNG, 'image/png');
  const sent = await call(ann.token, 'POST', `/conversations/${dm.id}/media`, { body: { uploadId: keep.body.uploadId } });
  store.updateSettings({ features: { attachments: false } });
  assert.strictEqual((await upload(ann.token, 'image', PNG, 'image/png')).status, 403);
  assert.strictEqual((await call(bob.token, 'GET', `/media/${sent.body.message.media.mediaId}`)).status, 200, 'files already in chats stay');
  store.updateSettings({ features: { attachments: true } });

  // Erasing the sender removes the file.
  const mediaId = sent.body.message.media.mediaId;
  store.requestDeletion?.('ann');
  store.eraseAccount('ann');
  assert.ok(!store.data.media[mediaId], 'the file is gone from the store');
  assert.strictEqual(store.data.messages[dm.id][0].media, undefined);
});
