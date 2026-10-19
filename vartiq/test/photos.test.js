'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const P = require('../server/photos');

// ---- tiny real pictures made in the test ----
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** A valid solid-colour PNG of the given size. */
function png(w, h, rgb = [200, 80, 40]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Just enough JPEG to read its size from (frame header). */
function jpegHeader(w, h) {
  const sof = Buffer.alloc(19); sof.writeUInt16BE(17, 0); sof[2] = 8; sof.writeUInt16BE(h, 3); sof.writeUInt16BE(w, 5); sof[7] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), Buffer.from([0xff, 0xc0]), sof, Buffer.alloc(8)]);
}
const photoBody = (n = 0) => ({ image: png(512, 512, [n * 40 % 255, 90, 160]).toString('base64'), thumb: png(128, 128, [n * 40 % 255, 90, 160]).toString('base64') });

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const app = createApp({
    store,
    admin: { username: 'root', password: 'correct-horse-battery' },
    otp: { sender: async () => {}, resendMs: 0, exposeCodes: true },
    rateLimit: { max: 100000, authMax: 100000 },
    ...opts,
  });
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
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const media = async (id, token) => fetch(`${base}/media/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  const admin = async (method, path, body, token) => {
    if (!admin.token) admin.token = (await (await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'correct-horse-battery' }) })).json()).token;
    const res = await fetch(`${base}/admin/api${path}`, { method, headers: { ...(token !== null ? { Authorization: `Bearer ${token || admin.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { store, app, client, api, media, admin, base };
}
const upload = (env, token, n) => env.api('POST', '/me/photos', token, photoBody(n));
const seeMain = async (env, viewer, owner) => (await env.api('GET', `/users/${owner}`, viewer)).body.user.photo;

test('pictures are read from their own bytes: type, size, nothing else gets in', () => {
  assert.deepStrictEqual(P.inspect(png(512, 300)), { mime: 'image/png', width: 512, height: 300 });
  assert.deepStrictEqual(P.inspect(jpegHeader(640, 480)), { mime: 'image/jpeg', width: 640, height: 480 });
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(8), Buffer.from([0xff, 0x01, 0x00, 0xff, 0x01, 0x00]), Buffer.alloc(4)]);
  assert.deepStrictEqual(P.inspect(webp), { mime: 'image/webp', width: 512, height: 512 });
  for (const bad of [Buffer.from('GIF89a'.padEnd(40, 'x')), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(40, ' ')), Buffer.alloc(100), Buffer.from('MZ'.padEnd(50, 'x')), null, 'text']) assert.strictEqual(P.inspect(bad), null);
  for (const bad of [{}, { image: 'AAAA', thumb: 'AAAA' }, { image: png(512, 512).toString('base64') }]) assert.throws(() => P.check(bad), (e) => e.status >= 400);
});

