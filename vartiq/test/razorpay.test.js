'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const KEY_ID = 'rzp_test_abc123';
const KEY_SECRET = 'key-secret-xyz';
const WEBHOOK_SECRET = 'whsec_test';
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const once = (s, ev, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); resolve(p); });
});

/** A stand-in for api.razorpay.com: creates payment links and says whether they were paid. */
async function fakeRazorpay(t) {
  const links = new Map();
  const requests = [];
  const behaviour = { fail: false };
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (behaviour.fail) return send(500, { error: { description: 'boom' } });
      if (req.headers.authorization !== `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`) return send(401, { error: { description: 'Authentication failed' } });
      if (req.method === 'POST' && req.url === '/v1/payment_links') {
        const b = JSON.parse(body);
        n += 1;
        const link = { id: `plink_${n}`, short_url: `https://rzp.io/i/test${n}`, status: 'created', amount: b.amount, amount_paid: 0, currency: b.currency, reference_id: b.reference_id, payments: null };
        links.set(link.id, link);
        return send(200, link);
      }
      const m = /^\/v1\/payment_links\/([^/]+)$/.exec(req.url);
      if (req.method === 'GET' && m && links.has(m[1])) return send(200, links.get(m[1]));
      return send(404, { error: { description: 'not found' } });
    });
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  return {
    base: `http://localhost:${server.address().port}`,
    requests,
    behaviour,
    links,
    pay(id, { paymentId = `pay_${id.replace('plink_', 'T')}`, amountMinor, method = 'upi' } = {}) {
      const l = links.get(id);
      l.status = 'paid';
      l.amount_paid = amountMinor ?? l.amount;
      l.payments = [{ payment_id: paymentId, status: 'captured', amount: l.amount_paid, method }];
      return paymentId;
    },
  };
}

async function setup(t, { publicUrl = 'https://vartiq.example', store = new Store({ file: null }), ...opts } = {}) {
  const rz = await fakeRazorpay(t);
  const app = createApp({
    store,
    publicUrl,
    razorpay: { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, apiBase: rz.base },
    admin: { username: 'root', password: 'correct-horse-battery' },
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
  /** Razorpay calling our webhook, signed like the real one. */
  const webhook = async (event, { secret = WEBHOOK_SECRET, raw } = {}) => {
    const text = raw ?? JSON.stringify(event);
    const res = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmac(secret, text) }, body: text });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const admin = async (path) => {
    const login = await (await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'correct-horse-battery' }) })).json();
    const res = await fetch(`${base}/admin/api${path}`, { headers: { Authorization: `Bearer ${login.token}` } });
    return { status: res.status, body: await res.json() };
  };
  return { store, app, rz, api, client, webhook, admin, base };
}

const paidEvent = ({ reference, linkId = 'plink_1', paymentId, amountMinor, currency = 'INR', status = 'captured' }) => ({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: linkId, reference_id: reference, amount: amountMinor, amount_paid: amountMinor, currency, status: 'paid' } },
    payment: { entity: { id: paymentId, amount: amountMinor, currency, status, method: 'upi', notes: { reference } } },
  },
});
const refundEvent = ({ paymentId, amountMinor, event = 'refund.processed' }) => ({ event, payload: { refund: { entity: { id: 'rfnd_1', payment_id: paymentId, amount: amountMinor } } } });
const buy = (env, token, plan = 'monthly') => env.api('POST', '/me/subscription/checkout', token, { plan });

