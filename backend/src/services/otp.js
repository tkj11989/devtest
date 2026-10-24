const crypto = require('crypto');
const config = require('../config');

// phone -> { hash, expiresAt, sentAt, attempts }
const pending = new Map();

const hash = (phone, code) =>
  crypto.createHmac('sha256', config.jwtSecret).update(`${phone}:${code}`).digest('hex');

function generateCode() {
  const max = 10 ** config.otp.length;
  return String(crypto.randomInt(0, max)).padStart(config.otp.length, '0');
}

// Returns { code } or { error, retryAfterMs }.
function issue(phone, now = Date.now()) {
  const existing = pending.get(phone);
  if (existing && now - existing.sentAt < config.otp.resendCooldownMs) {
    return { error: 'OTP_COOLDOWN', retryAfterMs: config.otp.resendCooldownMs - (now - existing.sentAt) };
  }
  const code = generateCode();
  pending.set(phone, { hash: hash(phone, code), expiresAt: now + config.otp.ttlMs, sentAt: now, attempts: 0 });
  return { code };
}

// Returns null on success, or an error code.
function verify(phone, code, now = Date.now()) {
  const entry = pending.get(phone);
  if (!entry) return 'OTP_NOT_REQUESTED';
  if (now > entry.expiresAt) {
    pending.delete(phone);
    return 'OTP_EXPIRED';
  }
  if (entry.attempts >= config.otp.maxAttempts) {
    pending.delete(phone);
    return 'OTP_TOO_MANY_ATTEMPTS';
  }
  entry.attempts++;
  const ok = crypto.timingSafeEqual(Buffer.from(entry.hash), Buffer.from(hash(phone, String(code))));
  if (!ok) return 'OTP_INVALID';
  pending.delete(phone);
  return null;
}

function reset() {
  pending.clear();
}

module.exports = { issue, verify, reset };
