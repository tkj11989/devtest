'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const A = require('../server/appearance');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store, admin: { username: 'root', password: 'correct-horse-battery' }, payments: { sandbox: true } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token) => {
    const s = connect(base, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  const api = async (method, path, { token, body, prefix = '/api/v1' } = {}) => {
    const res = await fetch(`${base}${prefix}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { store, client, api };
}

test('every theme meets WCAG AA in light and dark', () => {
  const themes = A.THEMES.filter((t) => t.tokens);
  assert.ok(themes.length >= 7);
  for (const { id, tokens: { light: L, dark: D } } of themes) {
    const at = (name, ratio, min = 4.5) => assert.ok(ratio >= min, `${id}: ${name} ${ratio.toFixed(2)} < ${min}`);
    at('white on primary', A.contrast('#ffffff', L['--primary']));
    at('primary-text on panel', A.contrast(L['--primary-text'], '#ffffff'));
    at('primary-text on panel-2', A.contrast(L['--primary-text'], '#F1F5FB'));
    at('text on bubble-out', A.contrast('#0B1A33', L['--bubble-out']), 7);
    at('dark: white on primary', A.contrast('#ffffff', D['--primary']));
    at('dark: primary-text on panel', A.contrast(D['--primary-text'], '#0C1730'));
    at('dark: primary-text on panel-2', A.contrast(D['--primary-text'], '#13213F'));
    at('dark: text on bubble-out', A.contrast('#E6EDF7', D['--bubble-out']));
    assert.match(L['--primary'], /^#[0-9a-f]{6}$/);
  }
  assert.strictEqual(new Set(A.THEMES.map((t) => t.swatch)).size, A.THEMES.length, 'themes look different');
  assert.ok(A.ICONS.every((i) => i.svg.startsWith('<svg') && !/<script|on\w+=/i.test(i.svg)), 'icons are plain SVG');
});

test('appearance: mode is free; themes, icons and shapes are Premium', async (t) => {
  const { store, client, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  const s = await client(alice.token);

  const cat = (await api('GET', '/appearance')).body;
  assert.deepStrictEqual([cat.defaults.theme, cat.themes.find((x) => x.id === 'violet').premium, cat.themes[0].tokens, cat.icons.length, cat.avatarShapes.map((x) => x.id)], ['ocean', true, null, 8, ['circle', 'rounded', 'square']]);

  const me = await call(s, 'me');
  assert.deepStrictEqual(me.appearance, { mode: 'auto', theme: 'ocean', appIcon: 'classic', avatarShape: 'circle' });

  // Free: the mode works; Premium options are refused with 402 and nothing is saved.
  const changed = next(s, 'appearance:update');
  assert.strictEqual((await api('PUT', '/me/appearance', { token: alice.token, body: { mode: 'dark' } })).body.appearance.mode, 'dark');
  assert.strictEqual((await changed).mode, 'dark');
  for (const [patch, what] of [[{ theme: 'violet' }, 'Colour themes'], [{ appIcon: 'heart' }, 'Custom app icons'], [{ avatarShape: 'square' }, 'Avatar shapes']]) {
    const r = await api('PUT', '/me/appearance', { token: alice.token, body: patch });
    assert.deepStrictEqual([r.status, r.body.error.code, r.body.error.message.startsWith(what)], [402, 'premium_required', true], what);
  }
  assert.deepStrictEqual(store.prefsOf('alice'), { mode: 'dark' });
  // Defaults are always allowed; junk is rejected; a mix with a Premium option is refused as a whole.
  assert.strictEqual((await api('PUT', '/me/appearance', { token: alice.token, body: { theme: 'ocean', appIcon: 'classic', avatarShape: 'circle' } })).status, 200);
  for (const bad of [{ mode: 'neon' }, { theme: 'nope' }, { appIcon: '<svg>' }, { size: 1 }, null]) assert.strictEqual((await api('PUT', '/me/appearance', { token: alice.token, body: bad })).status, 400, JSON.stringify(bad));
  assert.strictEqual((await api('PUT', '/me/appearance', { token: alice.token, body: { mode: 'light', theme: 'rose' } })).status, 402);
  assert.strictEqual(store.prefsOf('alice').mode, 'dark', 'refused patches change nothing');

  // Buy Premium (sandbox): options unlock, sync to the other devices, and are remembered.
  const order = (await api('POST', '/me/subscription/checkout', { token: alice.token, body: { plan: 'monthly' } })).body;
  await api('POST', '/me/subscription/confirm', { token: alice.token, body: { orderId: order.orderId } });
  const sync = next(s, 'appearance:update');
  const set = await api('PUT', '/me/appearance', { token: alice.token, body: { theme: 'violet', appIcon: 'heart', avatarShape: 'rounded' } });
  assert.deepStrictEqual(set.body.appearance, { mode: 'dark', theme: 'violet', appIcon: 'heart', avatarShape: 'rounded' });
  assert.deepStrictEqual(await sync, set.body.appearance);
  assert.deepStrictEqual((await call(await client(alice.token), 'me')).appearance, set.body.appearance, 'another device gets it at sign-in');

  // Premium ends: the look reverts, the choices are kept; it comes back with Premium.
  store.data.users.alice.subscription.expiresAt = Date.now() - 1;
  const lapsed = (await api('GET', '/me/appearance', { token: alice.token })).body;
  assert.deepStrictEqual([lapsed.appearance, lapsed.saved.theme, lapsed.premium], [{ mode: 'dark', theme: 'ocean', appIcon: 'classic', avatarShape: 'circle' }, 'violet', false]);
  store.activateSubscription('alice', { plan: 'daily', expiresAt: Date.now() + 86400000 });
  assert.strictEqual((await api('GET', '/me/appearance', { token: alice.token })).body.appearance.theme, 'violet');
});

test('appearance: the administrator can switch personalisation off; perks are listed', async (t) => {
  const { store, api } = await setup(t);
  const alice = store.register('alice', 'pass');
  store.activateSubscription('alice', { plan: 'daily', expiresAt: Date.now() + 86400000 });
  const adm = (await api('POST', '/login', { prefix: '/admin/api', body: { username: 'root', password: 'correct-horse-battery' } })).body.token;
  await api('PUT', '/settings', { prefix: '/admin/api', token: adm, body: { features: { appearance: false } } });
  const r = await api('PUT', '/me/appearance', { token: alice.token, body: { theme: 'rose' } });
  assert.deepStrictEqual([r.status, r.body.error.code], [403, 'feature_disabled']);
  assert.strictEqual((await api('GET', '/config')).body.features.appearance, false);
  const sub = (await api('GET', '/me/subscription', { token: alice.token })).body;
  assert.ok(sub.perks.includes('Call recording') && sub.perks.includes('Colour themes'));
});
