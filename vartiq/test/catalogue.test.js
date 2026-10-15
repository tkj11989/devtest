'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store });
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
  const api = async (method, path, { token, body, raw, type } = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(type ? { 'Content-Type': type } : {}) },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* binary */ }
    return { status: res.status, body: parsed };
  };
  const media = (token, id) => fetch(`${base}/media/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  return { store, client, api, media };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function business(store, name) {
  const u = store.register(name, 'pass', name);
  store.setContact(name, 'sms', `+9198000${Math.floor(Math.random() * 90000 + 10000)}`);
  store.setContact(name, 'email', `${name}@shop.example`);
  store.setBusiness(name, { category: 'Restaurant' });
  return u;
}

test('catalogue: only business accounts, products with prices, validation', async (t) => {
  const { store, api } = await setup(t);
  const pizza = business(store, 'pizza');
  const person = store.register('person', 'pass');

  assert.strictEqual((await api('POST', '/me/catalogue/products', { token: person.token, body: { name: 'x' } })).status, 403);
  assert.strictEqual((await api('GET', '/users/person/catalogue', { token: pizza.token })).status, 404, 'a personal account has none');
  assert.deepStrictEqual((await api('GET', '/me/catalogue', { token: pizza.token })).body, { owner: 'pizza', currency: 'INR', products: [] });

  const add = await api('POST', '/me/catalogue/products', { token: pizza.token, body: { name: ' Margherita ', description: 'Wood-fired', price: 299, unit: 'each', category: 'Pizza', link: 'pizza.example/m' } });
  assert.strictEqual(add.status, 201);
  const p = add.body.product;
  assert.deepStrictEqual([p.name, p.price, p.available, p.link, p.sku], ['Margherita', 299, true, 'https://pizza.example/m', undefined]);
  assert.strictEqual((await api('POST', '/me/catalogue/products', { token: pizza.token, body: { name: 'Custom cake', price: null } })).body.product.price, null, 'price on request');
  assert.strictEqual((await api('POST', '/me/catalogue/products', { token: pizza.token, body: { name: 'Cheap', price: 0 } })).body.product.price, 0);

  for (const bad of [{}, { name: '' }, { name: 'x'.repeat(81) }, { name: 'a', price: -1 }, { name: 'a', price: 'abc' }, { name: 'a', price: 1.234 }, { name: 'a', price: 2e9 }, { name: 'a', link: 'not a url' }, { name: 'a', description: 'x'.repeat(1001) }]) {
    assert.strictEqual((await api('POST', '/me/catalogue/products', { token: pizza.token, body: bad })).status, 400, JSON.stringify(bad).slice(0, 40));
  }

  // Update: only the sent fields change; empty clears optional text.
  const upd = await api('PUT', `/me/catalogue/products/${p.id}`, { token: pizza.token, body: { price: 349.5, available: false, category: '' } });
  assert.deepStrictEqual([upd.body.product.price, upd.body.product.available, upd.body.product.category, upd.body.product.name, upd.body.product.unit], [349.5, false, undefined, 'Margherita', 'each']);
  assert.strictEqual((await api('PUT', '/me/catalogue/products/nope', { token: pizza.token, body: { price: 1 } })).status, 404);
  assert.strictEqual((await api('PUT', `/me/catalogue/products/${p.id}`, { token: person.token, body: { price: 1 } })).status, 403);

  // Currency.
  assert.strictEqual((await api('PUT', '/me/catalogue/currency', { token: pizza.token, body: { currency: 'usd' } })).body.currency, 'USD');
  assert.strictEqual((await api('PUT', '/me/catalogue/currency', { token: pizza.token, body: { currency: 'RUPEES' } })).status, 400);

  // Anyone signed in can look; the profile says how many.
  const seen = await api('GET', '/users/pizza/catalogue', { token: person.token });
  assert.deepStrictEqual([seen.body.currency, seen.body.products.map((x) => x.name)], ['USD', ['Margherita', 'Custom cake', 'Cheap']]);
  assert.strictEqual((await api('GET', '/users/pizza', { token: person.token })).body.user.business.productCount, 3);

  // Delete.
  assert.strictEqual((await api('DELETE', `/me/catalogue/products/${p.id}`, { token: pizza.token })).status, 204);
  assert.strictEqual((await api('DELETE', `/me/catalogue/products/${p.id}`, { token: pizza.token })).status, 404);
  assert.strictEqual((await api('GET', '/users/pizza/catalogue', { token: person.token })).body.products.length, 2);
});

test('catalogue: pictures are public to signed-in people, replaced and deleted with the product', async (t) => {
  const { store, api, media, client } = await setup(t);
  const shop = business(store, 'shop');
  const buyer = store.register('buyer', 'pass');
  const s = await client(shop.token);
  const { product } = (await api('POST', '/me/catalogue/products', { token: shop.token, body: { name: 'Mug', price: 12 } })).body;
  const put = (body, type = 'image/png') => api('PUT', `/me/catalogue/products/${product.id}/image`, { token: shop.token, raw: body, type });

  assert.strictEqual((await put(Buffer.alloc(0))).status, 400);
  assert.strictEqual((await put(Buffer.from('GIF89a'), 'image/gif')).status, 415);
  assert.strictEqual((await put(Buffer.alloc(1024 * 1024 + 1, 1))).status, 413);
  const ok = await put(PNG);
  assert.strictEqual(ok.status, 200);
  const first = ok.body.product.image;
  const got = await media(buyer.token, first);
  assert.deepStrictEqual([got.status, got.headers.get('content-type'), Buffer.from(await got.arrayBuffer()).equals(PNG)], [200, 'image/png', true], 'a customer can load it');

  // Replacing deletes the old picture.
  const second = (await put(PNG)).body.product.image;
  assert.notStrictEqual(second, first);
  assert.strictEqual((await media(buyer.token, first)).status, 404);
  assert.strictEqual((await media(buyer.token, second)).status, 200);
  assert.strictEqual((await api('DELETE', `/me/catalogue/products/${product.id}/image`, { token: shop.token })).body.product.image, undefined);
  assert.strictEqual((await media(buyer.token, second)).status, 404);

  // Over the socket too; deleting the product deletes its picture; removing the business deletes the catalogue.
  const viaSocket = await call(s, 'catalogue:image', { id: product.id, mime: 'image/png', data: PNG });
  assert.ok(viaSocket.ok, viaSocket.error);
  const img = viaSocket.product.image;
  await api('DELETE', `/me/catalogue/products/${product.id}`, { token: shop.token });
  assert.strictEqual((await media(buyer.token, img)).status, 404);
  const other = (await api('POST', '/me/catalogue/products', { token: shop.token, body: { name: 'Plate' } })).body.product;
  const img2 = (await api('PUT', `/me/catalogue/products/${other.id}/image`, { token: shop.token, raw: PNG, type: 'image/png' })).body.product.image;
  store.removeBusiness('shop');
  assert.strictEqual((await media(buyer.token, img2)).status, 404);
  assert.strictEqual((await api('GET', '/users/shop/catalogue', { token: buyer.token })).status, 404);
  assert.strictEqual(store.data.users.shop.catalogue, undefined);
});

test('catalogue: at most 100 products', async (t) => {
  const { store, api } = await setup(t);
  const shop = business(store, 'bigshop');
  for (let i = 0; i < 100; i++) store.addProduct('bigshop', { name: `P${i}`, price: i });
  const r = await api('POST', '/me/catalogue/products', { token: shop.token, body: { name: 'one too many' } });
  assert.deepStrictEqual([r.status, r.body.error.code], [409, 'limit_reached']);
});
