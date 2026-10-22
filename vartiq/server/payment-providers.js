'use strict';

/**
 * Payment providers: the only place that knows who takes the money.
 *
 * The rest of the app (payments.js, the webhook and return routes) talks to a provider object with this shape, so moving
 * to another vendor means writing one more file like razorpay.js and choosing it with PAYMENT_PROVIDER:
 *
 *   id, label            'razorpay', 'Razorpay' (the label is shown to people; the id is stored with each order)
 *   testMode             true while using the vendor's test keys (shown to administrators)
 *   sandbox              true only for the development stand-in (never in production)
 *   webhookConfigured    can the vendor's notifications be verified?
 *   createCheckout({ reference, amount, currency, description, user, plan, returnUrl, expireBy })
 *                        -> { providerRef, paymentUrl }   (`amount` in major units, e.g. rupees)
 *   status({ providerRef, reference, amount, currency })
 *                        -> { paid, paymentId, amountMinor, currency, method }   asked of the vendor itself
 *   verifyWebhook(rawBody, headers) -> boolean   (the vendor's signature check)
 *   parseWebhook(jsonBody) -> { kind: 'paid', reference, paymentId, amountMinor, currency, method }
 *                           | { kind: 'refund', paymentId, refundMinor } | { kind: 'ignored' }
 *   verifyReturn(query)    -> { valid, paid, reference, paymentId }   the address the person comes back to
 *
 * `amountMinor` is in the smallest unit (paise for INR: 100 per rupee). Routes: `POST /webhooks/<id>` and
 * `GET /premium/return/<id>`.
 */

/** The generic relay (any vendor behind a small service you run): see payments.js for its two calls. */
function createPaymentGateway(env = process.env) {
  if (!env.PAYMENT_WEBHOOK_URL) return null;
  return async (body) => {
    const res = await fetch(env.PAYMENT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.PAYMENT_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.PAYMENT_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`gateway answered ${res.status}`);
    return res.json();
  };
}

/** Wraps a relay function `gateway({ action: 'create' | 'status', … })` as a provider (no webhooks: the app asks the relay). */
function relayProvider(gateway) {
  return {
    id: 'relay',
    label: 'the payment service',
    testMode: false,
    sandbox: false,
    webhookConfigured: false,
    async createCheckout({ reference, amount, currency, user, plan }) {
      const { paymentUrl } = await gateway({ action: 'create', reference, plan, amount, currency, user });
      if (!paymentUrl) throw new Error('the relay returned no paymentUrl');
      return { providerRef: null, paymentUrl };
    },
    async status({ reference, amount, currency }) {
      const r = await gateway({ action: 'status', reference });
      return { paid: !!r.paid, paymentId: r.paymentId || null, amountMinor: Math.round(amount * 100), currency, method: null };
    },
    verifyWebhook: () => false,
    parseWebhook: () => ({ kind: 'ignored' }),
    verifyReturn: () => ({ valid: false, paid: false, reference: '', paymentId: null }),
  };
}

/** Development only: every order counts as paid, nothing is charged. Gives Premium away: never in production. */
function sandboxProvider() {
  return {
    id: 'sandbox',
    label: 'sandbox',
    testMode: true,
    sandbox: true,
    webhookConfigured: false,
    async createCheckout() { return { providerRef: null, paymentUrl: null }; },
    async status({ amount, currency }) { return { paid: true, paymentId: null, amountMinor: Math.round(amount * 100), currency, method: null }; },
    verifyWebhook: () => false,
    parseWebhook: () => ({ kind: 'ignored' }),
    verifyReturn: () => ({ valid: false, paid: false, reference: '', paymentId: null }),
  };
}

/**
 * Choose the provider. `PAYMENT_PROVIDER` (razorpay | relay | sandbox) picks one; without it the first one that is configured
 * is used: Razorpay (RAZORPAY_KEY_ID and _SECRET), then the relay (PAYMENT_WEBHOOK_URL), then the sandbox (PAYMENTS_SANDBOX=1).
 * To add a vendor: write its provider file and add one line to `registry`.
 */
function selectProvider({ env = process.env, razorpay = {}, gateway = createPaymentGateway(env) } = {}) {
  const { createRazorpay } = require('./razorpay');
  const registry = {
    razorpay: () => createRazorpay({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, apiBase: env.RAZORPAY_API_BASE, ...razorpay }),
    relay: () => (gateway ? relayProvider(gateway) : null),
    sandbox: () => (env.PAYMENTS_SANDBOX === '1' ? sandboxProvider() : null),
  };
  const want = env.PAYMENT_PROVIDER;
  if (want) {
    if (!registry[want]) throw new Error(`PAYMENT_PROVIDER must be one of: ${Object.keys(registry).join(', ')}`);
    return registry[want]();
  }
  for (const make of Object.values(registry)) {
    const p = make();
    if (p) return p;
  }
  return null;
}

module.exports = { createPaymentGateway, relayProvider, sandboxProvider, selectProvider };
