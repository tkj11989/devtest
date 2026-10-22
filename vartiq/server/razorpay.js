'use strict';

const crypto = require('crypto');

/**
 * Razorpay, directly: no relay needed.
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
  keyId = process.env.RAZORPAY_KEY_ID,
  keySecret = process.env.RAZORPAY_KEY_SECRET,
  webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET,
  apiBase = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com',
  fetchImpl = fetch,
} = {}) {
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

  return {
    keyId,
    testMode: String(keyId).startsWith('rzp_test_'),
    webhookConfigured: !!webhookSecret,

    /** A payment page for `amount` rupees. `reference` comes back on every notification so we know whose it is. */
    async createLink({ reference, amount, currency, description, user, plan, callbackUrl, expireBy }) {
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
        ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
      });
      if (!link?.id || !link.short_url) throw new Error('Razorpay did not return a payment link');
      return { providerRef: link.id, paymentUrl: link.short_url };
    },

    /** Has this link been paid? `{ paid, paymentId, amountPaise, currency, status }` (asked of Razorpay itself). */
    async linkStatus(providerRef) {
      const link = await api('GET', `/payment_links/${encodeURIComponent(providerRef)}`);
      const captured = (link.payments || []).find((p) => p.status === 'captured' || p.status === 'authorized') || null;
      const paid = link.status === 'paid' && Number(link.amount_paid) > 0;
      return { paid, status: link.status, paymentId: captured?.payment_id || null, amountPaise: Number(link.amount_paid) || 0, currency: link.currency, method: captured?.method || null };
    },

    /** Is this webhook really from Razorpay? (HMAC-SHA256 of the raw body, header `X-Razorpay-Signature`.) */
    verifyWebhook(rawBody, signature) {
      return !!webhookSecret && !!signature && same(hmac(webhookSecret, rawBody), signature);
    },

    /** The address Razorpay sends the person back to carries a signature: `plink_id|reference_id|status|payment_id`. */
    verifyReturn(q = {}) {
      const data = `${q.razorpay_payment_link_id}|${q.razorpay_payment_link_reference_id}|${q.razorpay_payment_link_status}|${q.razorpay_payment_id}`;
      return !!q.razorpay_signature && same(hmac(keySecret, data), q.razorpay_signature);
    },

    /**
     * Turn a webhook body into what we act on: `{ kind: 'paid' | 'refund' | 'ignored', ... }`.
     * paid: `{ reference, paymentId, amountPaise, currency, method }`; refund: `{ paymentId, refundPaise }`.
     */
    parseEvent(body) {
      const ev = body?.event;
      const p = body?.payload || {};
      if (ev === 'payment_link.paid') {
        const link = p.payment_link?.entity || {};
        const pay = p.payment?.entity || {};
        return { kind: 'paid', reference: link.reference_id, paymentId: pay.id, amountPaise: Number(pay.amount ?? link.amount_paid), currency: pay.currency || link.currency, method: pay.method || null, status: pay.status || link.status };
      }
      if (ev === 'refund.processed' || ev === 'refund.created') {
        const r = p.refund?.entity || {};
        return { kind: 'refund', paymentId: r.payment_id || p.payment?.entity?.id, refundPaise: Number(r.amount), done: ev === 'refund.processed' };
      }
      return { kind: 'ignored', event: ev };
    },
  };
}

module.exports = { createRazorpay, hmac };