test('limits: 2 photos for a free account, 5 with Premium, and what happens when Premium ends', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  assert.strictEqual((await env.api('GET', '/me/photos', a.token)).body.limit, 2);
  assert.strictEqual((await upload(env, a.token, 1)).status, 201);
  const two = await upload(env, a.token, 2);
  assert.strictEqual(two.status, 201);
  assert.strictEqual(two.body.photos.length, 2);
  assert.strictEqual(two.body.photos[0].main, true, 'the first is the picture');

  const third = await upload(env, a.token, 3);
  assert.strictEqual(third.status, 402);
  assert.strictEqual(third.body.error.code, 'premium_required');
  assert.match(third.body.error.message, /2 profile photos.*Premium allows 5/);

  env.store.setPremiumByAdmin('alice', Date.now() + 86400000);
  assert.strictEqual((await env.api('GET', '/me/photos', a.token)).body.limit, 5);
  for (const n of [3, 4, 5]) assert.strictEqual((await upload(env, a.token, n)).status, 201, `photo ${n}`);
  const sixth = await upload(env, a.token, 6);
  assert.strictEqual(sixth.status, 409);
  assert.strictEqual(sixth.body.error.code, 'limit_reached');

  // Premium ends: the five stay, nothing more can be added until there are fewer than the free limit.
  env.store.setPremiumByAdmin('alice', null);
  const after = await env.api('GET', '/me/photos', a.token);
  assert.strictEqual(after.body.photos.length, 5);
  assert.strictEqual(after.body.limit, 2);
  assert.strictEqual((await upload(env, a.token, 7)).status, 409);
  for (const p of after.body.photos.slice(0, 4)) await env.api('DELETE', `/me/photos/${p.id}`, a.token);
  assert.strictEqual((await upload(env, a.token, 8)).status, 201, 'under the free limit again');

  // The numbers are settings.
  env.store.updateSettings({ limits: { freeProfilePhotos: 3, premiumProfilePhotos: 6 } });
  assert.strictEqual((await env.api('GET', '/me/photos', a.token)).body.freeLimit, 3);
  assert.throws(() => env.store.updateSettings({ limits: { freeProfilePhotos: 0 } }), /freeProfilePhotos/);
});

test('uploads are checked: type, size, dimensions, thumbnail', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const b64 = (buf) => buf.toString('base64');
  const cases = [
    ['not a picture', { image: b64(Buffer.from('hello world, this is text'.padEnd(60))), thumb: b64(png(128, 128)) }, 415],
    ['a script', { image: b64(Buffer.from('<script>alert(1)</script>'.padEnd(60))), thumb: b64(png(128, 128)) }, 415],
    ['too many pixels', { image: b64(png(2000, 2000)), thumb: b64(png(128, 128)) }, 400],
    ['too small', { image: b64(png(20, 20)), thumb: b64(png(20, 20)) }, 400],
    ['thumbnail too big', { image: b64(png(512, 512)), thumb: b64(png(512, 512)) }, 400],
    ['too many bytes', { image: b64(Buffer.concat([png(512, 512), Buffer.alloc(500 * 1024)])), thumb: b64(png(128, 128)) }, 413],
    ['no thumbnail', { image: b64(png(512, 512)) }, 400],
    ['nothing', {}, 400],
  ];
  for (const [why, body, status] of cases) {
    const res = await env.api('POST', '/me/photos', a.token, body);
    assert.strictEqual(res.status, status, `${why}: ${JSON.stringify(res.body).slice(0, 120)}`);
  }
  assert.strictEqual(env.store.photosOf('alice').length, 0, 'nothing was stored');
  assert.strictEqual(Object.keys(env.store.data.media).length, 0);
  assert.strictEqual((await env.api('POST', '/me/photos', a.token, { image: b64(jpegHeader(512, 512)), thumb: b64(jpegHeader(128, 128)) })).status, 201, 'a JPEG is fine');
});

test('main photo, remove, and what other people get', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const b = env.store.register('bob', 'pass');
  await env.api('POST', '/conversations', a.token, { type: 'direct', username: 'bob' });
  const first = (await upload(env, a.token, 1)).body.photos[0];
  const second = (await upload(env, a.token, 2)).body.photos[1];

  const live = await env.client(b.token);
  const heard = new Promise((r) => live.once('user:updated', r));
  const moved = await env.api('PUT', `/me/photos/${second.id}/main`, a.token);
  assert.strictEqual(moved.body.photos[0].id, second.id);
  assert.strictEqual((await heard).user.photo.id, second.image, 'their chat partner is told at once');
  assert.strictEqual((await seeMain(env, b.token, 'alice')).thumb, second.thumb);
  assert.strictEqual((await env.api('PUT', `/me/photos/nope/main`, a.token)).status, 404);

  // The picture itself is a normal download, and the right bytes.
  const got = await env.media(second.thumb, b.token);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.headers.get('content-type'), 'image/png');
  assert.deepStrictEqual(P.inspect(Buffer.from(await got.arrayBuffer())), { mime: 'image/png', width: 128, height: 128 });

  // Removing the main photo promotes the next; removing the last leaves none; the files are deleted.
  const gone = await env.api('DELETE', `/me/photos/${second.id}`, a.token);
  assert.strictEqual(gone.body.photos[0].id, first.id);
  assert.strictEqual((await env.media(second.image, a.token)).status, 404, 'the file is gone');
  assert.strictEqual((await seeMain(env, b.token, 'alice')).thumb, first.thumb);
  await env.api('DELETE', `/me/photos/${first.id}`, a.token);
  assert.strictEqual(await seeMain(env, b.token, 'alice'), undefined);
  assert.strictEqual(Object.keys(env.store.data.media).length, 0, 'no stray files');
  assert.strictEqual((await env.api('DELETE', `/me/photos/${first.id}`, a.token)).status, 404);
});

