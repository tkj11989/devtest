'use strict';

const crypto = require('crypto');

/** Time-based one-time codes (RFC 6238: SHA-1, 6 digits, 30 seconds) for authenticator apps. */
const STEP = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32 = (buf) => {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) || []).map((c) => B32[parseInt(c.padEnd(5, '0'), 2)]).join('');
};
const unbase32 = (str) => {
  let bits = '';
  for (const c of String(str).replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
};

const generateSecret = () => base32(crypto.randomBytes(20));

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

/** The step number if `code` is right for the secret now (one step either side allowed), or null. */
function verify(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return null;
  const cur = Math.floor(now / 1000 / STEP);
  for (const step of [cur, cur - 1, cur + 1]) {
    const a = Buffer.from(codeAt(secret, step));
    const b = Buffer.from(String(code).trim());
    if (crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}

const otpauthUri = (secret, account, issuer = 'VartiQ Admin') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=${STEP}`;

module.exports = { generateSecret, codeAt, verify, otpauthUri };
