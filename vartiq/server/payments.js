'use strict';

const crypto = require('crypto');

/**
 * Premium subscriptions: daily, monthly, 3 months, 6 months or yearly, paid in advance (no auto-renewal).
 *
 * VartiQ never handles card, UPI or bank details. Paying happens on the payment provider's own page; the server creates an
 * order, and switches Premium on only when the provider itself says the payment was received (a signed notification, a signed
 * return address, or the server asking the provider): nothing the browser says is trusted.
 *
 * Who takes the money is a provider (payment-providers.js; Razorpay today). This file never mentions a vendor, so changing
 * vendor does not change it.
 */

const DEFAULT_PLANS = {
  daily: { label: 'Daily', price: 9, period: { days: 1 } },
  monthly: { label: 'Monthly', price: 99, period: { months: 1 }, months: 1 },
  quarterly: { label: '3 months', price: 279, period: { months: 3 }, months: 3 },
  halfyearly: { label: '6 months', price: 529, period: { months: 6 }, months: 6 },
  yearly: { label: 'Yearly', price: 999, period: { years: 1 }, months: 12 },
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

/**
 * Options:
 *   provider   who takes the payment (see payment-providers.js). `gateway` (a relay function) or `sandbox: true` are shortcuts
 *              that wrap themselves as a provider
 *   onPaid     ({ user, entry }) called once for every payment received (the app tells the person "Payment received")
 *   onRefund   ({ user, entry, revoked }) when a payment is refunded
 *   publicUrl  where the app lives, for the address Razorpay sends people back to
 */
function createPayments({ store, provider = null, gateway = null, sandbox = false, plans = DEFAULT_PLANS, currency = 'INR', ordersPerHour = 10, orderTtlMs = 60 * 60 * 1000, onPaid = () => {}, onRefund = () => {}, publicUrl = process.env.PUBLIC_URL } = {}) {
  const attempts = new Map(); // user -> [timestamps]
  if (!provider) {
    const pp = require('./payment-providers');
    provider = gateway ? pp.relayProvider(gateway) : sandbox ? pp.sandboxProvider() : null;
  }
  const available = !!provider;

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [u, list] of attempts) {
      const recent = list.filter((t) => t > now - 60 * 60 * 1000);
      if (recent.length) attempts.set(u, recent);
      else attempts.delete(u);
    }
  }, 5 * 60 * 1000);
  sweep.unref();

  const priceOf = (id) => store.getSettings().prices[id] ?? plans[id].price;
  const enabled = (id) => !!plans[id] && !(store.getSettings().disabledPlans || []).includes(id);

  /** The plans people can buy now, with what they save compared with paying monthly. */
  const listPlans = () => {
    const monthly = plans.monthly ? priceOf('monthly') : null;
    return Object.entries(plans).filter(([id]) => enabled(id)).map(([id, p]) => {
      const price = priceOf(id);
      const perMonth = p.months ? Math.round((price / p.months) * 100) / 100 : null;
      const savePct = perMonth && monthly && p.months > 1 ? Math.max(0, Math.round((1 - perMonth / monthly) * 100)) : 0;
      return { id, label: p.label, price, currency, months: p.months || null, perMonth, savePct };
    });
  };

  const ownerOf = (reference) => String(reference || '').slice(0, String(reference || '').lastIndexOf('.'));

  async function checkout(user, planId, { origin } = {}) {
    if (!available) throw new PaymentError(503, 'payments_unavailable', 'Subscriptions are not available right now');
    if (!plans[planId]) throw new PaymentError(400, 'invalid_request', `plan must be one of: ${Object.keys(plans).join(', ')}`);
    if (!enabled(planId)) throw new PaymentError(400, 'plan_unavailable', 'That plan is not available right now');
    const price = priceOf(planId);
    const now = Date.now();
    const recent = (attempts.get(user) || []).filter((t) => t > now - 60 * 60 * 1000);
    if (recent.length >= ordersPerHour) throw new PaymentError(429, 'rate_limited', 'Too many payment attempts. Try again later.');
    // The reference starts with the username, so a payment notification finds its owner at once (Razorpay allows 40 characters).
    const reference = `${user}.${crypto.randomBytes(6).toString('hex')}`;
    let paymentUrl = null;
    let providerRef = null;
    try {
      const base = require('./guardian').baseUrl(publicUrl, origin);
      ({ paymentUrl, providerRef } = await provider.createCheckout({
        reference, amount: price, currency, user, plan: planId,
        description: `VartiQ Premium: ${plans[planId].label}`,
        returnUrl: base ? `${base}/premium/return/${provider.id}` : undefined,
        expireBy: now + orderTtlMs,
      }));
    } catch (err) {
      console.error(`${provider.label} could not create the payment:`, err.message);
      throw new PaymentError(502, 'payment_gateway_failed', 'The payment service could not start the payment. Try again shortly.');
    }
    recent.push(now);
    attempts.set(user, recent);
    store.addOrder(user, reference, { plan: planId, amount: price, currency, provider: provider.id, ...(providerRef ? { providerRef } : {}) });
    return { orderId: reference, plan: planId, amount: price, currency, paymentUrl, provider: provider.id, providerLabel: provider.label, sandbox: !!provider.sandbox };
  }

  /**
   * A payment was received (from the payment service's webhook, its return address, or our own check). Switches Premium on
   * once per payment. Returns `{ status, user }`: `activated`, `duplicate` (already recorded), `unknown` (not an order of
   * ours), or `mismatch` (the amount or currency is not what the order was for: nothing is switched on).
   */
  function receive({ reference, paymentId, amountMinor, currency: cur, method = null }) {
    const user = ownerOf(reference);
    const order = user && store.orderOf(user, reference);
    if (!order) return { status: 'unknown' };
    if (paymentId && store.paymentOwner(paymentId)) return { status: 'duplicate', user };
    if (order.paidAt) {
      console.warn(`Order ${reference} was already paid; ignoring payment ${paymentId} (refund it in Razorpay if the person paid twice)`);
      return { status: 'duplicate', user };
    }
    if (Number(amountMinor) !== Math.round(order.amount * 100) || String(cur || '').toUpperCase() !== order.currency) {
      console.error(`Payment ${paymentId} for order ${reference} does not match it (${amountMinor} ${cur} vs ${order.amount} ${order.currency}); not activated`);
      return { status: 'mismatch', user };
    }
    const sub = store.subscriptionOf(user);
    const periodStart = Math.max(Date.now(), sub?.expiresAt || 0); // buying while Premium extends it
    const periodEnd = addPeriod(periodStart, plans[order.plan].period);
    store.activateSubscription(user, { plan: order.plan, expiresAt: periodEnd });
    const entry = { id: paymentId || `${provider.id}_${reference}`, reference, plan: order.plan, amount: order.amount, currency: order.currency, at: Date.now(), method, provider: order.provider, periodStart, periodEnd };
    store.recordPayment(user, entry, reference);
    try {
      onPaid({ user, entry });
    } catch (err) {
      console.error('onPaid failed:', err.message);
    }
    return { status: 'activated', user, entry };
  }

  /** The person says they paid: ask the payment service itself. Switches Premium on when it was (once per order). */
  async function confirm(user, orderId) {
    const reference = String(orderId || '');
    const order = ownerOf(reference) === user && store.orderOf(user, reference);
    if (!order) throw new PaymentError(404, 'not_found', 'Order not found or expired. Start again.');
    if (order.paidAt) return store.subscriptionOf(user); // the payment service already told us
    let info;
    try {
      info = await provider.status({ providerRef: order.providerRef, reference, amount: order.amount, currency: order.currency });
    } catch (err) {
      console.error(`${provider.label} status failed:`, err.message);
      throw new PaymentError(502, 'payment_gateway_failed', 'The payment service is not answering. Try again.');
    }
    if (!info.paid) throw new PaymentError(402, 'payment_pending', 'Payment not received yet. Finish paying, then confirm again.');
    const result = receive({ reference, paymentId: info.paymentId, amountMinor: info.amountMinor, currency: info.currency, method: info.method });
    if (result.status === 'mismatch') throw new PaymentError(409, 'payment_mismatch', 'The payment does not match this order. Contact support.');
    return store.subscriptionOf(user);
  }

  /** The payment service refunded (part of) a payment. A full refund takes back the period it bought (never below today). */
  function refund({ paymentId, refundMinor }) {
    const found = store.recordRefund(String(paymentId), Number(refundMinor) || 0);
    if (!found) return { status: 'unknown' };
    const { username, entry } = found;
    let revoked = false;
    if (!entry.revoked && entry.refundedMinor >= Math.round(entry.amount * 100)) {
      const sub = store.subscriptionOf(username);
      if (sub) store.activateSubscription(username, { plan: sub.plan, expiresAt: Math.max(Date.now(), sub.expiresAt - (entry.periodEnd - entry.periodStart)) });
      entry.revoked = true;
      store._save();
      revoked = true;
    }
    try {
      onRefund({ user: username, entry, revoked });
    } catch (err) {
      console.error('onRefund failed:', err.message);
    }
    return { status: 'refunded', user: username, revoked };
  }

  return { available, provider, providerId: provider?.id || null, sandbox: !!provider?.sandbox, listPlans, checkout, confirm, receive, refund, stop: () => clearInterval(sweep), PaymentError };
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

module.exports = { createPayments, createPaymentGateway: require('./payment-providers').createPaymentGateway, plansFromEnv, addPeriod, PaymentError, DEFAULT_PLANS };
