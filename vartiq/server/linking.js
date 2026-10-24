'use strict';

const crypto = require('crypto');

/**
 * Passcodes for linking a browser. A primary phone (signed in with the SMS code) makes a 6-digit passcode; a browser
 * trades it, with the account's mobile number, for a session. Codes live in memory only, are stored hashed, work once,
 * last two minutes and allow five wrong tries; a person can make five an hour.
 */
const TTL_MS = 2 * 60 * 1000;
const MAX_TRIES = 5;
const MAX_PER_HOUR = 5;

function createLinking({ now = () => Date.now() } = {}) {
  const codes = new Map(); // username -> { hash, exp, tries }
  const made = new Map(); // username -> [timestamps]
  const hash = (u, c) => crypto.createHash('sha256').update(`${u}:${c}`).digest('hex');
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  return {
    TTL_MS,
    /** A fresh passcode for `username` (replaces any earlier one). */
    create(username) {
      const t = now();
      const recent = (made.get(username) || []).filter((x) => t - x < 3600 * 1000);
      if (recent.length >= MAX_PER_HOUR) {
        throw Object.assign(new Error('Too many passcodes. Try again in a while.'), { status: 429, code: 'rate_limited' });
      }
      recent.push(t);
      made.set(username, recent);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      codes.set(username, { hash: hash(username, code), exp: t + TTL_MS, tries: 0 });
      return { code, expiresAt: t + TTL_MS };
    },
    /** Use the passcode: throws on a wrong, used or expired one. */
    consume(username, code) {
      const bad = (msg, c = 'invalid_passcode') => Object.assign(new Error(msg), { status: 401, code: c });
      const e = codes.get(username);
      if (!e || now() > e.exp) {
        codes.delete(username);
        throw bad('That passcode is not valid. Make a new one in the app (Profile, Link a browser).');
      }
      e.tries += 1;
      if (!same(e.hash, hash(username, String(code || '').replace(/\s+/g, '')))) {
        if (e.tries >= MAX_TRIES) codes.delete(username);
        throw bad(e.tries >= MAX_TRIES ? 'Too many wrong tries. Make a new passcode in the app.' : 'Wrong passcode.');
      }
      codes.delete(username);
    },
    clear(username) {
      codes.delete(username);
    },
  };
}

module.exports = { createLinking, TTL_MS };
