'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BusinessHours = require('../public/business-hours.js');

/**
 * Simple JSON-file backed data store for users, conversations and messages.
 * Everything is kept in memory and flushed to disk (debounced) on change.
 * Pass `file: null` to keep data in memory only (used by tests).
 */
class Store {
  /** `statusTtlMs`: how long a status update stays up (24 hours, shorter in tests). */
  constructor({ file, statusTtlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.statusTtlMs = statusTtlMs;
    this.file = file === undefined ? path.join(__dirname, '..', 'data', 'db.json') : file;
    this.data = { users: {}, conversations: {}, messages: {}, media: {}, statuses: {}, apiKeys: {}, webhooks: {} };
    this.sessions = new Map(); // token -> username
    // Voice-message audio lives next to the data file (or in memory without one).
    this.mediaDir = this.file ? path.join(path.dirname(this.file), 'media') : null;
    this.memoryMedia = new Map(); // id -> Buffer (when there is no data file)
    this._saveTimer = null;
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { users: {}, conversations: {}, messages: {}, media: {}, statuses: {}, apiKeys: {}, webhooks: {}, ...parsed };
    } catch (err) {
      console.error('Could not read data file, starting fresh:', err.message);
    }
  }

  _save() {
    if (!this.file) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this._saveTimer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // ---------- users & auth ----------

  static _hash(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  register(username, password, displayName) {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) {
      throw new Error('Username must be 3-20 characters: letters, numbers, "_" or "."');
    }
    if (!password || String(password).length < 4) {
      throw new Error('Password must be at least 4 characters');
    }
    if (this.data.users[username]) throw new Error('Username already taken');
    const salt = crypto.randomBytes(16).toString('hex');
    this.data.users[username] = {
      username,
      displayName: String(displayName || username).trim().slice(0, 40) || username,
      about: 'Hey there! I am using ChatApp.',
      salt,
      hash: Store._hash(String(password), salt),
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
    this._save();
    return this.createSession(username);
  }

  /**
   * Create an account whose mobile number (and, for a business, email) was just
   * verified by OTP. There is no password: you log in with a code sent to the number.
   * `business` (optional) is the business profile, e.g. `{ category }`.
   */
  registerVerified({ displayName, username, phone, email, business }) {
    displayName = String(displayName || '').trim().slice(0, 40);
    if (!displayName) throw new Error('Enter your name');
    if (!phone) throw new Error('A verified mobile number is required');
    if (this.findByPhone(phone)) throw new Error('This mobile number is already registered');
    if (email && this.findByEmail(email)) throw new Error('This email is already registered');
    if (business && !email) throw new Error('A verified email is required for a business account');
    if (username) {
      username = String(username).trim().toLowerCase();
      if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw new Error('Username must be 3-20 characters: letters, numbers, "_" or "."');
      if (this.data.users[username]) throw new Error('Username already taken');
    } else {
      username = this._freeUsername(displayName);
    }
    const now = Date.now();
    this.data.users[username] = {
      username,
      displayName,
      about: business ? 'Business account' : 'Hey there! I am using ChatApp.',
      phone,
      ...(email ? { email } : {}),
      lastSeen: now,
      createdAt: now,
    };
    if (business) {
      try {
        this.setBusiness(username, business);
      } catch (err) {
        delete this.data.users[username];
        throw err;
      }
    }
    this._save();
    return this.createSession(username);
  }

  /** "Anita's Café" -> "anitascafe", or "anitascafe4821" when taken. */
  _freeUsername(displayName) {
    let base = displayName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
    if (base.length < 3) base = `user${base}`;
    if (!this.data.users[base]) return base;
    for (;;) {
      const candidate = `${base}${crypto.randomInt(1000, 1000000)}`;
      if (!this.data.users[candidate]) return candidate;
    }
  }

  findByPhone(phone) {
    return Object.values(this.data.users).find((u) => u.phone === phone)?.username || null;
  }

  findByEmail(email) {
    return Object.values(this.data.users).find((u) => u.email === email)?.username || null;
  }

  /** Set a verified mobile number (`channel` "sms") or email ("email"). A business's contact email follows it. */
  setContact(username, channel, value) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    const field = channel === 'sms' ? 'phone' : 'email';
    const owner = field === 'phone' ? this.findByPhone(value) : this.findByEmail(value);
    if (owner && owner !== username) throw new Error(`This ${field === 'phone' ? 'mobile number' : 'email'} is already registered`);
    u[field] = value;
    if (field === 'email' && u.business) u.business.email = value;
    this._save();
  }

  /** Mobile number and email as stored for the account owner (never shown to others). */
  contactOf(username) {
    const u = this.data.users[username];
    return u ? { phone: u.phone || null, email: u.email || null } : null;
  }

  /** Username + password login (accounts created before mobile login). */
  login(username, password) {
    username = String(username || '').trim().toLowerCase();
    const user = this.data.users[username];
    if (!user || !user.hash) throw new Error('Invalid username or password');
    const hash = Store._hash(String(password || ''), user.salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) {
      throw new Error('Invalid username or password');
    }
    return this.createSession(username);
  }

  createSession(username) {
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, username);
    return { token, user: this.publicUser(username) };
  }

  /** A login session token or an API key, as sent in `Authorization: Bearer …`. */
  userForToken(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (session) return session;
    if (!String(token).startsWith(Store.API_KEY_PREFIX)) return null;
    const hash = Store._keyHash(token);
    const key = Object.values(this.data.apiKeys).find((k) => k.hash === hash);
    if (!key || !this.data.users[key.owner]) return null;
    // Remember roughly when a key was last used, without rewriting the file on every request.
    if (Date.now() - (key.lastUsedAt || 0) > 60 * 1000) {
      key.lastUsedAt = Date.now();
      this._save();
    }
    return key.owner;
  }

