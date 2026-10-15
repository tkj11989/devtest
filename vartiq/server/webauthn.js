'use strict';

const crypto = require('crypto');

/**
 * Fingerprint / face lock through WebAuthn "platform authenticators" (Touch ID, Face ID,
 * Windows Hello, Android biometrics). The phone checks the person; the server checks
 * the phone's signature, so a biometric proof can't be faked from the page.
 *
 * - Enrolling stores the credential's public key (the browser hands it over as SPKI).
 * - Proving signs a one-time server challenge. The server checks the challenge, the
 *   site the key was made for, "user present" + "user verified" flags and the signature.
 */

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 5;

class WebAuthnError extends Error {}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

function createWebAuthn() {
  const pending = new Map(); // username -> [{ challenge, expiresAt }]

  /** A one-time challenge for `username` (up to 5 outstanding, 2 minutes each). */
  function challenge(username) {
    const now = Date.now();
    const list = (pending.get(username) || []).filter((c) => c.expiresAt > now);
    const value = b64u(crypto.randomBytes(32));
    list.push({ challenge: value, expiresAt: now + CHALLENGE_TTL_MS });
    pending.set(username, list.slice(-MAX_PENDING));
    return value;
  }

  function consume(username, value) {
    const now = Date.now();
    const list = pending.get(username) || [];
    const i = list.findIndex((c) => c.challenge === value && c.expiresAt > now);
    if (i < 0) throw new WebAuthnError('The fingerprint/face check expired. Try again.');
    list.splice(i, 1);
  }

  function clientData(username, raw, type) {
    let data;
    try {
      data = JSON.parse(fromB64u(raw).toString('utf8'));
    } catch {
      throw new WebAuthnError('Invalid fingerprint/face response');
    }
    if (data.type !== type) throw new WebAuthnError('Invalid fingerprint/face response');
    consume(username, data.challenge);
    let host;
    try {
      host = new URL(data.origin).hostname;
    } catch {
      throw new WebAuthnError('Invalid fingerprint/face response');
    }
    return { host, hash: crypto.createHash('sha256').update(fromB64u(raw)).digest() };
  }

  /** authenticatorData = rpIdHash(32) | flags(1) | counter(4) | … */
  function authData(raw, rpId) {
    const buf = fromB64u(raw);
    if (buf.length < 37) throw new WebAuthnError('Invalid fingerprint/face response');
    const expected = crypto.createHash('sha256').update(rpId).digest();
    if (!crypto.timingSafeEqual(buf.subarray(0, 32), expected)) throw new WebAuthnError('This fingerprint/face lock was made for a different site');
    const flags = buf[32];
    if (!(flags & 0x01) || !(flags & 0x04)) throw new WebAuthnError('Fingerprint or face check was not completed');
    return { buf, counter: buf.readUInt32BE(33) };
  }

  /**
   * Check an enrolment (`navigator.credentials.create` result) and return the credential to store.
   * `publicKey` is `response.getPublicKey()` (SPKI) and `authenticatorData` is
   * `response.getAuthenticatorData()`, both base64url.
   */
  function verifyRegistration(username, { id, clientDataJSON, authenticatorData, publicKey, alg }) {
    if (!id || !publicKey || !authenticatorData) throw new WebAuthnError('This browser cannot set up fingerprint or face lock');
    const { host } = clientData(username, clientDataJSON, 'webauthn.create');
    const { counter } = authData(authenticatorData, host);
    if (![-7, -257].includes(Number(alg))) throw new WebAuthnError('This device uses an unsupported key type');
    try {
      crypto.createPublicKey({ key: fromB64u(publicKey), format: 'der', type: 'spki' });
    } catch {
      throw new WebAuthnError('Invalid fingerprint/face key');
    }
    return { id: String(id), publicKey: String(publicKey), alg: Number(alg), rpId: host, counter };
  }

  /** Check a proof (`navigator.credentials.get` result) against a stored credential. Returns its new counter. */
  function verifyAssertion(username, credential, { clientDataJSON, authenticatorData, signature }) {
    const { host, hash } = clientData(username, clientDataJSON, 'webauthn.get');
    if (host !== credential.rpId) throw new WebAuthnError('This fingerprint/face lock was made for a different site');
    const { buf, counter } = authData(authenticatorData, credential.rpId);
    // Counters only ever go up (0 means the device doesn't count).
    if ((counter || credential.counter) && counter <= credential.counter) throw new WebAuthnError('Fingerprint/face check was replayed');
    const key = crypto.createPublicKey({ key: fromB64u(credential.publicKey), format: 'der', type: 'spki' });
    const ok = crypto.verify('sha256', Buffer.concat([buf, hash]), key, fromB64u(signature));
    if (!ok) throw new WebAuthnError('Fingerprint or face check failed');
    return counter;
  }

  return { challenge, verifyRegistration, verifyAssertion, WebAuthnError };
}

module.exports = { createWebAuthn, WebAuthnError };
