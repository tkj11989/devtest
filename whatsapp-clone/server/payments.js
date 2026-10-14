'use strict';

const crypto = require('crypto');

/**
 * Premium subscriptions: daily, monthly or yearly, paid in advance (no auto-renewal).
 *
 * ChatApp never handles card or bank details. Paying happens on the payment provider's own
 * page; the server only creates an order, then asks the provider whether it was paid before
 * switching Premium on (nothing the browser says is trusted).
 *
 * Gateway contract (any provider behind a small relay: Razorpay, Stripe, PayU, Cashfree…):
 * `POST $PAYMENT_WEBHOOK_URL` with JSON, `Authorization: Bearer $PAYMENT_WEBHOOK_TOKEN` when set:
 *   { action: "create", reference, plan, amount, currency, user } -> { paymentUrl }
 *   { action: "status", reference }                                -> { paid: true | false }
 * `PAYMENTS_SANDBOX=1` pretends every order is paid (development only: it gives Premium away).
 */

const DEFAULT_PLANS = {
  daily: { label: 'Daily', price: 9, period: { days: 1 } },
  monthly: { label: 'Monthly', price: 99, period: { months: 1 } },
  yearly: { label: 'Yearly', price: 999, period: { years: 1 } },
};

class PaymentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** `from` (ms) + one period (calendar months/years, so "monthly" is a real month). */
function addPeriod(from, period) {
  const d = new Date(from);
  if (period.years || period.months) {
    // Jan 31 + 1 month is Feb 28/29, not early March.
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCFullYear(d.getUTCFullYear() + (period.years || 0));
    d.setUTCMonth(d.getUTCMonth() + (period.months || 0));
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  if (period.days) d.setUTCDate(d.getUTCDate() + period.days);
  return d.getTime();
}

function createPayments({ store, gateway = null, sandbox = false, plans = DEFAULT_PLANS, currency = 'INR', ordersPerHour = 10, orderTtlMs = 60 * 60 * 1000 } = {}) {
  const orders = new Map(); // reference -> { user, plan, amount, expiresAt }
  const attempts = new Map(); // user -> [timestamps]
  const available = !!(gateway || sandbox);

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ref, o] of orders) if (o.expiresAt <= now) orders.delete(ref);
  }, 60 * 1000);
  sweep.unref();

  const listPlans = () => Object.entries(plans).map(([id, p]) => ({ id, label: p.label, price: store.getSettings().prices[id] ?? p.price, currency }));

  async function checkout(user, planId) {
    if (!available) throw new PaymentError(503, 'payments_unavailable', 'Subscriptions are not available right now');
    const base = plans[planId];
    // Administrators can override a plan's price.
    const plan = base && { ...base, price: store.getSettings().prices[planId] ?? base.price };
    if (!plan) throw new PaymentError(400, 'invalid_request', `plan must be one of: ${Object.keys(plans).join(', ')}`);
    const now = Date.now();
    const recent = (attempts.get(user) || []).filter((t) => t > now - 60 * 60 * 1000);
    if (recent.length >= ordersPerHour) throw new PaymentError(429, 'rate_limited', 'Too many payment attempts. Try again later.');
    const reference = `ord_${crypto.randomBytes(12).toString('hex')}`;
    let paymentUrl = null;
    if (gateway) {
      try {
        ({ paymentUrl } = await gateway({ action: 'create', reference, plan: planId, amount: plan.price, currency, user }));
      } catch (err) {
        console.error('Payment gateway create failed:', err.message);
        throw new PaymentError(502, 'payment_gateway_failed', 'The payment service could not start the payment. Try again shortly.');
      }
      if (!paymentUrl) throw new PaymentError(502, 'payment_gateway_failed', 'The payment service did not answer correctly');
    }
    recent.push(now);
    attempts.set(user, recent);
    orders.set(reference, { user, plan: planId, amount: plan.price, expiresAt: now + orderTtlMs });
    return { orderId: reference, plan: planId, amount: plan.price, currency, paymentUrl, sandbox: !gateway };
  }

  /** Ask the provider whether the order was paid; if so, switch Premium on (once per order). */
  async function confirm(user, orderId) {
    const order = orders.get(String(orderId || ''));
    if (!order || order.user !== user) throw new PaymentError(404, 'not_found', 'Order not found or expired. Start again.');
    let paid;
    if (gateway) {
      try {
        ({ paid } = await gateway({ action: 'status', reference: orderId }));
      } catch (err) {
        console.error('Payment gateway status failed:', err.message);
        throw new PaymentError(502, 'payment_gateway_failed', 'The payment service is not answering. Try again.');
      }
    } else {
      paid = true; // sandbox
    }
    if (!paid) throw new PaymentError(402, 'payment_pending', 'Payment not received yet. Finish paying, then confirm again.');
    orders.delete(orderId); // a paid order is used once
    const current = store.subscriptionOf(user);
    const base = Math.max(Date.now(), current?.expiresAt || 0); // buying while Premium extends it
    return store.activateSubscription(user, { plan: order.plan, expiresAt: addPeriod(base, plans[order.plan].period) });
  }

  return { available, sandbox: !gateway && sandbox, listPlans, checkout, confirm, stop: () => clearInterval(sweep), PaymentError };
}

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

/** Plan prices from the environment, e.g. PLAN_PRICES='{"daily":19,"monthly":149,"yearly":1499}'. */
function plansFromEnv(env = process.env) {
  if (!env.PLAN_PRICES) return DEFAULT_PLANS;
  try {
    const prices = JSON.parse(env.PLAN_PRICES);
    return Object.fromEntries(Object.entries(DEFAULT_PLANS).map(([id, p]) => [id, { ...p, price: Number(prices[id]) > 0 ? Number(prices[id]) : p.price }]));
  } catch (err) {
    console.error('Invalid PLAN_PRICES JSON, using defaults:', err.message);
    return DEFAULT_PLANS;
  }
}

module.exports = { createPayments, createPaymentGateway, plansFromEnv, addPeriod, PaymentError, DEFAULT_PLANS };