  // ---------- API keys (long-lived credentials for integrations) ----------

  static _keyHash(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
  }

  static _publicKey(k) {
    const { hash, ...rest } = k;
    return rest;
  }

  /** Returns the key itself once; only its hash is stored. */
  createApiKey(owner, name) {
    if (!this.data.users[owner]) throw new Error('No such user');
    const mine = Object.values(this.data.apiKeys).filter((k) => k.owner === owner);
    if (mine.length >= Store.MAX_API_KEYS) throw new Error(`You can have at most ${Store.MAX_API_KEYS} API keys`);
    const key = Store.API_KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
    const record = {
      id: 'key_' + crypto.randomBytes(6).toString('hex'),
      owner,
      name: String(name || '').trim().slice(0, 60) || 'API key',
      preview: `${key.slice(0, 8)}…${key.slice(-4)}`,
      hash: Store._keyHash(key),
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    this.data.apiKeys[record.id] = record;
    this._save();
    return { key, apiKey: Store._publicKey(record) };
  }

  listApiKeys(owner) {
    return Object.values(this.data.apiKeys)
      .filter((k) => k.owner === owner)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(Store._publicKey);
  }

  revokeApiKey(owner, id) {
    const k = this.data.apiKeys[id];
    if (!k || k.owner !== owner) throw new Error('API key not found');
    delete this.data.apiKeys[id];
    this._save();
  }

  // ---------- webhooks ----------

  static _publicWebhook(w) {
    const { secret, ...rest } = w;
    return rest;
  }

  /** `events`: event names, or ['*'] for all. Returns the signing secret once. */
  createWebhook(owner, { url, events, description }) {
    if (!this.data.users[owner]) throw new Error('No such user');
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch {
      throw new Error('url must be a valid http(s) URL');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('url must be a valid http(s) URL');
    if (parsed.username || parsed.password) throw new Error('url must not contain credentials');
    const list = Array.isArray(events) && events.length ? [...new Set(events.map(String))] : ['*'];
    const unknown = list.filter((e) => e !== '*' && !Store.WEBHOOK_EVENTS.includes(e));
    if (unknown.length) throw new Error(`Unknown event: ${unknown.join(', ')}`);
    const mine = Object.values(this.data.webhooks).filter((w) => w.owner === owner);
    if (mine.length >= Store.MAX_WEBHOOKS) throw new Error(`You can have at most ${Store.MAX_WEBHOOKS} webhooks`);
    const hook = {
      id: 'wh_' + crypto.randomBytes(6).toString('hex'),
      owner,
      url: parsed.toString(),
      events: list,
      description: String(description || '').trim().slice(0, 120),
      secret: 'whsec_' + crypto.randomBytes(24).toString('base64url'),
      active: true,
      createdAt: Date.now(),
      failures: 0,
      lastDelivery: null,
    };
    this.data.webhooks[hook.id] = hook;
    this._save();
    return { secret: hook.secret, webhook: Store._publicWebhook(hook) };
  }

  listWebhooks(owner) {
    return Object.values(this.data.webhooks)
      .filter((w) => w.owner === owner)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(Store._publicWebhook);
  }

  getWebhook(owner, id) {
    const w = this.data.webhooks[id];
    if (!w || w.owner !== owner) throw new Error('Webhook not found');
    return w;
  }

  updateWebhook(owner, id, { active, events }) {
    const w = this.getWebhook(owner, id);
    if (typeof active === 'boolean') {
      w.active = active;
      if (active) w.failures = 0;
    }
    if (Array.isArray(events) && events.length) {
      const unknown = events.filter((e) => e !== '*' && !Store.WEBHOOK_EVENTS.includes(e));
      if (unknown.length) throw new Error(`Unknown event: ${unknown.join(', ')}`);
      w.events = [...new Set(events)];
    }
    this._save();
    return Store._publicWebhook(w);
  }

  deleteWebhook(owner, id) {
    this.getWebhook(owner, id);
    delete this.data.webhooks[id];
    this._save();
  }

  /** Active webhooks of `username` subscribed to `event` ('*' skips the chatty typing/presence events). */
  webhooksFor(username, event) {
    return Object.values(this.data.webhooks).filter((w) => w.owner === username && w.active && (
      w.events.includes(event) || (w.events.includes('*') && !Store.NOISY_EVENTS.includes(event))
    ));
  }

  recordDelivery(id, result) {
    const w = this.data.webhooks[id];
    if (!w) return;
    w.lastDelivery = result;
    w.failures = result.ok ? 0 : (w.failures || 0) + 1;
    // Stop calling an endpoint that keeps failing; the owner can turn it back on.
    if (w.failures >= Store.WEBHOOK_MAX_FAILURES) w.active = false;
    this._save();
  }

  logout(token) {
    this.sessions.delete(token);
  }

  publicUser(username) {
    const u = this.data.users[username];
    if (!u) return null;
    const out = { username: u.username, displayName: u.displayName, about: u.about, lastSeen: u.lastSeen };
    if (u.business) out.business = Store._publicBusiness(u.business);
    if (u.verifiedAt) out.verified = true;
    if (this.isPremium(username)) out.premium = true; // the only KYC fact kept: yes, verified
    return out;
  }

  // ---------- profile views ----------
  //
  // Who looked at someone's profile, and when they last did. Only the last time per viewer
  // is kept (no counts, no history), for 90 days. A person who turns this off is not
  // recorded and cannot see who viewed them (and their list is deleted).

  profileViewsEnabled(username) {
    const u = this.data.users[username];
    return !!u && !u.profileViewsOff;
  }

  setProfileViewsEnabled(username, enabled) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    if (enabled) delete u.profileViewsOff;
    else {
      u.profileViewsOff = true;
      delete u.profileViews; // forget who looked
    }
    this._save();
  }

  /** Record that `viewer` looked at `viewed`'s profile. Returns whether it was recorded. */
  recordProfileView(viewer, viewed) {
    const v = this.data.users[viewed];
    if (!v || viewer === viewed || !this.data.users[viewer]) return false;
    if (!this.profileViewsEnabled(viewer) || !this.profileViewsEnabled(viewed)) return false;
    if (this.blockedEither(viewer, viewed)) return false;
    v.profileViews = v.profileViews || {};
    v.profileViews[viewer] = Date.now();
    // Keep it bounded: drop the oldest beyond 500.
    const entries = Object.entries(v.profileViews);
    if (entries.length > Store.PROFILE_VIEWS_MAX) {
      entries.sort((a, b) => b[1] - a[1]);
      v.profileViews = Object.fromEntries(entries.slice(0, Store.PROFILE_VIEWS_MAX));
    }
    this._save();
    return true;
  }

  /** [{ username, lastViewedAt, inContact }] newest first, last 90 days only. */
  profileViewsOf(username) {
    const u = this.data.users[username];
    if (!u?.profileViews) return [];
    const cutoff = Date.now() - Store.PROFILE_VIEWS_DAYS * 86400000;
    let pruned = false;
    for (const [who, ts] of Object.entries(u.profileViews)) {
      if (ts < cutoff || !this.data.users[who]) {
        delete u.profileViews[who];
        pruned = true;
      }
    }
    if (pruned) this._save();
    return Object.entries(u.profileViews)
      .map(([who, lastViewedAt]) => ({ username: who, lastViewedAt, inContact: this.areContacts(username, who) }))
      .sort((a, b) => b.lastViewedAt - a.lastViewedAt);
  }

  /** In contact = a one-to-one chat with at least one message between them. */
  areContacts(a, b) {
    return (this.data.messages[Store.directId(a, b)] || []).some((m) => m.type !== 'system');
  }

  // ---------- premium subscription ----------

  subscriptionOf(username) {
    return this.data.users[username]?.subscription || null;
  }

  isPremium(username) {
    const sub = this.data.users[username]?.subscription;
    return !!sub && sub.expiresAt > Date.now();
  }

  /** Premium until `expiresAt`. Only the plan and dates are kept: no payment details. */
  activateSubscription(username, { plan, expiresAt }) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    u.subscription = { plan, expiresAt, since: u.subscription?.expiresAt > Date.now() ? u.subscription.since : Date.now() };
    this._save();
    return u.subscription;
  }

