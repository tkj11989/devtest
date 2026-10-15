'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const app = createApp({ store, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token, appSession = 'x') => {
    const s = connect(base, { auth: { token, appSession }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { store, client, api };
}
const enc = encodeURIComponent;

test('translation: unavailable unless a gateway or the sandbox is configured', async (t) => {
  const { store, api } = await setup(t);
  const a = store.register('alice', 'pass');
  store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  const langs = await api('GET', '/translate/languages', { token: a.token });
  assert.deepStrictEqual([langs.body.available, langs.body.languages.some((l) => l.code === 'hi' && l.native === 'हिन्दी')], [false, true]);
  const r = await api('PUT', `/conversations/${enc(dm.id)}/translation`, { token: a.token, body: { lang: 'hi' } });
  assert.deepStrictEqual([r.status, r.body.error.code], [503, 'translation_unavailable']);
  assert.strictEqual((await api('PUT', `/conversations/${enc(dm.id)}/translation`, { token: a.token, body: { lang: null } })).status, 200, 'turning off is always fine');
});

test('translation: per-contact language, private, only for chats where it is on', async (t) => {
  const { store, client, api } = await setup(t, { translate: { sandbox: true } });
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const carol = store.register('carol', 'pass');
  const withBob = store.getOrCreateDirect('alice', 'bob');
  const withCarol = store.getOrCreateDirect('alice', 'carol');
  const sa = await client(alice.token);
  const sb = await client(bob.token);
  const translate = (token, id, texts) => api('POST', `/conversations/${enc(id)}/translate`, { token, body: { texts } });

  // Not on yet.
  assert.strictEqual((await translate(alice.token, withBob.id, ['hello'])).body.error.code, 'translation_off');

  const changed = next(sa, 'translate:update');
  const set = await api('PUT', `/conversations/${enc(withBob.id)}/translation`, { token: alice.token, body: { lang: 'HI' } });
  assert.deepStrictEqual(set.body, { convId: withBob.id, lang: 'hi' });
  assert.deepStrictEqual(await changed, { convId: withBob.id, lang: 'hi' }, 'my other devices hear about it');
  assert.strictEqual((await api('PUT', `/conversations/${enc(withBob.id)}/translation`, { token: alice.token, body: { lang: 'xx' } })).status, 400);

  // Only this contact; only for me.
  const list = (await call(sa, 'conversations')).conversations;
  assert.deepStrictEqual(list.map((c) => [c.id, c.translateTo]).sort(), [[withBob.id, 'hi'], [withCarol.id, undefined]].sort());
  assert.strictEqual((await call(sb, 'conversations')).conversations[0].translateTo, undefined, 'bob is not told');
  assert.strictEqual((await translate(alice.token, withCarol.id, ['hello'])).body.error.code, 'translation_off');
  assert.strictEqual((await translate(bob.token, withBob.id, ['hello'])).body.error.code, 'translation_off', "bob's own setting is separate");

  const ok = await translate(alice.token, withBob.id, ['Good morning!', 'Is the order ready?']);
  assert.deepStrictEqual([ok.status, ok.body.target], [200, 'hi']);
  assert.deepStrictEqual(ok.body.translations, [{ text: '[hi] Good morning!', detected: 'en' }, { text: '[hi] Is the order ready?', detected: 'en' }]);

  // Validation.
  for (const texts of [[], 'hi', [''], [5], ['x'.repeat(4001)], Array(31).fill('a')]) {
    assert.strictEqual((await translate(alice.token, withBob.id, texts)).status, 400, JSON.stringify(texts).slice(0, 30));
  }
  assert.strictEqual((await translate(carol.token, withBob.id, ['x'])).status, 404, 'members only');

  // Off again.
  assert.strictEqual((await api('PUT', `/conversations/${enc(withBob.id)}/translation`, { token: alice.token, body: { lang: null } })).body.lang, null);
  assert.strictEqual((await translate(alice.token, withBob.id, ['x'])).body.error.code, 'translation_off');
});

test('translation gateway: texts go through and are never stored or logged; failures handled', async (t) => {
  const seen = [];
  let mode = 'ok';
  const gateway = async (body) => {
    seen.push(body);
    if (mode === 'down') throw new Error('boom');
    if (mode === 'bad') return { translations: [{ text: 'only one' }] };
    return { translations: body.texts.map((x) => ({ text: x.toUpperCase(), detected: 'EN-us' })) };
  };
  const logged = [];
  const orig = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = (...a) => logged.push(a.join(' '));
  t.after(() => { [console.log, console.error, console.warn] = orig; });

  const { store, api, client } = await setup(t, { translate: { gateway, perMinute: 10 } });
  const alice = store.register('alice', 'pass');
  store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  store.setLockCode('alice', '2468');
  await api('PUT', `/conversations/${enc(dm.id)}/translation`, { token: alice.token, body: { lang: 'fr' } });
  const post = (texts) => api('POST', `/conversations/${enc(dm.id)}/translate`, { token: alice.token, body: { texts } });

  const secret = 'my private bank PIN is 4455';
  const ok = await post([secret]);
  assert.deepStrictEqual(seen[0], { action: 'translate', target: 'fr', texts: [secret] });
  assert.deepStrictEqual(ok.body.translations, [{ text: secret.toUpperCase(), detected: 'en' }], 'detected language is normalised');
  assert.ok(!JSON.stringify(store.data).includes('PIN'), 'nothing stored');

  mode = 'bad';
  assert.strictEqual((await post(['a', 'b'])).body.error.code, 'translation_failed');
  mode = 'down';
  const down = await post([secret]);
  assert.deepStrictEqual([down.status, down.body.error.code], [502, 'translation_failed']);
  assert.ok(!logged.join('\n').includes('PIN') && !JSON.stringify(down.body).includes('PIN'), 'texts are never logged');

  // 10 texts per minute: more is refused.
  mode = 'ok';
  assert.strictEqual((await post(['1', '2', '3'])).status, 200);
  assert.strictEqual((await post(['1', '2'])).status, 200);
  assert.strictEqual((await post(['1', '2', '3'])).body.error.code, 'rate_limited');

  // A locked chat can't be translated by a session that hasn't unlocked it.
  store.setChatLocked('alice', dm.id, true);
  const s = await client(alice.token, 'sess');
  assert.strictEqual((await call(s, 'translate:text', { convId: dm.id, texts: ['x'] })).code, 'chat_locked');
});
