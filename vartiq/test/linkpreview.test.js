'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const { createLinkPreviewer, cleanPreview, firstUrl, allowedUrl } = require('../server/linkpreview');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

function site(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>ignored</title><meta property="og:title" content="Fish &amp; Chips"><meta property="og:description" content="The best in town"><meta property="og:image" content="/pic.png"></head><body>x</body></html>');
    } else if (req.url === '/go') {
      res.writeHead(302, { Location: '/page' }).end();
    } else if (req.url === '/pic.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG);
    } else if (req.url === '/plain') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><title>Just a title</title></head></html>');
    } else if (req.url === '/file') {
      res.setHeader('Content-Type', 'application/pdf');
      res.end('%PDF');
    } else { res.statusCode = 404; res.end('no'); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { t.after(() => server.close()); r(`http://127.0.0.1:${server.address().port}`); }));
}

test('link preview: title, description and a small picture; redirects followed; non-pages give nothing', async (t) => {
  const base = await site(t);
  const lp = createLinkPreviewer({ allowPrivate: true });
  const p = await lp.preview(`${base}/go`);
  assert.strictEqual(p.title, 'Fish & Chips');
  assert.strictEqual(p.description, 'The best in town');
  assert.match(p.image, /^data:image\/png;base64,/);
  assert.strictEqual((await lp.preview(`${base}/plain`)).title, 'Just a title');
  assert.strictEqual(await lp.preview(`${base}/file`), null);
  assert.strictEqual(await lp.preview(`${base}/missing`), null);
});

test('link preview: private addresses, odd ports, credentials and other schemes are refused', async () => {
  const lp = createLinkPreviewer();
  assert.strictEqual(await lp.preview('http://127.0.0.1/'), null);
  assert.strictEqual(await lp.preview('http://localhost/'), null);
  assert.strictEqual(await lp.preview('http://169.254.169.254/latest/meta-data'), null);
  assert.strictEqual(await lp.preview('http://[::1]/'), null);
  assert.strictEqual(allowedUrl('http://example.com:22/'), null);
  assert.strictEqual(allowedUrl('http://user:pw@example.com/'), null);
  assert.strictEqual(allowedUrl('file:///etc/passwd'), null);
  assert.strictEqual(allowedUrl('ftp://example.com/'), null);
  assert.ok(allowedUrl('https://example.com/a?b=1'));
});

test('link preview: finds the first link; a preview from a client is cleaned', () => {
  assert.strictEqual(firstUrl('see https://example.com/a?b=1, ok'), 'https://example.com/a?b=1');
  assert.strictEqual(firstUrl('no link here'), null);
  assert.deepStrictEqual(cleanPreview({ url: 'https://example.com', title: ' Hi  there ', extra: 1 }), { url: 'https://example.com/', title: 'Hi there' });
  assert.strictEqual(cleanPreview({ url: 'javascript:alert(1)', title: 'x' }), null);
  assert.strictEqual(cleanPreview({ url: 'https://example.com', title: '' }), null);
  assert.strictEqual(cleanPreview({ url: 'https://example.com', title: 'x', image: 'https://evil.example/p.png' }).image, undefined);
  assert.strictEqual(cleanPreview({ url: 'https://example.com', title: 'x', image: 'data:image/svg+xml;base64,AAAA' }).image, undefined);
  assert.ok(cleanPreview({ url: 'https://example.com', title: 'x', image: `data:image/png;base64,${PNG.toString('base64')}` }).image);
});

test('link preview: ask the server, send it with a plain message, the administrator can switch it off, rate limit', async (t) => {
  const base = await site(t);
  const store = new Store({ file: null });
  const app = createApp({ store, linkPreview: { allowPrivate: true } });
  await new Promise((r) => app.server.listen(0, r));
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const make = async (n) => { const r = store.register(n, 'pass', n); const s = connect(`http://localhost:${app.server.address().port}`, { auth: { token: r.token }, transports: ['websocket'], forceNew: true }); sockets.push(s); await new Promise((ok) => s.once('connect', ok)); return s; };
  const ann = await make('ann');
  await make('bob');
  const dm = store.getOrCreateDirect('ann', 'bob');
  const got = await call(ann, 'link:preview', { url: `${base}/page` });
  assert.ok(got.ok, got.error);
  assert.strictEqual(got.preview.title, 'Fish & Chips');
  assert.strictEqual((await call(ann, 'link:preview', { url: 'not a link' })).code, 'invalid_request');

  const sent = await call(ann, 'message:send', { convId: dm.id, text: `try ${base}/page`, preview: got.preview });
  assert.strictEqual(sent.message.preview.title, 'Fish & Chips');
  const bad = await call(ann, 'message:send', { convId: dm.id, text: 'x', preview: { url: 'javascript:1', title: 'x' } });
  assert.strictEqual(bad.message.preview, undefined);
  // An encrypted message never carries a preview the server can read.
  assert.strictEqual(store.addMessage(dm.id, 'ann', '', { e2ee: { v: 1, w: {} } }).preview, undefined);

  store.updateSettings({ features: { linkPreviews: false } });
  assert.strictEqual((await call(ann, 'link:preview', { url: `${base}/page` })).code, 'feature_disabled');
  assert.strictEqual((await call(ann, 'message:send', { convId: dm.id, text: 'y', preview: got.preview })).message.preview, undefined);
  store.updateSettings({ features: { linkPreviews: true } });
  let limited;
  for (let i = 0; i < 61 && !limited; i++) { const r = await call(ann, 'link:preview', { url: `${base}/plain` }); if (!r.ok) limited = r; }
  assert.strictEqual(limited.code, 'rate_limited');
});