  /** Users whose Premium ended in (from, to]. */
  expiredBetween(from, to) {
    return Object.values(this.data.users).filter((u) => u.subscription && u.subscription.expiresAt > from && u.subscription.expiresAt <= to).map((u) => u.username);
  }

  // ---------- verified badge ----------

  isVerified(username) {
    return !!this.data.users[username]?.verifiedAt;
  }

  /** Mark the account verified. This is all that is stored: no ID type, number or name. */
  setVerified(username) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    u.verifiedAt = Date.now();
    this._save();
  }

  // ---------- business profile ----------

  /** What everyone sees (greeting/away texts stay private to the owner). */
  static _publicBusiness(b) {
    const { greeting, away, ...pub } = b;
    return pub;
  }

  getBusiness(username) {
    return this.data.users[username]?.business || null;
  }

  /** Turn the account into a business account, or update it. */
  setBusiness(username, input = {}) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    const str = (v, max, field) => {
      const t = String(v ?? '').trim();
      if (t.length > max) throw new Error(`${field} is too long (max ${max} characters)`);
      return t;
    };
    const category = str(input.category, 60, 'category');
    if (!BusinessHours.CATEGORIES.includes(category)) throw new Error(`category must be one of: ${BusinessHours.CATEGORIES.join(', ')}`);
    // The contact email of an account with a verified email is always that email.
    const email = u.email || str(input.email, 120, 'email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email is not valid');
    let website = str(input.website, 200, 'website');
    if (website) {
      if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
      try {
        const url = new URL(website);
        if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) throw new Error();
        website = url.toString();
      } catch {
        throw new Error('website is not a valid URL');
      }
    }
    const timezone = str(input.timezone || 'UTC', 64, 'timezone');
    if (!BusinessHours.isValidTimeZone(timezone)) throw new Error('timezone is not a valid IANA time zone (e.g. "Asia/Kolkata")');
    const auto = (v, field) => {
      const enabled = !!v?.enabled;
      const text = str(v?.text, 1000, `${field} message`);
      if (enabled && !text) throw new Error(`${field} message needs text`);
      return { enabled, text };
    };
    u.business = {
      category,
      description: str(input.description, 512, 'description'),
      address: str(input.address, 256, 'address'),
      email,
      website,
      timezone,
      hours: BusinessHours.normaliseHours(input.hours),
      greeting: auto(input.greeting, 'Greeting'),
      away: auto(input.away, 'Away'),
      since: u.business?.since || Date.now(),
    };
    this._save();
    return u.business;
  }

  removeBusiness(username) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    delete u.business;
    this._save();
  }

  // ---------- disappearing messages ----------

  /** The user's timer for chats they start (seconds), or null. */
  defaultDisappear(username) {
    return this.data.users[username]?.defaultDisappear || null;
  }

  setDefaultDisappear(username, seconds) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    u.defaultDisappear = Store.checkTimer(seconds);
    this._save();
    return u.defaultDisappear;
  }

  /** null/0 = off; otherwise 1 minute … 365 days, in seconds. */
  static checkTimer(seconds) {
    if (seconds === null || seconds === undefined || seconds === 0 || seconds === '0') return null;
    const n = Number(seconds);
    if (!Number.isInteger(n) || n < Store.TIMER_MIN || n > Store.TIMER_MAX) {
      throw new Error('Timer must be between 1 minute (60) and 365 days (31536000), in whole seconds, or 0 to turn it off');
    }
    return n;
  }

  setDisappearing(convId, username, seconds) {
    const conv = this.getConversation(convId);
    if (!conv || !conv.members.includes(username)) throw new Error('Conversation not found');
    const value = Store.checkTimer(seconds);
    if (value) conv.disappearAfter = value;
    else delete conv.disappearAfter;
    conv.disappearSetBy = username;
    this._save();
    return conv;
  }

  /** A notice in the chat ("Alice turned on disappearing messages…"). Never unread, never disappears. */
  addSystemMessage(convId, by, system) {
    const conv = this.getConversation(convId);
    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      convId,
      from: by,
      type: 'system',
      text: '',
      system,
      ts: Date.now(),
      deliveredTo: [],
      readBy: conv.members.filter((m) => m !== by),
    };
    this.data.messages[convId].push(msg);
    this._save();
    return msg;
  }

  /** Remove messages whose timer ran out. Returns [{ convId, ids }]. */
  pruneMessages(now = Date.now()) {
    const removed = [];
    for (const [convId, msgs] of Object.entries(this.data.messages)) {
      const expired = msgs.filter((m) => m.expiresAt && m.expiresAt <= now);
      if (!expired.length) continue;
      for (const m of expired) if (m.voice) this.deleteMedia(m.voice.mediaId);
      this.data.messages[convId] = msgs.filter((m) => !(m.expiresAt && m.expiresAt <= now));
      removed.push({ convId, ids: expired.map((m) => m.id) });
    }
    if (removed.length) this._save();
    return removed;
  }

  /** Public profile as seen by `viewer`: blocking hides "last seen" in both directions. */
  publicUserFor(username, viewer) {
    const u = this.publicUser(username);
    if (u && viewer && this.blockedEither(username, viewer)) u.lastSeen = null;
    return u;
  }

  // ---------- blocking ----------

  hasBlocked(username, target) {
    return !!this.data.users[username]?.blocked?.includes(target);
  }

  blockedEither(a, b) {
    return this.hasBlocked(a, b) || this.hasBlocked(b, a);
  }

  blockedList(username) {
    return [...(this.data.users[username]?.blocked || [])];
  }

  setBlocked(username, target, blocked) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    if (!this.data.users[target]) throw new Error('User not found');
    if (target === username) throw new Error('You cannot block yourself');
    const list = new Set(u.blocked || []);
    if (blocked) list.add(target);
    else list.delete(target);
    u.blocked = [...list];
    this._save();
    return u.blocked;
  }

  // ---------- chat lock (secret code per user, locked chats) ----------

  hasLockCode(username) {
    return !!this.data.users[username]?.chatLock;
  }

  /** Set the secret code. Changing an existing one needs the current code. */
  setLockCode(username, code, currentCode) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    Store._checkLockCode(code);
    if (u.chatLock && !this.verifyLockCode(username, currentCode)) throw new Error('Current secret code is wrong');
    const salt = crypto.randomBytes(16).toString('hex');
    u.chatLock = { salt, hash: Store._hash(String(code), salt) };
    this._save();
  }

  /**
   * Forgot the code: choose a new one. Needs the account password, or `password: null`
   * when the caller already verified an OTP sent to the account's mobile number.
   */
  resetLockCode(username, password, newCode) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    if (password !== null) {
      const hash = u.hash ? Store._hash(String(password || ''), u.salt) : null;
      if (!hash || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) throw new Error('Password is wrong');
    }
    Store._checkLockCode(newCode);
    const salt = crypto.randomBytes(16).toString('hex');
    u.chatLock = { salt, hash: Store._hash(String(newCode), salt) };
    this._save();
  }

  verifyLockCode(username, code) {
    const lock = this.data.users[username]?.chatLock;
    if (!lock || typeof code !== 'string' || !code) return false;
    const hash = Store._hash(code, lock.salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(lock.hash, 'hex'));
  }

  static _checkLockCode(code) {
    if (typeof code !== 'string' || code.length < 4 || code.length > 32) {
      throw new Error('Secret code must be 4 to 32 characters');
    }
  }

  lockedChats(username) {
    return [...(this.data.users[username]?.lockedChats || [])];
  }

  isChatLocked(username, convId) {
    return !!this.data.users[username]?.lockedChats?.includes(convId);
  }

  // ---------- hidden chats ----------

  hiddenChats(username) {
    return [...(this.data.users[username]?.hiddenChats || [])];
  }

  isChatHidden(username, convId) {
    return !!this.data.users[username]?.hiddenChats?.includes(convId);
  }

  /** Hide a chat from the chat list. Hiding replaces the chat's own lock (hidden chats are protected as a group). */
  setChatHidden(username, convId, hidden) {
    const u = this.data.users[username];
    if (!u || !this.isMember(convId, username)) throw new Error('Conversation not found');
    if (hidden && !u.chatLock) throw new Error('Set a secret code first');
    const set = new Set(u.hiddenChats || []);
    if (hidden) set.add(convId);
    else set.delete(convId);
    u.hiddenChats = [...set];
    if (hidden && u.lockedChats) u.lockedChats = u.lockedChats.filter((id) => id !== convId);
    this._save();
  }

  /** Bring every hidden chat back to the chat list. Returns their ids. */
  clearHidden(username) {
    const u = this.data.users[username];
    const ids = this.hiddenChats(username);
    if (u) {
      u.hiddenChats = [];
      this._save();
    }
    return ids;
  }

  /** Remove the lock from every locked chat. Returns their ids. */
  clearLocked(username) {
    const u = this.data.users[username];
    const ids = this.lockedChats(username);
    if (u) {
      u.lockedChats = [];
      this._save();
    }
    return ids;
  }

  // ---------- fingerprint / face lock (WebAuthn credentials) ----------

  passkeysOf(username) {
    return this.data.users[username]?.passkeys || [];
  }

  addPasskey(username, credential, name) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    u.passkeys = u.passkeys || [];
    if (u.passkeys.length >= 5) throw new Error('You can have at most 5 devices with fingerprint or face lock');
    if (u.passkeys.some((k) => k.id === credential.id)) throw new Error('This device is already set up');
    const entry = { ...credential, name: String(name || 'This device').trim().slice(0, 40) || 'This device', createdAt: Date.now() };
    u.passkeys.push(entry);
    this._save();
    return Store._publicPasskey(entry);
  }

  removePasskey(username, id) {
    const u = this.data.users[username];
    const before = u?.passkeys?.length || 0;
    if (u?.passkeys) u.passkeys = u.passkeys.filter((k) => k.id !== id);
    if (!before || u.passkeys.length === before) throw new Error('Device not found');
    this._save();
  }

  setPasskeyCounter(username, id, counter) {
    const k = this.passkeysOf(username).find((x) => x.id === id);
    if (k) {
      k.counter = counter;
      this._save();
    }
  }

  static _publicPasskey({ id, name, createdAt }) {
    return { id, name, createdAt };
  }

  setChatLocked(username, convId, locked) {
    const u = this.data.users[username];
    if (!u || !this.isMember(convId, username)) throw new Error('Conversation not found');
    if (locked && !u.chatLock) throw new Error('Set a secret code first');
    if (locked && this.isChatHidden(username, convId)) throw new Error('Hidden chats are already protected');
    const set = new Set(u.lockedChats || []);
    if (locked) set.add(convId);
    else set.delete(convId);
    u.lockedChats = [...set];
    this._save();
  }

  updateProfile(username, { displayName, about }) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    if (typeof displayName === 'string' && displayName.trim()) {
      const name = displayName.trim().slice(0, 40);
      // A verified identity belongs to a name: changing it means verifying again.
      if (name !== u.displayName) delete u.verifiedAt;
      u.displayName = name;
    }
    if (typeof about === 'string') u.about = about.trim().slice(0, 140);
    this._save();
    return this.publicUser(username);
  }

  touchLastSeen(username) {
    const u = this.data.users[username];
    if (u) {
      u.lastSeen = Date.now();
      this._save();
    }
  }

  searchUsers(query, exclude) {
    const q = String(query || '').trim().toLowerCase();
    // A full mobile number finds its owner (the number itself is never returned).
    const digits = q.replace(/[\s\-().]/g, '').replace(/^00/, '+');
    const phone = /^\+?\d{8,15}$/.test(digits) ? digits.replace(/^(?!\+)/, '+') : null;
    return Object.values(this.data.users)
      .filter((u) => u.username !== exclude)
      .filter((u) => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q)
        || (u.business && u.business.category.toLowerCase().includes(q))
        || (phone && u.phone === phone))
      .slice(0, 50)
      .map((u) => this.publicUser(u.username));
  }

  // ---------- conversations ----------

  static directId(a, b) {
    return 'dm:' + [a, b].sort().join(':');
  }

  getOrCreateDirect(a, b) {
    if (a === b) throw new Error('Cannot chat with yourself');
    if (!this.data.users[b]) throw new Error('User not found');
    const id = Store.directId(a, b);
    if (!this.data.conversations[id]) {
      this.data.conversations[id] = {
        id,
        type: 'direct',
        members: [a, b].sort(),
        createdAt: Date.now(),
      };
      // The person starting the chat may have a default message timer.
      if (this.defaultDisappear(a)) Object.assign(this.data.conversations[id], { disappearAfter: this.defaultDisappear(a), disappearSetBy: a });
      this.data.messages[id] = [];
      this._save();
    }
    return this.data.conversations[id];
  }

  createGroup(owner, name, members) {
    name = String(name || '').trim().slice(0, 50);
    if (!name) throw new Error('Group name is required');
    const set = new Set([owner, ...(members || []).map((m) => String(m).toLowerCase())]);
    for (const m of set) if (!this.data.users[m]) throw new Error(`User not found: ${m}`);
    if (set.size < 2) throw new Error('Add at least one other member');
    const id = 'grp:' + crypto.randomBytes(8).toString('hex');
    this.data.conversations[id] = {
      id,
      type: 'group',
      name,
      owner,
      admins: [owner],
      members: [...set],
      ...(this.defaultDisappear(owner) ? { disappearAfter: this.defaultDisappear(owner), disappearSetBy: owner } : {}),
      createdAt: Date.now(),
    };
    this.data.messages[id] = [];
    this._save();
    return this.data.conversations[id];
  }

  getConversation(id) {
    return this.data.conversations[id] || null;
  }

  isMember(convId, username) {
    const c = this.getConversation(convId);
    return !!c && c.members.includes(username);
  }

  conversationsFor(username) {
    return Object.values(this.data.conversations)
      .filter((c) => c.members.includes(username))
      .map((c) => this.summarize(c, username))
      .sort((a, b) => (b.lastMessage?.ts || b.createdAt) - (a.lastMessage?.ts || a.createdAt));
  }

  // ---------- per-chat translation language (private to me) ----------

  translateTo(username, convId) {
    return this.data.users[username]?.translate?.[convId] || null;
  }

  setTranslateTo(username, convId, lang) {
    const u = this.data.users[username];
    if (!u || !this.isMember(convId, username)) throw new Error('Conversation not found');
    u.translate = u.translate || {};
    if (lang) u.translate[convId] = lang;
    else delete u.translate[convId];
    this._save();
  }

  summarize(conv, username) {
    const msgs = (this.data.messages[conv.id] || []).filter((m) => Store.visibleTo(m, username));
    const unread = msgs.filter((m) => m.from !== username && !m.readBy.includes(username)).length;
    const last = msgs[msgs.length - 1];
    return {
      ...conv,
      lastMessage: last ? this.viewFor(last, username) : null,
      unread,
      ...(this.translateTo(username, conv.id) ? { translateTo: this.translateTo(username, conv.id) } : {}),
    };
  }

  /**
   * Messages from someone `username` has blocked are stored but never shown to them,
   * and disappearing messages vanish as soon as their timer runs out.
   */
  static visibleTo(msg, username) {
    if (msg.expiresAt && msg.expiresAt <= Date.now()) return false;
    return !msg.hiddenFor?.includes(username);
  }

  /** A message as `username` may see it: per-user fields are reduced to their own view. */
  viewFor(msg, username) {
    const { starredBy, hiddenFor, ...rest } = msg;
    if (starredBy?.includes(username)) rest.starred = true;
    // End-to-end encrypted: each person only gets the key wraps meant for their own devices.
    if (rest.e2ee) {
      const mine = new Set(this.devicesOf(username).map((d) => d.id));
      rest.e2ee = { ...rest.e2ee, w: Object.fromEntries(Object.entries(rest.e2ee.w).filter(([id]) => mine.has(id))) };
    }
    return rest;
  }

  // ---------- end-to-end encryption: device keys ----------
  //
  // Each browser/phone makes its own P-256 key pair and only ever sends the public half here.
  // Senders encrypt every message separately for each device of each member; the server
  // keeps this directory and the ciphertext, and cannot read message text.

  devicesOf(username) {
    return this.data.users[username]?.devices || [];
  }

  static _publicDevice({ id, name, publicKey, keyId, createdAt }) {
    return { id, name, publicKey, keyId, createdAt };
  }

  publicDevices(username) {
    return this.devicesOf(username).map(Store._publicDevice);
  }

  /** Register a device's public key (raw P-256 point, base64url). Re-registering the same key returns the same device. */
  addDevice(username, { name, publicKey }) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    const raw = Buffer.from(String(publicKey || ''), 'base64url');
    try {
      if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad');
      crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    } catch {
      throw Object.assign(new Error('publicKey must be a P-256 public key (65 bytes, base64url)'), { status: 400 });
    }
    const key = raw.toString('base64url');
    u.devices = u.devices || [];
    const same = u.devices.find((d) => d.publicKey === key);
    if (same) return Store._publicDevice(same);
    if (u.devices.length >= Store.MAX_DEVICES) throw new Error(`You can have at most ${Store.MAX_DEVICES} devices with encryption. Remove one first.`);
    const device = {
      id: crypto.randomBytes(8).toString('hex'),
      name: String(name || 'This device').trim().slice(0, 40) || 'This device',
      publicKey: key,
      keyId: crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 16),
      createdAt: Date.now(),
    };
    u.devices.push(device);
    this._save();
    return Store._publicDevice(device);
  }

  removeDevice(username, id) {
    const u = this.data.users[username];
    const before = u?.devices?.length || 0;
    if (u?.devices) u.devices = u.devices.filter((d) => d.id !== id);
    if (!before || u.devices.length === before) throw new Error('Device not found');
    this._save();
  }

  /** Who owns a device id (usernames, or null). */
  deviceOwner(id) {
    for (const u of Object.values(this.data.users)) if (u.devices?.some((d) => d.id === id)) return u.username;
    return null;
  }

  findMessage(msgId) {
    for (const [convId, msgs] of Object.entries(this.data.messages)) {
      const m = msgs.find((x) => x.id === msgId);
      if (m) return { convId, message: m };
    }
    return null;
  }

  findByClientId(convId, from, clientId) {
    if (!clientId) return null;
    clientId = String(clientId).slice(0, 64);
    return (this.data.messages[convId] || []).slice(-200).find((m) => m.from === from && m.clientId === clientId) || null;
  }

  // ---------- voice-message media ----------

  /** `scope` is a conversation id (voice messages) or `{ statusId }` (status photos). */
  saveMedia(scope, buffer, mime) {
    const id = crypto.randomBytes(12).toString('hex');
    if (this.mediaDir) {
      fs.mkdirSync(this.mediaDir, { recursive: true });
      fs.writeFileSync(path.join(this.mediaDir, id), buffer);
    } else {
      this.memoryMedia.set(id, buffer);
    }
    const where = typeof scope === 'string' ? { convId: scope } : { statusId: scope.statusId };
    this.data.media[id] = { ...where, mime, size: buffer.length, createdAt: Date.now() };
    this._save();
    return id;
  }

  /** `{ mime, buffer }` if `username` may access the media, else null. */
  /** The conversation a media file belongs to (voice messages), or null (status photos). */
  mediaConversation(id) {
    return this.data.media[id]?.convId || null;
  }

  getMedia(id, username) {
    const meta = this.data.media[id];
    if (!meta) return null;
    const allowed = meta.statusId
      ? this.canSeeStatus(this.data.statuses[meta.statusId], username)
      : this.isMember(meta.convId, username);
    if (!allowed) return null;
    let buffer;
    if (this.mediaDir) {
      const file = path.join(this.mediaDir, path.basename(id));
      if (!fs.existsSync(file)) return null;
      buffer = fs.readFileSync(file);
    } else {
      buffer = this.memoryMedia.get(id);
    }
    return buffer ? { mime: meta.mime, buffer } : null;
  }

  deleteMedia(id) {
    if (!this.data.media[id]) return;
    delete this.data.media[id];
    this.memoryMedia.delete(id);
    if (this.mediaDir) fs.rmSync(path.join(this.mediaDir, path.basename(id)), { force: true });
    this._save();
  }

  // ---------- messages ----------

  /**
   * `masked`: hide the text behind a "tap to reveal" cover for recipients.
   * `clientId`: sender-generated id; re-sending the same clientId (a retry after a
   * timeout or reconnect) returns the stored message instead of duplicating it.
   * `voice`: `{ mediaId, duration, mime }` for a voice message (text is then empty).
   * `statusReply`: `{ statusId, owner, type, preview }` when replying to a status update.
   */
  addMessage(convId, from, text, { masked = false, clientId, voice, statusReply, auto, e2ee } = {}) {
    const conv = this.getConversation(convId);
    if (!conv || !conv.members.includes(from)) throw new Error('Not a member of this chat');
    const existing = this.findByClientId(convId, from, clientId);
    if (existing) return existing;

    let hiddenFor = [];
    if (conv.type === 'direct') {
      const peer = conv.members.find((m) => m !== from);
      if (this.hasBlocked(from, peer)) {
        throw new Error(`Unblock ${this.publicUser(peer)?.displayName || peer} to send a message`);
      }
      // Like WhatsApp: the sender isn't told; the message just never gets delivered.
      if (this.hasBlocked(peer, from)) hiddenFor = [peer];
    }

    text = voice || e2ee ? '' : String(text || '').trim();
    if (!voice && !e2ee && !text) throw new Error('Message is empty');
    if (text.length > 4000) throw new Error('Message is too long');
    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      convId,
      from,
      text,
      ts: Date.now(),
      deliveredTo: [],
      readBy: [],
    };
    if (voice) {
      msg.type = 'voice';
      msg.voice = { mediaId: voice.mediaId, duration: Math.max(0, Math.round(Number(voice.duration) || 0)), mime: voice.mime };
    }
    if (e2ee) msg.e2ee = e2ee; // end-to-end encrypted: the server holds only ciphertext
    if (masked && !voice) msg.masked = true;
    if (statusReply) msg.statusReply = statusReply;
    if (auto) msg.auto = auto; // 'greeting' | 'away' (business automatic replies)
    if (conv.disappearAfter) msg.expiresAt = msg.ts + conv.disappearAfter * 1000;
    if (clientId) msg.clientId = String(clientId).slice(0, 64);
    if (hiddenFor.length) msg.hiddenFor = hiddenFor;
    this.data.messages[convId].push(msg);
    this._save();
    return msg;
  }

  /**
   * Record a voice/video call in the conversation history.
   * `call` is `{ kind: 'audio'|'video', status: 'completed'|'missed'|'declined', duration, group }`.
   * `joined`: everyone who took part; for them the entry is not unread.
   */
  addCallMessage(convId, from, { kind, status, duration = 0, group = false }, joined = []) {
    const conv = this.getConversation(convId);
    if (!conv || !conv.members.includes(from)) throw new Error('Not a member of this chat');
    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      convId,
      from,
      type: 'call',
      text: '',
      call: { kind, status, duration, ...(group ? { group: true, joined: [...joined] } : {}) },
      ts: Date.now(),
      deliveredTo: [],
      // Only calls someone missed should show up as unread for them.
      readBy: conv.members.filter((m) => m !== from && (joined.includes(m) || (!group && status === 'completed'))),
    };
    this.data.messages[convId].push(msg);
    this._save();
    return msg;
  }

  getMessages(convId, username, { before, limit = 50 } = {}) {
    if (!this.isMember(convId, username)) throw new Error('Not a member of this chat');
    let msgs = (this.data.messages[convId] || []).filter((m) => Store.visibleTo(m, username));
    if (before) msgs = msgs.filter((m) => m.ts < before);
    return msgs.slice(-limit).map((m) => this.viewFor(m, username));
  }

  // ---------- starred messages (private to each user) ----------

  setStarred(msgId, username, starred) {
    const found = this.findMessage(msgId);
    if (!found || !this.isMember(found.convId, username) || !Store.visibleTo(found.message, username)) {
      throw new Error('Message not found');
    }
    const m = found.message;
    if (m.deleted) throw new Error('Deleted messages cannot be starred');
    const set = new Set(m.starredBy || []);
    if (starred) set.add(username);
    else set.delete(username);
    if (set.size) m.starredBy = [...set];
    else delete m.starredBy;
    this._save();
    return { convId: found.convId, message: this.viewFor(m, username) };
  }

  // ---------- status updates (disappear after statusTtlMs) ----------

  /** Everyone `username` has a one-to-one chat with: the audience for their status updates. */
  directPeers(username) {
    const peers = new Set();
    for (const c of Object.values(this.data.conversations)) {
      if (c.type === 'direct' && c.members.includes(username)) c.members.forEach((m) => m !== username && peers.add(m));
    }
    return peers;
  }

  /** Who sees `owner`'s status updates right now. */
  statusAudience(owner) {
    return [...this.directPeers(owner)].filter((u) => !this.blockedEither(owner, u));
  }

  canSeeStatus(status, viewer) {
    if (!status || status.expiresAt <= Date.now()) return false;
    if (status.owner === viewer) return true;
    return this.directPeers(status.owner).has(viewer) && !this.blockedEither(status.owner, viewer);
  }

  newStatusId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * `fields`: `{ type: 'text', text, bg }` or `{ type: 'image', mediaId, caption }`.
   * Pass `id` when media was already saved for it (see newStatusId).
   */
  addStatus(owner, fields, id = this.newStatusId()) {
    if (!this.data.users[owner]) throw new Error('No such user');
    const status = { id, owner, ts: Date.now(), expiresAt: Date.now() + this.statusTtlMs, views: {} };
    if (fields.type === 'text') {
      const text = String(fields.text || '').trim();
      if (!text) throw new Error('Status is empty');
      if (text.length > 700) throw new Error('Status is too long');
      Object.assign(status, { type: 'text', text, bg: /^#[0-9a-f]{6}$/i.test(fields.bg || '') ? fields.bg : '#0670DE' });
    } else if (fields.type === 'image') {
      if (!fields.mediaId) throw new Error('Photo is missing');
      Object.assign(status, { type: 'image', mediaId: fields.mediaId, caption: String(fields.caption || '').trim().slice(0, 700) });
    } else {
      throw new Error('Invalid status type');
    }
    this.data.statuses[id] = status;
    this._save();
    return status;
  }

  /** A status as `viewer` may see it: only the owner gets the list of viewers. */
  statusView(status, viewer) {
    const { views, ...rest } = status;
    if (status.owner === viewer) {
      rest.views = Object.entries(views).map(([username, ts]) => ({ username, ts })).sort((a, b) => b.ts - a.ts);
    } else if (views[viewer]) {
      rest.viewed = true;
    }
    return rest;
  }

  statusesFor(viewer) {
    return Object.values(this.data.statuses)
      .filter((s) => this.canSeeStatus(s, viewer))
      .sort((a, b) => a.ts - b.ts)
      .map((s) => this.statusView(s, viewer));
  }

  /** Record that `viewer` saw a status. Returns the view time if this is their first view, else null. */
  markStatusViewed(id, viewer) {
    const status = this.data.statuses[id];
    if (!this.canSeeStatus(status, viewer)) throw new Error('Status not found');
    if (status.owner === viewer || status.views[viewer]) return null;
    status.views[viewer] = Date.now();
    this._save();
    return status.views[viewer];
  }

  deleteStatus(id, owner) {
    const status = this.data.statuses[id];
    if (!status || status.owner !== owner) throw new Error('Status not found');
    this._removeStatus(status);
    return status;
  }

  /** Drop expired updates (and their photos). Returns the removed statuses. */
  pruneStatuses(now = Date.now()) {
    const expired = Object.values(this.data.statuses).filter((s) => s.expiresAt <= now);
    expired.forEach((s) => this._removeStatus(s));
    return expired;
  }

  _removeStatus(status) {
    delete this.data.statuses[status.id];
    if (status.mediaId) this.deleteMedia(status.mediaId);
    this._save();
  }

  starredFor(username) {
    const out = [];
    for (const [convId, msgs] of Object.entries(this.data.messages)) {
      if (!this.isMember(convId, username)) continue;
      for (const m of msgs) {
        if (m.starredBy?.includes(username) && !m.deleted && Store.visibleTo(m, username)) out.push(this.viewFor(m, username));
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  /** Mark messages delivered to `username`. Returns messages whose status changed. */
  markDelivered(convId, username) {
    const changed = [];
    for (const m of this.data.messages[convId] || []) {
      if (m.from !== username && !m.deliveredTo.includes(username) && Store.visibleTo(m, username)) {
        m.deliveredTo.push(username);
        changed.push(m);
      }
    }
    if (changed.length) this._save();
    return changed;
  }

  /** Mark all messages in a conversation as read by `username`. Returns changed messages. */
  markRead(convId, username) {
    if (!this.isMember(convId, username)) return [];
    const changed = [];
    for (const m of this.data.messages[convId] || []) {
      if (m.from === username || !Store.visibleTo(m, username)) continue;
      let touched = false;
      if (!m.deliveredTo.includes(username)) {
        m.deliveredTo.push(username);
        touched = true;
      }
      if (!m.readBy.includes(username)) {
        m.readBy.push(username);
        touched = true;
      }
      if (touched) changed.push(m);
    }
    if (changed.length) this._save();
    return changed;
  }

  deleteMessage(msgId, username) {
    for (const [convId, msgs] of Object.entries(this.data.messages)) {
      const m = msgs.find((x) => x.id === msgId);
      if (!m) continue;
      if (m.from !== username) throw new Error('You can only delete your own messages');
      if (m.type === 'call') throw new Error('Call history entries cannot be deleted');
      if (m.voice) this.deleteMedia(m.voice.mediaId);
      m.text = '';
      m.deleted = true;
      delete m.voice;
      delete m.e2ee;
      delete m.masked;
      delete m.starredBy;
      this._save();
      return { convId, message: m };
    }
    throw new Error('Message not found');
  }
}

Store.TIMER_MIN = 60;
Store.TIMER_MAX = 365 * 24 * 60 * 60;
Store.API_KEY_PREFIX = 'cak_';
Store.MAX_API_KEYS = 10;
Store.MAX_WEBHOOKS = 5;
Store.WEBHOOK_MAX_FAILURES = 20;
/** Events that can be delivered to webhooks (same names and payloads as the Socket.IO events). */
Store.MAX_DEVICES = 5;
Store.PROFILE_VIEWS_MAX = 500;
Store.PROFILE_VIEWS_DAYS = 90;
Store.WEBHOOK_EVENTS = [
  'message:new', 'message:status', 'message:deleted', 'message:starred',
  'conversation:new', 'typing', 'presence', 'user:updated', 'blocked:update',
  'call:incoming', 'call:ended', 'call:state',
  'status:new', 'status:viewed', 'status:deleted',
  'chatlock:update',
  'conversation:updated', 'message:expired',
  'ping',
];
Store.NOISY_EVENTS = ['typing', 'presence'];

module.exports = { Store };