test('checkout creates a Razorpay payment link with the right amount, reference and return address', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const res = await buy(env, a.token, 'monthly');
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.provider, 'razorpay');
  assert.strictEqual(res.body.paymentUrl, 'https://rzp.io/i/test1');
  assert.strictEqual(res.body.sandbox, false);
  assert.ok(res.body.orderId.startsWith('alice.') && res.body.orderId.length <= 40, 'a reference Razorpay accepts, starting with the username');

  const req = env.rz.requests.find((r) => r.method === 'POST');
  assert.strictEqual(req.auth, `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`, 'with the API key');
  assert.strictEqual(req.body.amount, 9900, 'in paise');
  assert.strictEqual(req.body.currency, 'INR');
  assert.strictEqual(req.body.reference_id, res.body.orderId);
  assert.strictEqual(req.body.accept_partial, false);
  assert.strictEqual(req.body.callback_url, 'https://vartiq.example/premium/return/razorpay');
  assert.deepStrictEqual(req.body.notify, { sms: false, email: false }, 'Razorpay does not message the person');
  assert.strictEqual(req.body.notes.user, 'alice');
  assert.ok(req.body.expire_by > Date.now() / 1000 && req.body.expire_by < Date.now() / 1000 + 3700);
  assert.ok(!JSON.stringify(req.body).includes('+91'), 'no phone number is sent');

  // Prices with paise, and the plan list.
  env.store.updateSettings({ prices: { monthly: 149.5 } });
  await buy(env, a.token, 'monthly');
  assert.strictEqual(env.rz.requests.filter((r) => r.method === 'POST').at(-1).body.amount, 14950);
  const sub = (await env.api('GET', '/me/subscription', a.token)).body;
  assert.strictEqual(sub.provider, 'razorpay');
  assert.deepStrictEqual(sub.plans.map((p) => p.id), ['daily', 'monthly', 'quarterly', 'halfyearly', 'yearly']);
  const yearly = sub.plans.find((p) => p.id === 'yearly');
  assert.strictEqual(yearly.months, 12);
  assert.ok(yearly.savePct >= 10, `a yearly plan shows what it saves (${yearly.savePct}%)`);
  assert.strictEqual(sub.plans.find((p) => p.id === 'monthly').savePct, 0);

  // A plan the administrator switched off cannot be bought or shown.
  env.store.updateSettings({ disabledPlans: ['daily'] });
  assert.ok(!(await env.api('GET', '/me/subscription', a.token)).body.plans.some((p) => p.id === 'daily'));
  const off = await buy(env, a.token, 'daily');
  assert.deepStrictEqual([off.status, off.body.error.code], [400, 'plan_unavailable']);
  assert.throws(() => env.store.updateSettings({ disabledPlans: ['daily', 'monthly', 'quarterly', 'halfyearly', 'yearly'] }), /At least one plan/);
  assert.throws(() => env.store.updateSettings({ disabledPlans: ['nope'] }), /disabledPlans/);

  // Razorpay down: a clear error, and no half-made order.
  env.rz.behaviour.fail = true;
  const down = await buy(env, a.token, 'yearly');
  assert.deepStrictEqual([down.status, down.body.error.code], [502, 'payment_gateway_failed']);
});

test('"payment received": a signed webhook switches Premium on once, even if sent twice', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const sock = await env.client(a.token);
  const order = (await buy(env, a.token, 'monthly')).body;
  const paymentId = env.rz.pay('plink_1');

  const received = once(sock, 'payment:received');
  const updated = once(sock, 'subscription:update');
  const res = await env.webhook(paidEvent({ reference: order.orderId, paymentId, amountMinor: 9900 }));
  assert.deepStrictEqual([res.status, res.body.status], [200, 'activated']);
  const got = await received;
  assert.strictEqual(got.payment.id, paymentId);
  assert.strictEqual(got.payment.amount, 99);
  assert.strictEqual(got.subscription.premium, true);
  assert.strictEqual((await updated).premium, true);
  assert.strictEqual(env.store.isPremium('alice'), true);
  const until = env.store.subscriptionOf('alice').expiresAt;
  assert.ok(until > Date.now() + 27 * 86400000 && until < Date.now() + 32 * 86400000, 'a month');

  // Razorpay retries webhooks: nothing more happens.
  const again = await env.webhook(paidEvent({ reference: order.orderId, paymentId, amountMinor: 9900 }));
  assert.deepStrictEqual([again.status, again.body.status], [200, 'duplicate']);
  assert.strictEqual(env.store.subscriptionOf('alice').expiresAt, until, 'Premium was not extended again');
  assert.strictEqual(env.store.paymentsOf('alice').length, 1);

  // The receipt.
  const list = (await env.api('GET', '/me/payments', a.token)).body.payments;
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual([list[0].id, list[0].plan, list[0].amount, list[0].currency], [paymentId, 'monthly', 99, 'INR']);
  assert.strictEqual(list[0].periodEnd, until);
  assert.strictEqual((await env.api('GET', '/me/subscription', a.token)).body.payments[0].id, paymentId);
  assert.ok(!JSON.stringify(list).includes('plink'), 'nothing internal');
});