test('who sees a photo: contacts by default, everyone or nobody by choice; never someone blocked', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const friend = env.store.register('friend', 'pass');
  const grouped = env.store.register('grouped', 'pass');
  const stranger = env.store.register('stranger', 'pass');
  await env.api('POST', '/conversations', a.token, { type: 'direct', username: 'friend' });
  await env.api('POST', '/conversations', a.token, { type: 'group', name: 'Trip', members: ['grouped'] });
  const photo = (await upload(env, a.token, 1)).body.photos[0];

  const sees = async (token, who = 'alice') => !!(await seeMain(env, token, who));
  const fetches = async (token) => (await env.media(photo.thumb, token)).status;
  assert.strictEqual((await env.api('GET', '/me/photos', a.token)).body.privacy, 'contacts', 'the default');
  assert.deepStrictEqual([await sees(a.token), await sees(friend.token), await sees(grouped.token), await sees(stranger.token)], [true, true, true, false]);
  assert.deepStrictEqual([await fetches(a.token), await fetches(friend.token), await fetches(grouped.token), await fetches(stranger.token)], [200, 200, 200, 404], 'the file follows the same rule');
  assert.strictEqual((await env.api('GET', '/users/alice/photos', stranger.token)).body.photos.length, 0);
  assert.strictEqual((await env.api('GET', '/users/alice/photos', friend.token)).body.photos.length, 1);
  assert.ok(!JSON.stringify((await env.api('GET', '/users?q=alice', stranger.token)).body).includes(photo.thumb), 'not in search results either');

  await env.api('PUT', '/me/photo-privacy', a.token, { who: 'everyone' });
  assert.strictEqual(await sees(stranger.token), true);
  assert.strictEqual(await fetches(stranger.token), 200);
  assert.strictEqual((await env.api('PUT', '/me/photo-privacy', a.token, { who: 'whoever' })).status, 400);

  await env.api('PUT', '/users/friend', a.token); // (no such route: harmless)
  await env.api('PUT', `/blocked/friend`, a.token);
  assert.strictEqual(await sees(friend.token), false, 'someone I blocked sees nothing');
  assert.strictEqual(await fetches(friend.token), 404);
  await env.api('DELETE', `/blocked/friend`, a.token);

  await env.api('PUT', '/me/photo-privacy', a.token, { who: 'nobody' });
  assert.deepStrictEqual([await sees(a.token), await sees(friend.token), await sees(stranger.token)], [true, false, false], 'only me');
});

