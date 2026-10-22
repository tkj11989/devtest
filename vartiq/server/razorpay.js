'use strict';

const crypto = require('crypto');

/**
 * Razorpay as a payment provider (the interface is described in payment-providers.js; another vendor is another file like
 * this one). No relay needed.
 *
 * VartiQ never sees a card, UPI or bank detail. For each purchase it creates a Razorpay **Payment Link** (a payment page
 * hosted by Razorpay, with UPI, cards, netbanking and wallets), sends the person there, and switches Premium on only
 * when Razorpay itself says the payment was received:
 *
 *  - the **webhook** (`payment_link.paid`, signed with `RAZORPAY_WEBHOOK_SECRET`) tells the server even if the person
 *    closed the page, and
 *  - the **return page** and the app's "I have paid" button ask Razorpay (with the secret API key) whether the link was
 *    paid, and check the signature Razorpay puts on the return address.
 *
 * Nothing the browser says is trusted: amounts and currency are checked against the order, and every payment switches
 * Premium on once, however many times it is reported.
 *
 * Environment: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (Dashboard, Account & Settings, API keys),
 * RAZORPAY_WEBHOOK_SECRET (Dashboard, Webhooks). Test keys (`rzp_test_…`) work against Razorpay's test mode.
 */

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function createRazorpay({
  keyId,
  keySecret,
  webhookSecret,
  apiBase,
  fetchImpl = fetch,
} = {}) {
  apiBase ||= 'https://api.razorpay.com';
  if (!keyId || !keySecret) return null;
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  async function api(method, path, body) {
    const res = await fetchImpl(`${apiBase}/v1${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Razorpay answered ${res.status}: ${data?.error?.description || 'error'}`), { status: res.status });
    return data;
  }

  // The payment provider interface (see payment-providers.js): the rest of the app only uses these.
  return {
    id: 'razorpay',
    label: 'Razorpay',
    testMode: String(keyId).startsWith('rzp_test_'),
    webhookConfigured: !!webhookSecret,

    /** A payment page for `amount` (major units, e.g. rupees). `reference` comes back on every notification. */
    async createCheckout({ reference, amount, currency, description, user, plan, returnUrl, expireBy }) {
      const link = await api('POST', '/payment_links', {
        amount: Math.round(amount * 100), // paise
        currency,
        accept_partial: false,
        reference_id: reference,
        description,
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { user, plan, reference },
        ...(expireBy ? { expire_by: Math.floor(expireBy / 1000) } : {}),
        ...(returnUrl ? { callback_url: returnUrl, callback_method: 'get' } : {}),
      });
      if (!link?.id || !link.short_url) throw new Error('Razorpay did not return a payment link');
      return { providerRef: link.id, paymentUrl: link.short_url };
    },

    /** Ask Razorpay itself whether the order was paid: `{ paid, paymentId, amountMinor, currency, method }`. */
    async status({ providerRef }) {
      const link = await api('GET', `/payment_links/${encodeURIComponent(providerRef)}`);
      const captured = (link.payments || []).find((p) => p.status === 'captured' || p.status === 'authorized') || null;
      const paid = link.status === 'paid' && Number(link.amount_paid) > 0;
      return { paid, paymentId: captured?.payment_id || null, amountMinor: Number(link.amount_paid) || 0, currency: link.currency, method: captured?.method || null };
    },

    /** Is this webhook really from Razorpay? (HMAC-SHA256 of the raw body, header `X-Razorpay-Signature`.) */
    verifyWebhook(rawBody, headers = {}) {
      const signature = headers['x-razorpay-signature'];
      return !!webhookSecret && !!signature && same(hmac(webhookSecret, rawBody), signature);
    },

    /** What a webhook says: `{ kind: 'paid', reference, paymentId, amountMinor, currency, method }`, `{ kind: 'refund', paymentId, refundMinor }`, or `{ kind: 'ignored' }`. */
    parseWebhook(body) {
      const ev = body?.event;
      const p = body?.payload || {};
      if (ev === 'payment_link.paid') {
        const link = p.payment_link?.entity || {};
        const pay = p.payment?.entity || {};
        const ok = !pay.status || ['captured', 'paid'].includes(pay.status);
        return ok
          ? { kind: 'paid', reference: link.reference_id, paymentId: pay.id, amountMinor: Number(pay.amount ?? link.amount_paid), currency: pay.currency || link.currency, method: pay.method || null }
          : { kind: 'ignored', event: ev };
      }
      if (ev === 'refund.processed') {
        const r = p.refund?.entity || {};
        return { kind: 'refund', paymentId: r.payment_id || p.payment?.entity?.id, refundMinor: Number(r.amount) };
      }
      return { kind: 'ignored', event: ev };
    },

    /** The address the person comes back to carries a signature: `plink_id|reference_id|status|payment_id`. */
    verifyReturn(q = {}) {
      const data = `${q.razorpay_payment_link_id}|${q.razorpay_payment_link_reference_id}|${q.razorpay_payment_link_status}|${q.razorpay_payment_id}`;
      const valid = !!q.razorpay_signature && same(hmac(keySecret, data), q.razorpay_signature);
      return { valid, paid: valid && q.razorpay_payment_link_status === 'paid', reference: String(q.razorpay_payment_link_reference_id || ''), paymentId: q.razorpay_payment_id || null };
    },
  };
}

module.exports = { createRazorpay, hmac };
