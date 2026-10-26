'use strict';

const crypto = require('crypto');

/**
 * One-time passcodes sent by SMS or email, used to sign up, log in and prove you
 * own a mobile number or email address.
 *
 * - 6-digit codes, valid for 5 minutes, kept in memory as an HMAC (never in plain text).
 * - 5 wrong guesses and the code is dead; ask for a new one.
 * - Another code for the same address and purpose waits 30 seconds; at most 5 codes per address per hour.
 *
 * Delivery is pluggable: `sender({ channel, to, code, purpose, text })`. Without one,
 * codes are printed to the server console (development). See `createOtpSender`.
 */

const PURPOSES = ['register', 'login', 'contact', 'chatlock-reset', 'kyc', 'delete'];

/** Mobile numbers in international (E.164) form, e.g. "+919876543210". */
function normalisePhone(input) {
  let s = String(input ?? '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) {
    throw Object.assign(new Error('Enter a valid mobile number with country code, e.g. +91 98765 43210'), { code: 'invalid_phone' });
  }
  return s;
}

function normaliseEmail(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw Object.assign(new Error('Enter a valid email address'), { code: 'invalid_email' });
  }
  return s;
}

/** "+919876543210" -> "+91•••••••210", "anita@shop.in" -> "an•••@shop.in" (for messages and logs). */
function maskDestination(channel, to) {
  if (channel === 'sms') return `${to.slice(0, 3)}${'•'.repeat(Math.max(0, to.length - 6))}${to.slice(-3)}`;
  const [name, domain] = to.split('@');
  return `${name.slice(0, 2)}•••@${domain}`;
}

class OtpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function createOtpService({
  sender,
  exposeCodes = false,
  ttlMs = 5 * 60 * 1000,
  maxAttempts = 5,
  resendMs = 30 * 1000,
  maxPerHour = 5,
  // Protection against SMS bills: at most this many SMS a day in all (0 = no limit), and only to numbers starting with one
  // of these prefixes (for example ['+91']; empty = any country).
  dailySmsLimit = Number(process.env.OTP_DAILY_SMS_LIMIT) || 0,
  allowedPrefixes = String(process.env.OTP_ALLOWED_PREFIXES || '').split(',').map((x) => x.trim()).filter(Boolean),
} = {}) {
  const secret = crypto.randomBytes(32);
  const requests = new Map(); // requestId -> { channel, to, purpose, hash, expiresAt, attempts, verified }
  const sent = new Map(); // `${channel}:${to}` -> [timestamps of sends in the last hour]
  const lastSent = new Map(); // `${channel}:${to}:${purpose}` -> time of the latest send
  const deliver = sender || consoleSender;
  let day = { key: '', sms: 0 };
  /** Count an SMS against today's budget, or refuse. Countries outside the allow-list are refused before anything is sent. */
  const smsAllowed = (to) => {
    if (allowedPrefixes.length && !allowedPrefixes.some((p) => to.startsWith(p))) {
      throw new OtpError(400, 'country_not_supported', 'Mobile numbers from this country are not supported yet.');
    }
    const today = new Date().toISOString().slice(0, 10);
    if (day.key !== today) day = { key: today, sms: 0 };
    if (dailySmsLimit && day.sms >= dailySmsLimit) {
      console.error(`SMS daily limit of ${dailySmsLimit} reached: no more SMS are sent today.`);
      throw new OtpError(503, 'sms_budget', 'We cannot send more codes right now. Please try again tomorrow.');
    }
  };
  const smsSent = () => { day.sms += 1; if (dailySmsLimit && day.sms === Math.floor(dailySmsLimit * 0.8)) console.warn(`SMS: 80% of the daily limit (${dailySmsLimit}) used.`); };

  const hmac = (id, code) => crypto.createHmac('sha256', secret).update(`${id}:${code}`).digest();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, r] of requests) if (r.expiresAt <= now) requests.delete(id);
    for (const [k, times] of sent) {
      const recent = times.filter((t) => t > now - 60 * 60 * 1000);
      if (recent.length) sent.set(k, recent);
      else sent.delete(k);
    }
    for (const [k, t] of lastSent) if (t <= now - resendMs) lastSent.delete(k);
  }, 60 * 1000);
  sweep.unref();

  /**
   * Send a code. `to` must already be normalised. Returns what the client needs to
   * show the "enter code" step; `devCode` only when `exposeCodes` is on.
   */
  async function request({ channel, to, purpose, decoy = false }) {
    if (!['sms', 'email'].includes(channel)) throw new OtpError(400, 'invalid_request', 'channel must be "sms" or "email"');
    if (!PURPOSES.includes(purpose)) throw new OtpError(400, 'invalid_request', `purpose must be one of: ${PURPOSES.join(', ')}`);
    const now = Date.now();
    const key = `${channel}:${to}`;
    const times = (sent.get(key) || []).filter((t) => t > now - 60 * 60 * 1000);
    // The resend wait is per purpose (signing up, then logging in on another device is fine);
    // the hourly cap counts every code sent to the address.
    const last = lastSent.get(`${key}:${purpose}`);
    if (last && now - last < resendMs) {
      const wait = Math.ceil((resendMs - (now - last)) / 1000);
      throw new OtpError(429, 'otp_too_soon', `Please wait ${wait} seconds before asking for another code`, { retryAfter: wait });
    }
    if (times.length >= maxPerHour) {
      const wait = Math.ceil((times[0] + 60 * 60 * 1000 - now) / 1000);
      throw new OtpError(429, 'otp_limit', 'Too many codes sent to this address. Try again later.', { retryAfter: wait });
    }

    // A new code replaces any earlier one for the same address and purpose.
    for (const [id, r] of requests) if (r.channel === channel && r.to === to && r.purpose === purpose) requests.delete(id);

    if (channel === 'sms') smsAllowed(to);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const requestId = `otp_${crypto.randomBytes(12).toString('hex')}`;
    const text = `${code} is your VartiQ verification code. It expires in ${Math.round(ttlMs / 60000)} minutes. Never share it with anyone.`;
    try {
      // A decoy (a number that has, or has no, account when that must stay secret) looks the same to the caller and uses the
      // same limits, but nothing is sent and no code is kept.
      if (!decoy) await deliver({ channel, to, code, purpose, text });
    } catch (err) {
      console.error(`OTP delivery to ${maskDestination(channel, to)} failed:`, err.message);
      throw new OtpError(502, 'otp_delivery_failed', `Could not send the code by ${channel === 'sms' ? 'SMS' : 'email'}. Try again shortly.`);
    }
    times.push(now);
    sent.set(key, times);
    lastSent.set(`${key}:${purpose}`, now);
    if (!decoy) {
      if (channel === 'sms') smsSent();
      requests.set(requestId, { channel, to, purpose, hash: hmac(requestId, code), expiresAt: now + ttlMs, attempts: 0 });
    }

    return {
      requestId,
      channel,
      sentTo: maskDestination(channel, to),
      expiresIn: Math.round(ttlMs / 1000),
      resendIn: Math.round(resendMs / 1000),
      ...(exposeCodes && !decoy ? { devCode: code } : {}),
    };
  }

  /**
   * Check a code for `requestId`, which must have been sent to `to` for `purpose`.
   * With `consume: false` the code stays usable (so several codes can be checked
   * before any is used up); call `consume(requestId)` afterwards.
   */
  function verify({ requestId, code, channel, to, purpose, label = 'code', consume = true }) {
    const r = requests.get(String(requestId || ''));
    const which = label === 'code' ? 'The code' : `The ${label}`;
    if (!r || r.expiresAt <= Date.now() || r.channel !== channel || r.to !== to || r.purpose !== purpose) {
      throw new OtpError(400, 'otp_expired', `${which} has expired or was not sent to this address. Ask for a new one.`);
    }
    const ok = typeof code === 'string' && /^\d{6}$/.test(code.trim()) && crypto.timingSafeEqual(hmac(requestId, code.trim()), r.hash);
    if (!ok) {
      r.attempts += 1;
      const left = maxAttempts - r.attempts;
      if (left <= 0) {
        requests.delete(requestId);
        throw new OtpError(400, 'otp_expired', `Too many wrong tries. ${which} no longer works; ask for a new one.`);
      }
      throw new OtpError(400, 'otp_invalid', `${which} is wrong. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    }
    if (consume) requests.delete(requestId);
    return { channel: r.channel, to: r.to };
  }

  const consume = (requestId) => requests.delete(requestId);

  /**
   * Send a message that is not a code (for example the private link to a child's parent). The same limits apply, so a
   * number or address cannot be flooded: one per `resendMs` per purpose and `maxPerHour` of everything.
   * Returns `{ sentTo }` (masked); with `exposeCodes` also `devText` (the whole message, for tests and development).
   */
  async function notify({ channel, to, purpose = 'guardian', text }) {
    if (!['sms', 'email'].includes(channel)) throw new OtpError(400, 'invalid_request', 'channel must be "sms" or "email"');
    const now = Date.now();
    const key = `${channel}:${to}`;
    const times = (sent.get(key) || []).filter((t) => t > now - 60 * 60 * 1000);
    const last = lastSent.get(`${key}:${purpose}`);
    if (last && now - last < resendMs) {
      const wait = Math.ceil((resendMs - (now - last)) / 1000);
      throw new OtpError(429, 'otp_too_soon', `Please wait ${wait} seconds before sending this again`, { retryAfter: wait });
    }
    if (times.length >= maxPerHour) throw new OtpError(429, 'otp_limit', 'Too many messages sent to this address. Try again later.', { retryAfter: Math.ceil((times[0] + 60 * 60 * 1000 - now) / 1000) });
    if (channel === 'sms') smsAllowed(to);
    try {
      await deliver({ channel, to, code: '', purpose, text });
    } catch (err) {
      console.error(`Message to ${maskDestination(channel, to)} failed:`, err.message);
      throw new OtpError(502, 'otp_delivery_failed', `Could not send the message by ${channel === 'sms' ? 'SMS' : 'email'}. Check the ${channel === 'sms' ? 'number' : 'address'} and try again shortly.`);
    }
    times.push(now);
    sent.set(key, times);
    lastSent.set(`${key}:${purpose}`, now);
    if (channel === 'sms') smsSent();
    return { sentTo: maskDestination(channel, to), ...(exposeCodes ? { devText: text } : {}) };
  }

  return { request, verify, consume, notify, stop: () => clearInterval(sweep), exposeCodes };
}

/** Development delivery: print the code on the server console. */
async function consoleSender({ channel, to, code, purpose }) {
  console.log(`[otp] ${channel === 'sms' ? 'SMS' : 'Email'} to ${to} (${purpose}): ${code}`);
}

/**
 * Choose how codes are delivered:
 * - `OTP_WEBHOOK_URL` set: POST `{ channel, to, code, purpose, text }` as JSON to your
 *   SMS/email gateway (or a small relay to Twilio, MSG91, SendGrid, SES…), with
 *   `Authorization: Bearer $OTP_WEBHOOK_TOKEN` when that is set. Any non-2xx is a failure.
 * - otherwise: print codes to the console.
 */
function createOtpSender(env = process.env) {
  if (!env.OTP_WEBHOOK_URL) return consoleSender;
  const url = env.OTP_WEBHOOK_URL;
  return async (msg) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.OTP_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.OTP_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`gateway answered ${res.status}`);
  };
}

module.exports = { createOtpService, createOtpSender, consoleSender, normalisePhone, normaliseEmail, maskDestination, OtpError, PURPOSES };
