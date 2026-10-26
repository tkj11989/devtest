'use strict';

const { ApiError } = require('./service');
const { normalisePhone, normaliseEmail, maskDestination } = require('./otp');
const legal = require('./legal');
const { Store } = require('./store');
const guardianRules = require('./guardian');

/**
 * Sign-up and login with one-time codes.
 *
 * - Individuals: mobile number + SMS code (an email is optional; if given, it is verified with a code too).
 * - A browser (`clientType: "web"`) can only log in with a passcode made on a signed-in primary phone, never with an SMS code
 *   while such a phone is signed in.
 * - Businesses: mobile number + SMS code AND email + email code, plus a category.
 * - Login: a code sent to the registered mobile number (or a business's email).
 *
 * Flow: `requestCode` sends a code and returns a `requestId`; `register` / `login`
 * take that `requestId` with the code the person typed.
 */
function createAuth({ store, otp, linking, onLogin = () => {}, assertSignupsOpen = () => {}, minAge = () => guardianRules.DEFAULT_MIN_AGE, publicUrl = process.env.PUBLIC_URL }) {
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

  const mailer = guardianRules.createMailer(otp);
  const oldFails = new Map(); // username -> wrong password count (old password logins lock for 15 minutes after 10)

  const owner = ({ channel, to }) => (channel === 'sms' ? store.findByPhone(to) : store.findByEmail(to));
  const what = (channel) => (channel === 'sms' ? 'mobile number' : 'email');

  /** A browser may not log in with an SMS code while a primary phone is signed in: it needs a passcode from that phone. */
  function needsPasscode(body, username) {
    // Anything that does not say it is the phone app is treated as a browser. (A client can still lie: the login PIN and the
    // new-login alert are the protection against someone who has the SMS code.)
    if (body.clientType !== 'app' && store.hasPrimary(username)) {
      throw new ApiError(403, 'passcode_required', 'To log in on a browser, open VartiQ on your phone (Profile, Link a browser), get a passcode and enter it here.');
    }
  }

  /** A new login: the session, and a note to the person's other devices. */
  function signedIn(username, { via, name }) {
    const session = store.createSession(username, { via, name });
    onLogin(username, { via, name: name || (via === 'link' ? 'Browser' : 'Phone or app'), at: Date.now() });
    return session;
  }

  return {
    /** Send a sign-up or login code to `{ phone }` or `{ email }`. */
    async requestCode(body = {}) {
      const purpose = body.purpose;
      if (!['register', 'login'].includes(purpose)) throw new ApiError(400, 'invalid_request', 'purpose must be "register" or "login"');
      if (purpose === 'register') assertSignupsOpen();
      const dest = destination(body);
      const existing = owner(dest);
      if (purpose === 'login' && existing) needsPasscode(body, existing);
      // Nobody can learn whether a number has an account: asking to sign up with a registered number, or to log in with an
      // unknown one, gets the same answer as any other request (and the same limits), but no code is sent.
      const decoy = (purpose === 'register' && !!existing) || (purpose === 'login' && !existing);
      return otp.request({ ...dest, purpose, decoy });
    },

    /**
     * Create an account. Individual: `{ displayName, phone, phoneOtp: { requestId, code } }`.
     * Business: also `accountType: "business"`, `email`, `emailOtp`, and `business: { category, … }`.
     */
    async register(body = {}, { origin } = {}) {
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
      // Age first: nobody under the minimum gets an account, and under 18 a parent or guardian is mandatory.
      const birth = guardianRules.parseBirthDate(body.birthDate);
      if (!birth) throw new ApiError(400, 'birth_date_required', 'Enter your date of birth (a real date, not in the future)');
      const age = guardianRules.ageOn(birth.text);
      const lowest = minAge();
      if (age < lowest) throw new ApiError(403, 'too_young', `VartiQ is for people aged ${lowest} and over.`);
      const child = age < guardianRules.ADULT_AGE;
      if (child && type === 'business') throw new ApiError(400, 'business_adult', 'A business account must be opened by an adult (18 or over)');
      let guardian = null;
      let base = null;
      if (child) {
        try {
          guardian = Store.checkGuardian(body.guardian, { normalisePhone, normaliseEmail });
        } catch (err) {
          throw new ApiError(err.status || 400, err.code || 'guardian_required', err.message);
        }
        // The link must be sent to a real address of ours; refuse rather than text people a link to somewhere else.
        base = guardianRules.baseUrl(publicUrl, origin);
        if (!base) throw new ApiError(503, 'unavailable', "Parental approval is not set up on this server yet. The administrator must set PUBLIC_URL.");
      }
      const phone = destination({ phone: body.phone }, { allowEmail: false });
      if (guardian?.phone && guardian.phone === phone.to) throw new ApiError(400, 'guardian_same_person', "Your parent's or guardian's mobile number must be different from yours");
      let email = null;
      if (type === 'business' && !body.email) throw new ApiError(400, 'invalid_request', 'Email is required for a business account');
      if (type === 'business' && !body.business?.category) throw new ApiError(400, 'invalid_request', 'Choose a business category');
      if (body.email) {
        // Optional for an individual, required for a business; either way it is proved with a code.
        email = destination({ email: body.email });
        if (guardian?.email && guardian.email === email.to) throw new ApiError(400, 'guardian_same_person', "Your parent's or guardian's email must be different from yours");
      }
      // Check every code before using any up, so one typo doesn't cost the other code.
      const otpOf = (o) => ({ requestId: o?.requestId, code: o?.code });
      otp.verify({ ...otpOf(body.phoneOtp), ...phone, purpose: 'register', label: email ? 'SMS code' : 'code', consume: false });
      if (email) otp.verify({ ...otpOf(body.emailOtp), ...email, purpose: 'register', label: 'email code', consume: false });

      // Only now, with the codes proved, say that a number or email is taken (the person owns it, so nothing is given away).
      if (store.findByPhone(phone.to)) throw new ApiError(409, 'phone_taken', 'This mobile number is already registered. Log in instead.');
      if (email && store.findByEmail(email.to)) throw new ApiError(409, 'email_taken', 'This email is already registered.');

      let result;
      try {
        result = store.registerVerified({
          displayName,
          username: body.username || undefined,
          phone: phone.to,
          email: email?.to,
          business: type === 'business' ? { timezone: 'UTC', ...body.business } : undefined,
          birthDate: birth.text,
          guardian,
        });
      } catch (err) {
        if (/already taken|already registered/i.test(err.message)) throw new ApiError(409, 'conflict', err.message);
        throw new ApiError(400, 'invalid_request', err.message);
      }
      otp.consume(body.phoneOtp.requestId);
      if (email) otp.consume(body.emailOtp.requestId);
      store.recordConsent(result.user.username, { version: legal.VERSION, items: ['terms'], via: 'registration' });
      const { guardianToken, ...session } = result;
      if (!guardianToken) return session;
      // The private link goes to the parent or guardian now. If it cannot be delivered the account stays (waiting), and the
      // child can fix the details or ask again.
      const delivery = await mailer.send({ childName: displayName, token: guardianToken, guardian, base });
      return { ...session, guardian: { state: 'pending', delivery, contacts: mailer.contacts(guardian).map((d) => maskDestination(d.channel, d.to)) } };
    },


    /**
     * Log in with a code: `{ phone, requestId, code }` (or `{ email, … }` for a business).
     * Accounts created before mobile login can still send `{ username, password }`.
     */
    login(body = {}) {
      if (body.username != null && body.password != null) {
        const key = String(body.username).trim().toLowerCase();
        const f = oldFails.get(key);
        if (f && f.until > Date.now()) throw new ApiError(429, 'too_many_attempts', 'Too many wrong attempts. Try again later.');
        try {
          const session = store.login(body.username, body.password);
          oldFails.delete(key);
          onLogin(key, { via: 'sms', name: body.deviceName || 'Phone or app', at: Date.now() });
          return session;
        } catch (err) {
          if (err.code === 'account_suspended') throw new ApiError(403, 'account_suspended', err.message);
          const n = (f?.n || 0) + 1;
          oldFails.set(key, { n, until: n >= 10 ? Date.now() + 15 * 60 * 1000 : 0 });
          throw new ApiError(401, 'invalid_credentials', err.message);
        }
      }
      const dest = destination(body);
      if (body.linkCode != null && body.linkCode !== '') {
        // Browser login: the passcode made on the primary phone, with the account's number.
        if (dest.channel !== 'sms') throw new ApiError(400, 'invalid_request', 'Send the mobile "phone" with the "linkCode"');
        const who = owner(dest);
        if (!who) throw new ApiError(404, 'not_registered', `No account uses this ${what(dest.channel)}.`);
        try {
          store.checkLoginPin(who, body.pin);
          linking.consume(who, body.linkCode);
        } catch (err) {
          throw new ApiError(err.status || 401, err.code || 'invalid_passcode', err.message);
        }
        return signedIn(who, { via: 'link', name: body.deviceName });
      }
      const known = owner(dest);
      if (known) needsPasscode(body, known);
      if (!body.requestId) throw new ApiError(400, 'invalid_request', 'Send the "requestId" from /auth/otp and the "code"');
      otp.verify({ requestId: body.requestId, code: body.code, ...dest, purpose: 'login', consume: false });
      const username = owner(dest);
      if (!username) throw new ApiError(400, 'otp_expired', 'The code has expired or was not sent to this address. Ask for a new one.');
      // The optional PIN is checked before the code is used up, so asking for it does not cost the code.
      try {
        store.checkLoginPin(username, body.pin);
      } catch (err) {
        throw new ApiError(err.status || 401, err.code || 'wrong_pin', err.message);
      }
      otp.consume(body.requestId);
      return signedIn(username, { via: 'sms', name: body.deviceName });
    },

    destination,
  };
}

module.exports = { createAuth };
