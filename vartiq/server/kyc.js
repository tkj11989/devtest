'use strict';

/**
 * Identity verification (KYC) for the "Verified" badge.
 *
 * Privacy rule: VartiQ never stores KYC information, on the server or in the app. The ID
 * number passes straight through to the verification gateway and is dropped; only a
 * "verified" yes/no (with the time) is kept on the account. The one-time code comes from
 * the gateway (it is sent to the mobile number linked to the ID) and is checked once.
 *
 * Gateway contract (any KYC provider behind a small relay, e.g. DigiLocker, Aadhaar eKYC,
 * Onfido, Signzy, IDfy): `POST $KYC_WEBHOOK_URL` with JSON
 *   { action: "start",  type, idNumber }  -> { requestId }
 *   { action: "verify", requestId, otp }  -> { verified: true | false }
 * and `Authorization: Bearer $KYC_WEBHOOK_TOKEN` when set. Do not log these bodies.
 *
 * `KYC_SANDBOX=1` runs a stand-in for development: any well-formed ID is accepted and the
 * code goes to the account's own mobile number (console, or `devCode` with OTP_DEV_CODES=1).
 * Never use it in production: it verifies anyone.
 */

const TYPES = {
  individual: {
    aadhaar: { label: 'Aadhaar', pattern: /^\d{12}$/, hint: '12 digits' },
    pan: { label: 'PAN', pattern: /^[A-Z]{5}\d{4}[A-Z]$/, hint: 'e.g. ABCDE1234F' },
    passport: { label: 'Passport', pattern: /^[A-PR-WY]\d{7}$/, hint: 'e.g. K1234567' },
    driving_licence: { label: 'Driving licence', pattern: /^[A-Z]{2}[A-Z0-9 -]{8,18}$/, hint: 'e.g. MH1420110062821' },
    voter_id: { label: 'Voter ID', pattern: /^[A-Z]{3}\d{7}$/, hint: 'e.g. ABC1234567' },
  },
  business: {
    gstin: { label: 'GSTIN', pattern: /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, hint: '15 characters' },
    cin: { label: 'CIN', pattern: /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/, hint: '21 characters' },
    pan: { label: 'Business PAN', pattern: /^[A-Z]{5}\d{4}[A-Z]$/, hint: 'e.g. ABCDE1234F' },
  },
};

class KycError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createKyc({ gateway = null, sandbox = false, otp = null, store, startsPerHour = 3, ttlMs = 10 * 60 * 1000, maxAttempts = 5 } = {}) {
  const pending = new Map(); // requestId -> { user, type, expiresAt, attempts }   (never the ID number)
  const starts = new Map(); // user -> [timestamps]
  const available = !!(gateway || (sandbox && otp));

  const typesFor = (account) => TYPES[store.getBusiness(account) ? 'business' : 'individual'];
  const listTypes = (account) => Object.entries(typesFor(account)).map(([id, t]) => ({ id, label: t.label, hint: t.hint }));

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id);
  }, 60 * 1000);
  sweep.unref();

  /** Start: check the ID's format, hand it to the gateway (which sends the code), keep nothing. */
  async function start(account, { type, idNumber }) {
    if (!available) throw new KycError(503, 'kyc_unavailable', 'Identity verification is not available right now');
    if (store.isVerified(account)) throw new KycError(409, 'already_verified', 'Your account is already verified');
    const def = typesFor(account)[type];
    if (!def) throw new KycError(400, 'invalid_request', `type must be one of: ${Object.keys(typesFor(account)).join(', ')}`);
    const id = String(idNumber ?? '').replace(/[\s-]/g, '').toUpperCase();
    if (!def.pattern.test(id)) throw new KycError(400, 'invalid_id', `That doesn't look like a valid ${def.label} (${def.hint})`);

    const now = Date.now();
    const recent = (starts.get(account) || []).filter((t) => t > now - 60 * 60 * 1000);
    if (recent.length >= startsPerHour) throw new KycError(429, 'kyc_rate_limited', 'Too many verification attempts. Try again in an hour.');

    let requestId;
    let reply = {};
    if (gateway) {
      try {
        ({ requestId } = await gateway({ action: 'start', type, idNumber: id }));
      } catch (err) {
        // Never log the request (it holds the ID number).
        console.error('KYC gateway start failed:', err.message);
        throw new KycError(502, 'kyc_gateway_failed', 'The verification service could not send a code. Check the number and try again.');
      }
      if (!requestId) throw new KycError(502, 'kyc_gateway_failed', 'The verification service did not answer correctly');
    } else {
      const phone = store.contactOf(account)?.phone;
      if (!phone) throw new KycError(400, 'verification_required', 'Add a mobile number to your account first');
      const sent = await otp.request({ channel: 'sms', to: phone, purpose: 'kyc' });
      requestId = sent.requestId;
      reply = { sentTo: sent.sentTo, ...(sent.devCode ? { devCode: sent.devCode } : {}) };
    }
    recent.push(now);
    starts.set(account, recent);
    pending.set(requestId, { user: account, type, expiresAt: now + ttlMs, attempts: 0 });
    return { requestId, expiresIn: Math.round(ttlMs / 1000), ...reply };
  }

  /** Check the code once. On success the account is marked verified; nothing else is stored. */
  async function verify(account, { requestId, otp: code }) {
    const p = pending.get(String(requestId || ''));
    if (!p || p.user !== account || p.expiresAt <= Date.now()) {
      throw new KycError(400, 'otp_expired', 'The code has expired. Start the verification again.');
    }
    const code6 = String(code ?? '').trim();
    if (!/^\d{4,8}$/.test(code6)) throw new KycError(400, 'otp_invalid', 'Enter the code you received');
    let ok;
    if (gateway) {
      try {
        ({ verified: ok } = await gateway({ action: 'verify', requestId, otp: code6 }));
      } catch (err) {
        console.error('KYC gateway verify failed:', err.message);
        throw new KycError(502, 'kyc_gateway_failed', 'The verification service is not answering. Try again.');
      }
    } else {
      try {
        otp.verify({ requestId, code: code6, channel: 'sms', to: store.contactOf(account)?.phone, purpose: 'kyc' });
        ok = true;
      } catch (err) {
        if (err.code === 'otp_expired') {
          pending.delete(requestId);
          throw new KycError(400, 'otp_expired', err.message);
        }
        ok = false;
      }
    }
    if (!ok) {
      p.attempts += 1;
      if (p.attempts >= maxAttempts) {
        pending.delete(requestId);
        throw new KycError(400, 'otp_expired', 'Too many wrong tries. Start the verification again.');
      }
      throw new KycError(400, 'otp_invalid', `The code is wrong. ${maxAttempts - p.attempts} tries left.`);
    }
    pending.delete(requestId);
    store.setVerified(account);
    return true;
  }

  return { available, sandbox: !gateway && sandbox, listTypes, start, verify, stop: () => clearInterval(sweep), KycError };
}

/** Gateway from the environment: POST JSON to KYC_WEBHOOK_URL, or null when unset. */
function createKycGateway(env = process.env) {
  if (!env.KYC_WEBHOOK_URL) return null;
  return async (body) => {
    const res = await fetch(env.KYC_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.KYC_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.KYC_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`gateway answered ${res.status}`);
    return res.json();
  };
}

module.exports = { createKyc, createKycGateway, KycError, TYPES };