test('under 18: photos are only for people they chat with, whatever they chose; none while waiting for the guardian', async (t) => {
  const env = await setup(t, { publicUrl: 'https://vartiq.example' });
  const kid = env.store.register('kid', 'pass');
  const pal = env.store.register('pal', 'pass');
  const stranger = env.store.register('stranger', 'pass');
  await env.api('POST', '/conversations', kid.token, { type: 'direct', username: 'pal' });
  const photo = (await upload(env, kid.token, 1)).body.photos[0];
  await env.api('PUT', '/me/photo-privacy', kid.token, { who: 'everyone' });
  assert.strictEqual(!!(await seeMain(env, stranger.token, 'kid')), true, 'an adult may choose everyone');

  env.store.data.users.kid.birthDate = new Date(Date.now() - 14 * 365.25 * 86400000).toISOString().slice(0, 10);
  env.store.data.users.kid.guardian = { name: 'Mum', relationship: 'mother', phone: '+919811100001', state: 'active', controls: {} };
  const mine = (await env.api('GET', '/me/photos', kid.token)).body;
  assert.strictEqual(mine.privacy, 'everyone');
  assert.strictEqual(mine.appliedPrivacy, 'contacts', 'a child is never shown beyond their chats');
  assert.strictEqual(mine.minor, true);
  assert.strictEqual(!!(await seeMain(env, stranger.token, 'kid')), false);
  assert.strictEqual((await env.media(photo.thumb, stranger.token)).status, 404);
  assert.strictEqual(!!(await seeMain(env, pal.token, 'kid')), true, 'their chat partner still sees it');

  env.store.data.users.kid.guardian.state = 'pending';
  assert.strictEqual(!!(await seeMain(env, pal.token, 'kid')), false, 'nothing while the account waits for the guardian');
});

test('reports: a reason, one per person, three hide it, a child-safety report hides it at once; administrators decide', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const people = ['rep1', 'rep2', 'rep3', 'rep4'].map((n) => env.store.register(n, 'pass'));
  await env.api('PUT', '/me/photo-privacy', a.token, { who: 'everyone' });
  const photo = (await upload(env, a.token, 1)).body.photos[0];
  const report = (who, reason = 'harassment', id = photo.id, owner = 'alice') => env.api('POST', `/users/${owner}/photos/${id}/report`, who.token, { reason, detail: 'x' });

  assert.strictEqual((await report(a)).status, 400, 'not your own');
  assert.strictEqual((await report(people[0], 'because')).status, 400, 'a listed reason');
  assert.strictEqual((await report(people[0], 'harassment', 'nope')).status, 404);
  const one = await report(people[0]);
  assert.deepStrictEqual(one.body, { reported: true, hidden: false });
  assert.strictEqual((await report(people[0])).status, 409, 'once per person');
  await report(people[1]);
  assert.strictEqual((await env.media(photo.thumb, people[3].token)).status, 200, 'two reports: still shown');
  const third = await report(people[2]);
  assert.strictEqual(third.body.hidden, true, 'three different people');
  assert.strictEqual((await env.media(photo.thumb, people[3].token)).status, 404, 'hidden from everyone else');
  assert.strictEqual(!!(await seeMain(env, people[3].token, 'alice')), false);
  assert.strictEqual((await env.media(photo.thumb, a.token)).status, 200, 'but not from its owner');
  assert.strictEqual((await env.api('GET', '/me/photos', a.token)).body.photos[0].hidden, true, 'who is told it is under review');
  assert.strictEqual((await report(people[3])).status, 404, 'and it cannot be reported by someone who cannot see it');

  // Administrators see the reports, and the picture, and decide.
  assert.strictEqual((await env.admin('GET', '/photo-reports', undefined, null)).status, 401);
  const list = (await env.admin('GET', '/photo-reports')).body.reports;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].reports.length, 3);
  assert.strictEqual(list[0].hidden, true);
  const img = await env.admin('GET', `/photo-reports/alice/${photo.id}/image?size=thumb`);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.type, 'image/png');
  assert.strictEqual((await env.admin('GET', `/photo-reports/alice/${photo.id}/image`, undefined, null)).status, 401);
  assert.strictEqual((await env.admin('POST', '/photo-reports/dismiss', { owner: 'alice', photoId: photo.id })).status, 204);
  assert.strictEqual((await env.media(photo.thumb, people[3].token)).status, 200, 'fine: shown again');
  assert.strictEqual((await env.admin('GET', '/photo-reports')).body.reports.length, 0);

  // One child-safety report is enough to hide it; removing it deletes the files and the reports.
  const urgent = await report(people[0], 'child_safety');
  assert.strictEqual(urgent.body.hidden, true);
  assert.strictEqual((await env.admin('POST', '/photo-reports/remove', { owner: 'alice', photoId: photo.id })).status, 204);
  assert.strictEqual(env.store.photosOf('alice').length, 0);
  assert.strictEqual(Object.keys(env.store.data.media).length, 0);
  assert.strictEqual(env.store.photoReports().length, 0);
  assert.ok(env.store.data.audit.some((e) => e.action === 'photo-remove'), 'recorded in the audit log');
});

