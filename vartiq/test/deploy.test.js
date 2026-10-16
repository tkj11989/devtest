'use strict';

// Things that matter when the app runs for real: sessions survive a restart, TURN credentials are short-lived.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { Store } = require('../server/store');

test('login sessions survive a restart, expire after 90 days, end on logout, and only a hash is saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vartiq-sess-'));
  const file = path.join(dir, 'db.json');
  try {
    const one = new Store({ file });
    const { token } = one.register('alice', 'pass');
    const other = one.register('bob', 'pass').token;
    one.flush();
    assert.ok(!fs.readFileSync(file, 'utf8').includes(token), 'the token itself is never saved');

    const two = new Store({ file }); // "restart"
    assert.strictEqual(two.userForToken(token), 'alice');
    assert.strictEqual(two.userForToken(other), 'bob');
    assert.strictEqual(two.userForToken('not-a-token'), null);

    two.logout(token);
    assert.strictEqual(two.userForToken(token), null, 'logged out');
    assert.strictEqual(two.userForToken(other), 'bob', 'others unaffected');

    two.data.sessions[Store._tokenKey(other)].at = Date.now() - Store.SESSION_MS - 1000;
    assert.strictEqual(two.userForToken(other), null, 'older than 90 days');
    assert.strictEqual(Object.keys(two.data.sessions).length, 0, 'expired sessions are dropped');

    const { token: again } = two.register('carol', 'pass');
    two.dropSessionsOf('carol');
    assert.strictEqual(two.userForToken(again), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with a TURN server configured, each person gets short-lived credentials (not a shared password)', async (t) => {
  const saved = { urls: process.env.TURN_URLS, secret: process.env.TURN_SECRET, ttl: process.env.TURN_TTL_SECONDS };
  process.env.TURN_URLS = 'turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349';
  process.env.TURN_SECRET = 'a-long-shared-secret';
  process.env.TURN_TTL_SECONDS = '3600';
  t.after(() => {
    for (const [k, v] of [['TURN_URLS', saved.urls], ['TURN_SECRET', saved.secret], ['TURN_TTL_SECONDS', saved.ttl]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  t.after(() => { app.io.close(); app.server.close(); });
  const { token } = store.register('alice', 'pass');
  const res = await fetch(`http://localhost:${app.server.address().port}/api/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
  const { iceServers } = await res.json();
  const turn = iceServers.find((s) => s.credential);
  assert.deepStrictEqual(turn.urls, ['turn:turn.example.com:3478?transport=udp', 'turn:turn.example.com:3478?transport=tcp', 'turns:turn.example.com:5349']);
  const [expires, who] = turn.username.split(':');
  assert.strictEqual(who, 'alice');
  assert.ok(Math.abs(Number(expires) - (Date.now() / 1000 + 3600)) < 30, 'expires in about an hour');
  assert.strictEqual(turn.credential, crypto.createHmac('sha1', 'a-long-shared-secret').update(turn.username).digest('base64'), 'coturn can check it with the same secret');
  assert.deepStrictEqual(iceServers.find((s) => !s.credential).urls, ['stun:turn.example.com:3478'], 'your own STUN as well, without ?transport=');
});

test('pages declare which browser features they use (location, microphone, camera) and the service worker is never cached', async (t) => {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  t.after(() => { app.io.close(); app.server.close(); });
  const base = `http://localhost:${app.server.address().port}`;
  const page = await fetch(`${base}/`);
  const policy = page.headers.get('permissions-policy');
  assert.match(policy, /geolocation=\(self\)/);
  assert.match(policy, /microphone=\(self\)/);
  assert.match(policy, /camera=\(self\)/);
  assert.match(policy, /usb=\(\)/);
  const sw = await fetch(`${base}/sw.js`);
  assert.strictEqual(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.strictEqual(sw.headers.get('cache-control'), 'no-cache');
  assert.strictEqual(sw.headers.get('service-worker-allowed'), '/');
  assert.match(await sw.text(), /addEventListener\('push'/);
});
