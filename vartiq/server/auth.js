'use strict';

const { ApiError } = require('./service');
const { normalisePhone, normaliseEmail } = require('./otp');
const legal = require('./legal');

/**
 * Sign-up and login with one-time codes.
 *
 * - Individuals: mobile number + SMS code.
 * - Businesses: mobile number + SMS code AND email + email code, plus a category.
 * - Login: a code sent to the registered mobile number (or a business's email).
 *
 * Flow: `requestCode` sends a code and returns a `requestId`; `register` / `login`
 * take that `requestId` with the code the person typed.
 */
function createAuth({ store, otp, assertSignupsOpen = () => {} }) {
  /** `{ phone }` or `{ email }` -> `{ channel, to }` (normalised), or a 400. */
  function destination(body, { allowEmail = true } = {}) {
    const bad = (err) => new ApiError(400, err.code || 'invalid_request', err.message);
    try {
      if (body?.phone != null && body.phone !== '') return { channel: 'sms', to: normalisePhone(body.phone) };
      if (allowEmail && body?.email != null && body.email !== '') return { channel: 'email', to: normaliseEmail(body.email) };
    } catch (err) {
      throw bad(err);
    }
    throw new ApiError(400, 'invalid_request', allowEmail ? 'Send "phone" or "email"' : 'Send "phone"');
  }

  const owner = ({ channel, to }) => (channel === 'sms' ? store.findByPhone(to) : store.findByEmail(to));
  const what = (channel) => (channel === 'sms' ? 'mobile number' : 'email');

  return {
    /** Send a sign-up or login code to `{ phone }` or `{ email }`. */
    async requestCode(body = {}) {
      const purpose = body.purpose;
      if (!['register', 'login'].includes(purpose)) throw new ApiError(400, 'invalid_request', 'purpose must be "register" or "login"');
      if (purpose === 'register') assertSignupsOpen();
      const dest = destination(body);
      const existing = owner(dest);
      if (purpose === 'register' && existing) {
        throw new ApiError(409, `${dest.channel === 'sms' ? 'phone' : 'email'}_taken`, `This ${what(dest.channel)} is already registered. Log in instead.`);
      }
      if (purpose === 'login' && !existing) {
        throw new ApiError(404, 'not_registered', `No account uses this ${what(dest.channel)}. Sign up first.`);
      }
      return otp.request({ ...dest, purpose });
    },

    /**
     * Create an account. Individual: `{ displayName, phone, phoneOtp: { requestId, code } }`.
     * Business: also `accountType: "business"`, `email`, `emailOtp`, and `business: { category, … }`.
     */
    register(body = {}) {
      assertSignupsOpen();
      // Nobody gets an account without agreeing to the Terms and Privacy Notice.
      // Checked first, so a missing tick doesn't use up a login code.
      const consent = body.consent || {};
      if (consent.terms !== true) {
        throw new ApiError(400, 'consent_required', 'To create an account you must accept the Terms of Use and Privacy Notice');
      }
      if (consent.version !== legal.VERSION) {
        throw new ApiError(409, 'consent_outdated', 'The Terms of Use or Privacy Notice changed. Please read and accept the current version.');
      }
      const type = body.accountType || 'individual';
      if (!['individual', 'business'].includes(type)) throw new ApiError(400, 'invalid_request', 'accountType must be "individual" or "business"');
      const displayName = String(body.displayName || '').trim();
      if (!displayName) throw new ApiError(400, 'invalid_request', type === 'business' ? 'Enter your business name' : 'Enter your name');
      const phone = destination({ phone: body.phone }, { allowEmail: false });
      let email = null;
      if (type === 'business') {
        if (!body.email) throw new ApiError(400, 'invalid_request', 'Email is required for a business account');
        email = destination({ email: body.email });
        if (!body.business?.category) throw new ApiError(400, 'invalid_request', 'Choose a business category');
      }
      if (store.findByPhone(phone.to)) throw new ApiError(409, 'phone_taken', 'This mobile number is already registered. Log in instead.');
      if (email && store.findByEmail(email.to)) throw new ApiError(409, 'email_taken', 'This email is already registered.');

      // Check every code before using any up, so one typo doesn't cost the other code.
      const otpOf = (o) => ({ requestId: o?.requestId, code: o?.code });
      otp.verify({ ...otpOf(body.phoneOtp), ...phone, purpose: 'register', label: email ? 'SMS code' : 'code', consume: false });
      if (email) otp.verify({ ...otpOf(body.emailOtp), ...email, purpose: 'register', label: 'email code', consume: false });

      let result;
      try {
        result = store.registerVerified({
          displayName,
          username: body.username || undefined,
          phone: phone.to,
          email: email?.to,
          business: type === 'business' ? { timezone: 'UTC', ...body.business } : undefined,
        });
      } catch (err) {
        if (/already taken|already registered/i.test(err.message)) throw new ApiError(409, 'conflict', err.message);
        throw new ApiError(400, 'invalid_request', err.message);
      }
      otp.consume(body.phoneOtp.requestId);
      if (email) otp.consume(body.emailOtp.requestId);
      store.recordConsent(result.user.username, { version: legal.VERSION, items: ['terms'], via: 'registration' });
      return result;
    },

    /**
     * Log in with a code: `{ phone, requestId, code }` (or `{ email, … }` for a business).
     * Accounts created before mobile login can still send `{ username, password }`.
     */
    login(body = {}) {
      if (body.username != null && body.password != null) {
        try {
          return store.login(body.username, body.password);
        } catch (err) {
          if (err.code === 'account_suspended') throw new ApiError(403, 'account_suspended', err.message);
          throw new ApiError(401, 'invalid_credentials', err.message);
        }
      }
      const dest = destination(body);
      if (!body.requestId) throw new ApiError(400, 'invalid_request', 'Send the "requestId" from /auth/otp and the "code"');
      otp.verify({ requestId: body.requestId, code: body.code, ...dest, purpose: 'login' });
      const username = owner(dest);
      if (!username) throw new ApiError(404, 'not_registered', `No account uses this ${what(dest.channel)}.`);
      return store.createSession(username);
    },

    destination,
  };
}

module.exports = { createAuth };
