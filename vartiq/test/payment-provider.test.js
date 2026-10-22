'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const { selectProvider, relayProvider, sandboxProvider } = require('../server/payment-providers');

/**
 * A made-up second vendor, "Acme Pay", written only against the provider interface. If the app works with it, switching
 * away from Razorpay means writing one such file and setting PAYMENT_PROVIDER: nothing in payments.js or the routes changes.
 */
function acmeProvider() {
  const orders = new Map();
  const sign = (raw) => crypto.createHmac('sha1', 'acme-secret').update(raw).digest('base64');
  return {
    id: 'acme',
    label: 'Acme Pay',
    testMode: true,
    sandbox: false,
    webhookConfigured: true,
    orders,
    sign,
    async createCheckout({ reference, amount, currency, returnUrl }) {
      orders.set(reference, { amount, currency, paid: false });
      return { providerRef: `acme_${reference}`, paymentUrl: `https://pay.acme.example/${reference}?back=${encodeURIComponent(returnUrl || '')}` };
    },
    async status({ reference, amount, currency }) {
      const o = orders.get(reference);
      return { paid: !!o?.paid, paymentId: o?.paid ? `acme_pay_${reference}` : null, amountMinor: Math.round(amount * 100), currency, method: 'wallet' };
    },
    verifyWebhook: (raw, headers) => headers['x-acme-signature'] === sign(raw),
    parseWebhook: (b) => (b.type === 'charge.ok'
      ? { kind: 'paid', reference: b.order, paymentId: b.id, amountMinor: b.cents, currency: b.cur, method: 'wallet' }
      : b.type === 'charge.refunded' ? { kind: 'refund', paymentId: b.id, refundMinor: b.cents } : { kind: 'ignored' }),
    verifyReturn: (q) => ({ valid: q.sig === 'ok', paid: q.sig === 'ok' && q.state === 'paid', reference: q.order || '', paymentId: q.pay || null }),
  };
}