test('the webhook only trusts Razorpay: signature, amount, currency and a known order', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const order = (await buy(env, a.token, 'monthly')).body;
  const good = paidEvent({ reference: order.orderId, paymentId: 'pay_1', amountMinor: 9900 });

  assert.strictEqual((await env.webhook(good, { secret: 'not-the-secret' })).status, 400, 'wrong signature');
  const noSig = await fetch(`${env.base}/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good) });
  assert.strictEqual(noSig.status, 400, 'no signature');
  assert.strictEqual((await env.webhook(null, { raw: 'not json at all' })).status, 400, 'signed, but not JSON');
  assert.strictEqual(env.store.isPremium('alice'), false, 'nothing switched on yet');

  assert.strictEqual((await env.webhook(paidEvent({ reference: order.orderId, paymentId: 'pay_2', amountMinor: 100 }))).body.status, 'mismatch', 'paid less than the plan costs');
  assert.strictEqual((await env.webhook(paidEvent({ reference: order.orderId, paymentId: 'pay_3', amountMinor: 9900, currency: 'USD' }))).body.status, 'mismatch', 'wrong currency');
  assert.strictEqual((await env.webhook(paidEvent({ reference: 'alice.deadbeef0000', paymentId: 'pay_4', amountMinor: 9900 }))).body.status, 'unknown', 'not our order');
  assert.strictEqual((await env.webhook(paidEvent({ reference: 'ghost.deadbeef0000', paymentId: 'pay_5', amountMinor: 9900 }))).body.status, 'unknown', 'not our user');
  assert.strictEqual((await env.webhook(paidEvent({ reference: order.orderId, paymentId: 'pay_6', amountMinor: 9900, status: 'failed' }))).body.status, 'ignored', 'a payment that did not go through');
  assert.strictEqual((await env.webhook({ event: 'payment.failed', payload: {} })).body.status, 'ignored');
  assert.strictEqual(env.store.isPremium('alice'), false, 'none of those switched Premium on');
  assert.strictEqual(env.store.paymentsOf('alice').length, 0);

  assert.strictEqual((await env.webhook(good)).body.status, 'activated');
  assert.strictEqual(env.store.isPremium('alice'), true);
  // The same order cannot be paid for twice: a second payment on it is not credited.
  assert.strictEqual((await env.webhook(paidEvent({ reference: order.orderId, paymentId: 'pay_7', amountMinor: 9900 }))).body.status, 'duplicate');
  assert.strictEqual(env.store.paymentsOf('alice').length, 1);

  // Without a webhook secret the endpoint is closed.
  const closed = await setup(t, { razorpay: { keyId: KEY_ID, keySecret: KEY_SECRET, apiBase: env.rz.base } });
  assert.strictEqual((await closed.webhook(good)).status, 503);
});

test('"I have paid": the server asks Razorpay; a later webhook changes nothing', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const order = (await buy(env, a.token, 'quarterly')).body;
  const confirm = () => env.api('POST', '/me/subscription/confirm', a.token, { orderId: order.orderId });

  const pending = await confirm();
  assert.deepStrictEqual([pending.status, pending.body.error.code], [402, 'payment_pending'], 'Razorpay says not paid');
  assert.strictEqual(env.store.isPremium('alice'), false);

  const paymentId = env.rz.pay('plink_1', { amountMinor: 27900 });
  const done = await confirm();
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.strictEqual(done.body.premium, true);
  assert.strictEqual(done.body.plan, 'quarterly');
  const until = env.store.subscriptionOf('alice').expiresAt;
  assert.ok(until > Date.now() + 88 * 86400000, 'three months');

  assert.strictEqual((await confirm()).status, 200, 'asking again is harmless');
  assert.strictEqual((await env.webhook(paidEvent({ reference: order.orderId, paymentId, amountMinor: 27900 }))).body.status, 'duplicate');
  assert.strictEqual(env.store.subscriptionOf('alice').expiresAt, until);
  assert.strictEqual(env.store.paymentsOf('alice').length, 1);

  const stranger = env.store.register('mallory', 'pass');
  assert.strictEqual((await env.api('POST', '/me/subscription/confirm', stranger.token, { orderId: order.orderId })).status, 404, "someone else's order");

  // Razorpay not answering is a clear error, not a free Premium.
  const o2 = (await buy(env, a.token, 'daily')).body;
  env.rz.behaviour.fail = true;
  assert.strictEqual((await env.api('POST', '/me/subscription/confirm', a.token, { orderId: o2.orderId })).status, 502);
});

test('buying again extends Premium from where it ends', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const first = (await buy(env, a.token, 'monthly')).body;
  await env.webhook(paidEvent({ reference: first.orderId, linkId: 'plink_1', paymentId: env.rz.pay('plink_1'), amountMinor: 9900 }));
  const end1 = env.store.subscriptionOf('alice').expiresAt;
  const second = (await buy(env, a.token, 'yearly')).body;
  await env.webhook(paidEvent({ reference: second.orderId, linkId: 'plink_2', paymentId: env.rz.pay('plink_2'), amountMinor: 99900 }));
  const end2 = env.store.subscriptionOf('alice').expiresAt;
  assert.ok(end2 > end1 + 360 * 86400000, 'a year on top of the month');
  assert.strictEqual(env.store.paymentsOf('alice').length, 2);
  assert.strictEqual(env.store.paymentsOf('alice')[1].periodStart, end1, 'the second period starts when the first ends');
});

test('the page Razorpay sends people back to checks the signature and asks Razorpay', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const order = (await buy(env, a.token, 'monthly')).body;
  const paymentId = env.rz.pay('plink_1');
  const q = (o = {}) => {
    const p = { razorpay_payment_id: paymentId, razorpay_payment_link_id: 'plink_1', razorpay_payment_link_reference_id: order.orderId, razorpay_payment_link_status: 'paid', ...o };
    p.razorpay_signature = o.razorpay_signature ?? hmac(KEY_SECRET, `${p.razorpay_payment_link_id}|${p.razorpay_payment_link_reference_id}|${p.razorpay_payment_link_status}|${p.razorpay_payment_id}`);
    return new URLSearchParams(p).toString();
  };

  const forged = await fetch(`${env.base}/premium/return?${q({ razorpay_signature: 'f'.repeat(64) })}`);
  assert.strictEqual(forged.status, 400);
  assert.match(await forged.text(), /not valid/);
  assert.strictEqual(env.store.isPremium('alice'), false, 'a made-up address switches nothing on');
  const none = await fetch(`${env.base}/premium/return`);
  assert.strictEqual(none.status, 400);

  const cancelled = await fetch(`${env.base}/premium/return?${q({ razorpay_payment_link_status: 'cancelled' })}`);
  assert.match(await cancelled.text(), /not completed/i);
  assert.strictEqual(env.store.isPremium('alice'), false);

  const ok = await fetch(`${env.base}/premium/return?${q()}`);
  assert.strictEqual(ok.status, 200);
  assert.match(await ok.text(), /Payment received/);
  assert.match(ok.headers.get('cache-control'), /no-store/);
  assert.strictEqual(env.store.isPremium('alice'), true, 'and Razorpay confirmed it');
  const until = env.store.subscriptionOf('alice').expiresAt;
  await fetch(`${env.base}/premium/return?${q()}`); // reloading the page
  assert.strictEqual(env.store.subscriptionOf('alice').expiresAt, until, 'once');
  assert.strictEqual(env.store.paymentsOf('alice').length, 1);

  // A correctly signed address for an order Razorpay says is not paid does nothing.
  const o2 = (await buy(env, a.token, 'daily')).body;
  const forgedPaid = new URLSearchParams({ razorpay_payment_id: 'pay_x', razorpay_payment_link_id: 'plink_2', razorpay_payment_link_reference_id: o2.orderId, razorpay_payment_link_status: 'paid' });
  forgedPaid.set('razorpay_signature', hmac(KEY_SECRET, `plink_2|${o2.orderId}|paid|pay_x`));
  await fetch(`${env.base}/premium/return?${forgedPaid}`);
  assert.strictEqual(env.store.paymentsOf('alice').length, 1, 'Razorpay itself said unpaid');
});

test('refunds: a full refund takes back what it bought, a partial one does not', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const sock = await env.client(a.token);
  const o1 = (await buy(env, a.token, 'monthly')).body;
  const p1 = env.rz.pay('plink_1');
  await env.webhook(paidEvent({ reference: o1.orderId, paymentId: p1, amountMinor: 9900 }));
  const o2 = (await buy(env, a.token, 'monthly')).body;
  const p2 = env.rz.pay('plink_2');
  await env.webhook(paidEvent({ reference: o2.orderId, linkId: 'plink_2', paymentId: p2, amountMinor: 9900 }));
  const twoMonths = env.store.subscriptionOf('alice').expiresAt;

  assert.strictEqual((await env.webhook(refundEvent({ paymentId: p2, amountMinor: 5000 }))).body.status, 'refunded');
  assert.strictEqual(env.store.subscriptionOf('alice').expiresAt, twoMonths, 'a part refund keeps Premium');
  assert.strictEqual(env.store.paymentsOf('alice')[1].refundedMinor, 5000);

  const heard = once(sock, 'payment:refunded');
  const full = await env.webhook(refundEvent({ paymentId: p2, amountMinor: 9900 }));
  assert.strictEqual(full.body.status, 'refunded');
  assert.strictEqual((await heard).revoked, true);
  const oneMonth = env.store.subscriptionOf('alice').expiresAt;
  assert.ok(Math.abs((twoMonths - oneMonth) - (env.store.paymentsOf('alice')[1].periodEnd - env.store.paymentsOf('alice')[1].periodStart)) < 1000, 'exactly that purchase is taken back');
  assert.strictEqual(env.store.isPremium('alice'), true, 'the first month is still there');
  await env.webhook(refundEvent({ paymentId: p2, amountMinor: 9900 }));
  assert.strictEqual(env.store.subscriptionOf('alice').expiresAt, oneMonth, 'only once');

  await env.webhook(refundEvent({ paymentId: p1, amountMinor: 9900 }));
  assert.strictEqual(env.store.isPremium('alice'), false, 'refund both and Premium is over');
  assert.strictEqual((await env.webhook(refundEvent({ paymentId: 'pay_unknown', amountMinor: 1 }))).body.status, 'unknown');
  assert.strictEqual((await env.webhook(refundEvent({ paymentId: p1, amountMinor: 9900, event: 'refund.created' }))).body.status, 'ignored', 'only a processed refund counts');
  assert.strictEqual((await env.api('GET', '/me/payments', a.token)).body.payments[0].refunded, 99);
});

test('an order and its payment survive a restart; the record is kept after the account is deleted', async (t) => {
  const env = await setup(t);
  const a = env.store.register('alice', 'pass');
  const order = (await buy(env, a.token, 'monthly')).body;
  const paymentId = env.rz.pay('plink_1');

  // The server restarts while the person is on Razorpay's page: the data comes back from storage.
  const restarted = new Store({ file: null, initialData: JSON.parse(JSON.stringify(env.store.data)) });
  const env2 = await setup(t, { store: restarted });
  assert.strictEqual((await env2.webhook(paidEvent({ reference: order.orderId, paymentId, amountMinor: 9900 }))).body.status, 'activated', 'the payment still finds its order');
  assert.strictEqual(restarted.isPremium('alice'), true);

  // Dashboard and data download.
  const list = (await env2.admin('/payments')).body;
  assert.strictEqual(list.payments[0].id, paymentId);
  assert.strictEqual(list.payments[0].user, 'alice');
  assert.deepStrictEqual(list.totals.INR, { all: 99, last30Days: 99, count: 1 });
  const exp = restarted.exportAccount('alice');
  assert.strictEqual(exp.account.payments[0].id, paymentId);

  // Delete the account: the personal data goes, the payment record stays (accounting) without any personal details.
  restarted.requestAccountDeletion('alice');
  restarted.eraseAccount('alice');
  assert.strictEqual(restarted.data.users.alice, undefined);
  assert.strictEqual(restarted.data.archivedUsers.alice.payments.length, 1);
  const after = (await env2.admin('/payments')).body;
  assert.strictEqual(after.payments[0].deleted, true);
  assert.deepStrictEqual(after.totals.INR, { all: 99, last30Days: 99, count: 1 });
  assert.ok(!JSON.stringify(restarted.data.archivedUsers.alice).includes('+91'));
  // A retried webhook after deletion is harmless.
  assert.strictEqual((await env2.webhook(paidEvent({ reference: order.orderId, paymentId, amountMinor: 9900 }))).status, 200);
});

test('the dashboard shows Razorpay and the plans can be switched and priced', async (t) => {
  const env = await setup(t);
  const o = (await env.admin('/overview')).body;
  assert.strictEqual(o.integrations.payments, 'razorpay (test mode)');
  const settings = await env.admin('/settings');
  assert.deepStrictEqual(settings.body.settings.disabledPlans, []);
});