test('reports: the channel reports list is not mixed up with photo reports, and a person cannot flood', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const r = env.store.register('rep', 'pass');
  await env.api('PUT', '/me/photo-privacy', a.token, { who: 'everyone' });
  const photo = (await upload(env, a.token, 1)).body.photos[0];
  await env.api('POST', `/users/alice/photos/${photo.id}/report`, r.token, { reason: 'other' });
  assert.strictEqual((await env.admin('GET', '/reports')).body.reports.length, 0, 'channel reports only');
  for (let i = 0; i < P.REPORTS_PER_DAY; i++) env.store.data.reports.push({ type: 'photo', owner: 'zed', photoId: `p${i}`, reporter: 'rep', reason: 'other', ts: Date.now() });
  const b = env.store.register('bob', 'pass');
  await env.api('PUT', '/me/photo-privacy', b.token, { who: 'everyone' });
  const p2 = (await upload(env, b.token, 2)).body.photos[0];
  const flood = await env.api('POST', `/users/bob/photos/${p2.id}/report`, r.token, { reason: 'other' });
  assert.strictEqual(flood.status, 429);
});

test('the feature switch hides photos everywhere and stops adding; removing always works', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const b = env.store.register('bob', 'pass');
  await env.api('POST', '/conversations', a.token, { type: 'direct', username: 'bob' });
  const photo = (await upload(env, a.token, 1)).body.photos[0];
  assert.ok(await seeMain(env, b.token, 'alice'));
  env.store.updateSettings({ features: { profilePhotos: false } });
  assert.strictEqual(await seeMain(env, b.token, 'alice'), undefined);
  assert.strictEqual((await env.media(photo.thumb, b.token)).status, 404);
  assert.strictEqual((await upload(env, a.token, 2)).status, 403);
  assert.strictEqual((await env.api('DELETE', `/me/photos/${photo.id}`, a.token)).status, 200, 'removing always works');
});

test('over the socket, in the data download, and when the account is deleted', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const s = await env.client(a.token);
  const up = await new Promise((r) => s.emit('photo:upload', { image: png(512, 512), thumb: png(128, 128) }, r));
  assert.strictEqual(up.ok, true, JSON.stringify(up));
  assert.strictEqual(up.photos.length, 1);
  const list = await new Promise((r) => s.emit('photos:get', {}, r));
  assert.strictEqual(list.photos[0].main, true);
  const privacy = await new Promise((r) => s.emit('photo:privacy', { who: 'nobody' }, r));
  assert.strictEqual(privacy.privacy, 'nobody');

  const exp = (await env.api('GET', '/me/export', a.token)).body;
  assert.strictEqual(exp.account.profilePhotos.photos.length, 1);
  assert.strictEqual(exp.account.profilePhotos.privacy, 'nobody');
  assert.deepStrictEqual(P.inspect(Buffer.from(exp.account.profilePhotos.photos[0].data, 'base64')).width, 512, 'the picture itself is in it');

  env.store.requestAccountDeletion('alice');
  env.store.eraseAccount('alice');
  assert.strictEqual(Object.keys(env.store.data.media).length, 0, 'the files are erased with the account');
});