async function setup(t) {
  const store = new Store({ file: null });
  const acme = acmeProvider();
  const app = createApp({ store, publicUrl: 'https://vartiq.example', paymentProvider: acme, rateLimit: { max: 100000, authMax: 100000 } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  t.after(() => { app.io.close(); app.server.close(); });
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const hook = async (obj, { sig } = {}) => {
    const raw = JSON.stringify(obj);
    const res = await fetch(`${base}/webhooks/acme`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acme-signature': sig ?? acme.sign(raw) }, body: raw });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, acme, api, hook, base };
}

test('another vendor works through the same interface: checkout, webhook, return page, refund, receipts', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const sub = (await env.api('GET', '/me/subscription', a.token)).body;
  assert.deepStrictEqual([sub.provider, sub.providerLabel, sub.available], ['acme', 'Acme Pay', true]);

  const order = (await env.api('POST', '/me/subscription/checkout', a.token, { plan: 'monthly' })).body;
  assert.strictEqual(order.provider, 'acme');
  assert.strictEqual(order.providerLabel, 'Acme Pay');
  assert.match(order.paymentUrl, /^https:\/\/pay\.acme\.example\/alice\./);
  assert.ok(order.paymentUrl.includes(encodeURIComponent('https://vartiq.example/premium/return/acme')), 'the return address names the vendor');

  // Its webhook, on its own address, with its own signature scheme.
  assert.strictEqual((await env.hook({ type: 'charge.ok', order: order.orderId, id: 'ch_1', cents: 9900, cur: 'INR' }, { sig: 'wrong' })).status, 400);
  assert.strictEqual((await fetch(`${env.base}/webhooks/razorpay`, { method: 'POST', body: '{}' })).status, 404, 'a vendor that is not in use has no webhook');
  const paid = await env.hook({ type: 'charge.ok', order: order.orderId, id: 'ch_1', cents: 9900, cur: 'INR' });
  assert.deepStrictEqual([paid.status, paid.body.status], [200, 'activated']);
  assert.strictEqual(env.store.isPremium('alice'), true);
  assert.strictEqual((await env.hook({ type: 'charge.ok', order: order.orderId, id: 'ch_1', cents: 9900, cur: 'INR' })).body.status, 'duplicate');
  assert.strictEqual((await env.hook({ type: 'charge.ok', order: 'alice.000000000000', id: 'ch_2', cents: 9900, cur: 'INR' })).body.status, 'unknown');
  const list = (await env.api('GET', '/me/payments', a.token)).body.payments;
  assert.deepStrictEqual([list[0].id, list[0].amount], ['ch_1', 99]);
  assert.strictEqual(env.store.paymentsOf('alice')[0].provider, 'acme', 'the vendor is recorded with each payment');

  // Refund through the same path.
  assert.strictEqual((await env.hook({ type: 'charge.refunded', id: 'ch_1', cents: 9900 })).body.status, 'refunded');
  assert.strictEqual(env.store.isPremium('alice'), false);

  // "I have paid": the app asks the vendor.
  const o2 = (await env.api('POST', '/me/subscription/checkout', a.token, { plan: 'daily' })).body;
  assert.strictEqual((await env.api('POST', '/me/subscription/confirm', a.token, { orderId: o2.orderId })).body.error.code, 'payment_pending');
  env.acme.orders.get(o2.orderId).paid = true;
  assert.strictEqual((await env.api('POST', '/me/subscription/confirm', a.token, { orderId: o2.orderId })).body.premium, true);

  // Its return page.
  const o3 = (await env.api('POST', '/me/subscription/checkout', a.token, { plan: 'monthly' })).body;
  env.acme.orders.get(o3.orderId).paid = true;
  const bad = await fetch(`${env.base}/premium/return/acme?sig=nope&order=${o3.orderId}&state=paid`);
  assert.strictEqual(bad.status, 400);
  const ok = await fetch(`${env.base}/premium/return/acme?sig=ok&order=${encodeURIComponent(o3.orderId)}&state=paid&pay=p3`);
  assert.strictEqual(ok.status, 200);
  assert.match(await ok.text(), /Payment received/);
  assert.strictEqual(env.store.paymentsOf('alice').length, 3);
  assert.strictEqual((await fetch(`${env.base}/premium/return/razorpay?x=1`)).status, 404);
});

test('choosing the vendor: PAYMENT_PROVIDER, or the first one that is configured', () => {
  const none = selectProvider({ env: {} });
  assert.strictEqual(none, null, 'nothing configured: subscriptions are unavailable');
  assert.strictEqual(selectProvider({ env: { RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 's' } }).id, 'razorpay');
  assert.strictEqual(selectProvider({ env: { PAYMENT_WEBHOOK_URL: 'https://relay.example' } }).id, 'relay');
  assert.strictEqual(selectProvider({ env: { PAYMENTS_SANDBOX: '1' } }).id, 'sandbox');
  assert.strictEqual(selectProvider({ env: { RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', PAYMENT_WEBHOOK_URL: 'https://r.example' } }).id, 'razorpay', 'Razorpay first');
  assert.strictEqual(selectProvider({ env: { PAYMENT_PROVIDER: 'relay', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', PAYMENT_WEBHOOK_URL: 'https://r.example' } }).id, 'relay', 'PAYMENT_PROVIDER decides');
  assert.throws(() => selectProvider({ env: { PAYMENT_PROVIDER: 'paypal' } }), /PAYMENT_PROVIDER must be one of: razorpay, relay, sandbox/);
  const test = selectProvider({ env: { RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 's' } });
  assert.deepStrictEqual([test.testMode, test.webhookConfigured, typeof test.createCheckout, typeof test.status, typeof test.verifyWebhook, typeof test.parseWebhook, typeof test.verifyReturn], [true, false, 'function', 'function', 'function', 'function', 'function'], 'every provider has the whole interface');
  for (const p of [relayProvider(async () => ({})), sandboxProvider()]) {
    for (const fn of ['createCheckout', 'status', 'verifyWebhook', 'parseWebhook', 'verifyReturn']) assert.strictEqual(typeof p[fn], 'function', `${p.id}.${fn}`);
  }
});
