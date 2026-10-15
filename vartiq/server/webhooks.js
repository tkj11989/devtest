'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

/**
 * Delivers events to users' webhooks.
 *
 * Each delivery is a POST with a JSON body:
 *   { id, event, createdAt, user, data }
 * and headers:
 *   X-VartiQ-Event, X-VartiQ-Delivery, X-VartiQ-Timestamp,
 *   X-VartiQ-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret>
 *
 * A delivery succeeds on any 2xx response. Failures are retried (see retryDelaysMs);
 * after Store.WEBHOOK_MAX_FAILURES failed deliveries in a row the webhook is switched off.
 *
 * Webhook URLs that resolve to private, loopback or link-local addresses are refused
 * unless `allowPrivate` is set (e.g. for local development), so the server can't be
 * used to reach internal services.
 */
function createWebhookDispatcher({ store, allowPrivate = false, retryDelaysMs = [2000, 10000, 60000], timeoutMs = 5000, log = console } = {}) {
  let stopped = false;
  const timers = new Set();

  function sign(secret, timestamp, body) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  }

  async function assertPublicHost(url) {
    if (allowPrivate) return;
    const { hostname } = new URL(url);
    const host = hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      throw new Error('webhook URL resolves to a private address');
    }
  }

  async function attempt(hook, delivery, n, retry = true) {
    const body = JSON.stringify(delivery);
    const timestamp = String(Math.floor(Date.now() / 1000));
    let result;
    try {
      await assertPublicHost(hook.url);
      const res = await fetch(hook.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'VartiQ-Webhooks/1.0',
          'X-VartiQ-Event': delivery.event,
          'X-VartiQ-Delivery': delivery.id,
          'X-VartiQ-Timestamp': timestamp,
          'X-VartiQ-Signature': sign(hook.secret, timestamp, body),
        },
        body,
      });
      result = { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
    } catch (err) {
      result = { ok: false, status: null, error: err.name === 'TimeoutError' ? 'Timed out' : err.message };
    }
    store.recordDelivery(hook.id, { ...result, event: delivery.event, deliveryId: delivery.id, attempt: n + 1, at: Date.now() });
    if (!result.ok && retry && n < retryDelaysMs.length && !stopped) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        const current = store.data.webhooks[hook.id];
        if (current?.active) attempt(current, delivery, n + 1);
      }, retryDelaysMs[n]);
      timer.unref?.();
      timers.add(timer);
    } else if (!result.ok) {
      log.warn?.(`Webhook ${hook.id} failed for ${delivery.event}: ${result.error}`);
    }
    return result;
  }

  /** Fire-and-forget delivery of `event` to every matching webhook of `username`. */
  function dispatch(username, event, data) {
    if (stopped || !store.featureOn('developerApi')) return;
    const hooks = store.webhooksFor(username, event);
    if (!hooks.length) return;
    const createdAt = Date.now();
    for (const hook of hooks) {
      const delivery = { id: 'evt_' + crypto.randomBytes(8).toString('hex'), event, createdAt, user: username, data };
      attempt(hook, delivery, 0);
    }
  }

  /** Send a test `ping` to one webhook and wait for the result (no retries). */
  async function ping(hook) {
    const delivery = { id: 'evt_' + crypto.randomBytes(8).toString('hex'), event: 'ping', createdAt: Date.now(), user: hook.owner, data: { webhookId: hook.id } };
    return attempt(hook, delivery, 0, false);
  }

  function stop() {
    stopped = true;
    timers.forEach(clearTimeout);
    timers.clear();
  }

  return { dispatch, ping, stop, sign };
}

/** Loopback, private, link-local, carrier-grade NAT and other non-public ranges. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8')
    || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

module.exports = { createWebhookDispatcher, isPrivateAddress };
