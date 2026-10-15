'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BusinessHours = require('../public/business-hours.js');
const { DEFAULT_SETTINGS, applySettings } = require('./features');

/**
 * Simple JSON-file backed data store for users, conversations and messages.
 * Everything is kept in memory and flushed to disk (debounced) on change.
 * Pass `file: null` to keep data in memory only (used by tests).
 */
class Store {
  /** `statusTtlMs`: how long a status update stays up (24 hours, shorter in tests). */
  constructor({ file, statusTtlMs = 24 * 60 * 60 * 1000, persistence = null, initialData = null, mediaDir } = {}) {
    this.statusTtlMs = statusTtlMs;
    this.file = file === undefined && !persistence ? path.join(__dirname, '..', 'data', 'db.json') : (file || null);
    this.data = { users: {}, conversations: {}, messages: {}, media: {}, statuses: {}, apiKeys: {}, webhooks: {}, channels: {}, channelPosts: {}, reports: [], admins: {}, audit: [], settings: null, ...(initialData || {}) };
    this.sessions = new Map(); // token -> username
    // Voice-message audio lives next to the data file, in `mediaDir`, or in memory without either.
    this.mediaDir = mediaDir || (this.file ? path.join(path.dirname(this.file), 'media') : null);
    this.memoryMedia = new Map(); // id -> Buffer (when there is no data file)
    this._saveTimer = null;
    this._convIdx = null; // username -> [conversations], built on first use
    this._contactIdx = null; // { phone: Map, email: Map }, built on first use
    this._load();
    // Optional hook (tests): lets a test run give every new store a PostgreSQL backing.
    this.pg = persistence || (!this.file && Store.defaultPersistence ? Store.defaultPersistence(this) : null);
    if (this.pg) this.data = this.pg.attach(this.data);
  }

  /** Open a store backed by PostgreSQL: creates the tables if needed and loads what is saved. */
  static async open({ databaseUrl, schema, mediaDir, ...options } = {}) {
    const { PgPersistence } = require('./pg');
    const persistence = new PgPersistence({ url: databaseUrl, schema });
    const initialData = await persistence.load();
    return new Store({ ...options, persistence, initialData, mediaDir: mediaDir || path.join(__dirname, '..', 'data', 'media'), file: null });
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { users: {}, conversations: {}, messages: {}, media: {}, statuses: {}, apiKeys: {}, webhooks: {}, channels: {}, channelPosts: {}, reports: [], admins: {}, audit: [], settings: null, ...parsed };
      this._convIdx = null;
      this._contactIdx = null;
    } catch (err) {
      console.error('Could not read data file, starting fresh:', err.message);
    }
  }

  _save() {
    if (this.pg) return this.pg.schedule();
    if (!this.file) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 200);
  }

  /** Save now. With PostgreSQL this returns a promise that resolves when the database has the changes. */
  flush() {
    if (this.pg) return this.pg.flush();
    if (!this.file) return undefined;
    clearTimeout(this._saveTimer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    return undefined;
  }

  /** Records were added to or removed from a message list or a channel's posts. */
  _touchList(coll, key) {
    if (this.pg) this.pg.tracker.markList(coll, key);
  }

  /** A message was changed in place (status, deletion, star): make sure PostgreSQL gets the new version. */
  _touchMsg(convId, msg) {
    if (this.pg) this.pg.tracker.markElem('messages', convId, msg);
  }

  /** Save what is left and release the database connections (shutdown). */
  async close() {
    if (this.pg) await this.pg.close();
    else this.flush();
  }

  // ---------- consent (Terms of Use, Privacy Notice and optional consents) ----------

  consentOf(username) {
    return this.data.users[username]?.consent || null;
  }

  /** Someone accepted the current Terms and Privacy Notice (`items` e.g. ['terms','age']) and maybe gave optional consents. */
  recordConsent(username, { version, items = [], optional = {}, via = 'app' }) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    const now = Date.now();
    const c = u.consent || { version: null, at: null, accepted: [], optional: {}, history: [] };
    c.version = version;
    c.at = now;
    c.accepted = [...new Set([...(c.accepted || []), ...items])];
    for (const [id, granted] of Object.entries(optional)) c.optional[id] = { granted: !!granted, at: now, version };
    c.history = [...(c.history || []), { at: now, action: 'accept', version, items: [...items, ...Object.keys(optional).map((k) => `${k}:${optional[k] ? 'granted' : 'withdrawn'}`)], via }].slice(-100);
    u.consent = c;
    this._save();
    return c;
  }

  /** Give or withdraw one optional consent (translation, kyc). */
  setOptionalConsent(username, id, granted, { version, via = 'app' } = {}) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    const now = Date.now();
    const c = u.consent || { version: null, at: null, accepted: [], optional: {}, history: [] };
    c.optional[id] = { granted: !!granted, at: now, version: version || c.version };
    c.history = [...(c.history || []), { at: now, action: granted ? 'grant' : 'withdraw', version: version || c.version, items: [id], via }].slice(-100);
    u.consent = c;
    this._save();
    return c;
  }

  hasOptionalConsent(username, id) {
    return !!this.data.users[username]?.consent?.optional?.[id]?.granted;
  }

  /**
   * Has this person accepted the current texts? Accounts made before consent existed have no record; they are only
   * held to it when the administrator turns `legal.requireForLegacy` on.
   */
  consentUpToDate(username, version) {
    const u = this.data.users[username];
    if (!u || u.deletedAt) return true;
    const c = u.consent;
    if (!c) return !this.getSettings().legal.requireForLegacy;
    return c.version === version && c.accepted.includes('terms');
  }

  // ---------- your data: download and delete ----------

  /** Everything we hold about `username`, as a plain object (for "Download my data"). */
  exportAccount(username) {
    const u = this.data.users[username];
    if (!u || u.deletedAt) throw new Error('No such account');
    const chats = this._convsOf(username).map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name || null,
      members: c.members,
      owner: c.owner || null,
      createdAt: c.createdAt,
      disappearAfter: c.disappearAfter || null,
      messages: (this.data.messages[c.id] || []).filter((m) => Store.visibleTo(m, username)).map((m) => this.viewFor(m, username)),
    }));
    const own = (coll, key) => Object.values(this.data[coll]).filter((x) => x[key] === username);
    return {
      format: 'vartiq-export-1',
      exportedAt: new Date().toISOString(),
      notice: 'Messages typed in the web app are end-to-end encrypted: they appear here as encrypted envelopes (field "e2ee") because the server cannot read them. Your devices can.',
      account: {
        username,
        displayName: u.displayName,
        about: u.about,
        mobile: u.phone || null,
        email: u.email || null,
        createdAt: u.createdAt,
        lastSeen: u.lastSeen || null,
        verified: !!u.verifiedAt,
        verifiedAt: u.verifiedAt || null,
        subscription: u.subscription || null,
        business: u.business || null,
        catalogue: u.catalogue || null,
        preferences: u.prefs || {},
        translationLanguagesByChat: u.translate || {},
        defaultDisappearSeconds: u.defaultDisappear || null,
        blockedPeople: u.blocked || [],
        profileViewsEnabled: this.profileViewsEnabled(username),
        lockedChats: u.lockedChats || [],
        hiddenChats: u.hiddenChats || [],
        chatLockSet: !!u.chatLock,
        devices: (u.devices || []).map((d) => ({ id: d.id, name: d.name, publicKey: d.publicKey, createdAt: d.createdAt || null })),
        passkeys: (u.passkeys || []).map((p) => ({ id: p.id, name: p.name || null, createdAt: p.createdAt || null })),
        suspended: u.suspended ? { at: u.suspended.at, reason: u.suspended.reason } : null,
      },
      consent: u.consent || null,
      chats,
      statuses: own('statuses', 'owner').map((s) => ({ id: s.id, type: s.type, text: s.text || null, caption: s.caption || null, ts: s.ts, expiresAt: s.expiresAt })),
      channels: {
        owned: own('channels', 'owner').map((c) => ({ id: c.id, handle: c.handle, name: c.name, description: c.description, posts: (this.data.channelPosts[c.id] || []).map((p) => ({ id: p.id, text: p.text, ts: p.ts })) })),
        following: Object.values(this.data.channels).filter((c) => c.followers[username] && c.owner !== username).map((c) => ({ id: c.id, handle: c.handle, name: c.name })),
      },
      profileViewers: Object.entries(u.profileViews || {}).map(([viewer, ts]) => ({ viewer, lastViewedAt: ts })),
      reportsMade: this.data.reports.filter((r) => r.reporter === username).map((r) => ({ channelId: r.channelId, reason: r.reason, ts: r.ts })),
      developer: {
        apiKeys: own('apiKeys', 'owner').map((k) => ({ id: k.id, name: k.name, preview: k.preview, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
        webhooks: own('webhooks', 'owner').map((w) => ({ id: w.id, url: w.url, events: w.events, active: w.active, createdAt: w.createdAt })),
      },
    };
  }

  /**
   * Step 1 of deleting an account, effective at once: the account is marked permanently disabled, login is refused, every
   * session, API key and webhook is revoked, and other people see "Deleted account". The mobile number and email are
   * released straight away so the person can register again (a brand-new account). The chats, media and personal data
   * are erased by `eraseAccount` within 24 hours.
   */
  requestAccountDeletion(username, { delayMs = 0 } = {}) {
    const u = this.data.users[username];
    if (!u || u.deletedAt) throw new Error('No such account');
    if (u.deletion) return u.deletion;
    const now = Date.now();
    u.deletion = { requestedAt: now, eraseAt: now + delayMs };
    u.status = 'permanently_disabled';
    delete u.phone;
    delete u.email;
    this._contactIdx = null;
    for (const [token, name] of this.sessions) if (name === username) this.sessions.delete(token);
    for (const [id, k] of Object.entries(this.data.apiKeys)) if (k.owner === username) delete this.data.apiKeys[id];
    for (const [id, w] of Object.entries(this.data.webhooks)) if (w.owner === username) delete this.data.webhooks[id];
    this._save();
    return u.deletion;
  }

  /** Is this account closed (deletion requested, or already erased)? */
  isClosed(username) {
    const u = this.data.users[username];
    return !!(u && (u.deletion || u.deletedAt));
  }

  /** Accounts whose deletion was requested and whose data is due to be erased now. */
  deletionsDue(now = Date.now()) {
    return Object.values(this.data.users).filter((u) => u.deletion && !u.deletedAt && u.deletion.eraseAt <= now).map((u) => u.username);
  }

  /**
   * Step 2: erase the chats, media and personal data of a disabled account. The profile, contact details, keys, sessions,
   * statuses (and their photos), channels, products (and their pictures), developer access and settings are removed; the
   * content of the person's messages (text and voice notes) is erased; they leave their groups. What stays is a basic
   * record marked permanently disabled: username (so other people's chats stay intact and nobody can take it over),
   * registration date, when it was disabled, the record of what they accepted, and any subscription record.
   */
  eraseAccount(username) {
    const u = this.data.users[username];
    if (!u || u.deletedAt) throw new Error('No such account');
    const now = Date.now();
    for (const [token, name] of this.sessions) if (name === username) this.sessions.delete(token);
    for (const [id, k] of Object.entries(this.data.apiKeys)) if (k.owner === username) delete this.data.apiKeys[id];
    for (const [id, w] of Object.entries(this.data.webhooks)) if (w.owner === username) delete this.data.webhooks[id];

    for (const s of Object.values(this.data.statuses)) {
      if (s.owner === username) this._removeStatus(s);
      else if (s.views?.[username]) delete s.views[username];
    }

    for (const [id, ch] of Object.entries(this.data.channels)) {
      if (ch.owner === username) {
        delete this.data.channels[id];
        delete this.data.channelPosts[id];
        this.data.reports = this.data.reports.filter((r) => r.channelId !== id);
        continue;
      }
      delete ch.followers[username];
      ch.admins = (ch.admins || []).filter((a) => a !== username);
      const posts = this.data.channelPosts[id];
      if (posts?.some((p) => p.by === username)) {
        this.data.channelPosts[id] = posts.filter((p) => p.by !== username);
      }
    }
    this.data.reports = this.data.reports.filter((r) => r.reporter !== username);

    for (const conv of [...this._convsOf(username)]) {
      const list = this.data.messages[conv.id] || [];
      for (const m of list) {
        if (m.from === username && m.type !== 'call' && m.type !== 'system') {
          if (m.voice) this.deleteMedia(m.voice.mediaId);
          m.text = '';
          m.deleted = true;
          delete m.voice;
          delete m.e2ee;
          delete m.masked;
          delete m.starredBy;
          this._touchMsg(conv.id, m);
        }
      }
      if (conv.type === 'group') {
        conv.members = conv.members.filter((m) => m !== username);
        conv.admins = (conv.admins || []).filter((a) => a !== username);
        if (conv.members.length < 2) {
          for (const m of list) if (m.voice) this.deleteMedia(m.voice.mediaId);
          delete this.data.conversations[conv.id];
          delete this.data.messages[conv.id];
        } else if (conv.owner === username) {
          conv.owner = conv.admins[0] || conv.members[0];
          if (!conv.admins.includes(conv.owner)) conv.admins.push(conv.owner);
        }
      }
    }
    this._convIdx = null;

    for (const other of Object.values(this.data.users)) {
      if (other.username === username) continue;
      if (other.blocked?.includes(username)) other.blocked = other.blocked.filter((b) => b !== username);
      if (other.profileViews?.[username]) delete other.profileViews[username];
    }
    for (const [id, meta] of Object.entries(this.data.media)) if (meta.publicBy === username) this.deleteMedia(id);

    // What stays is a basic record that the account existed, marked permanently disabled: no chats, media or personal data.
    this.data.users[username] = {
      username,
      displayName: 'Deleted account',
      about: '',
      lastSeen: null,
      createdAt: u.createdAt,
      status: 'permanently_disabled',
      disabledAt: u.deletion?.requestedAt || now,
      deletedAt: now,
      ...(u.consent ? { consent: u.consent } : {}),
      ...(u.subscription ? { subscription: u.subscription } : {}),
      ...(u.verifiedAt ? { verifiedAt: u.verifiedAt } : {}),
    };
    this._contactIdx = null;
    this._save();
  }

  // ---------- platform settings, feature switches (administrators) ----------

  /** Current settings (defaults filled in). Treat as read-only. */
  getSettings() {
    if (!this.settingsCache) {
      const saved = this.data.settings || {};
      this.settingsCache = {
        ...DEFAULT_SETTINGS,
        ...saved,
        features: { ...DEFAULT_SETTINGS.features, ...(saved.features || {}) },
        limits: { ...DEFAULT_SETTINGS.limits, ...(saved.limits || {}) },
        prices: { ...(saved.prices || {}) },
        maintenance: { ...DEFAULT_SETTINGS.maintenance, ...(saved.maintenance || {}) },
        legal: { ...DEFAULT_SETTINGS.legal, ...(saved.legal || {}) },
      };
    }
    return this.settingsCache;
  }

  featureOn(id) {
    return this.getSettings().features[id] !== false;
  }

  /** Apply an administrator's settings change. Returns { settings, changes }. */
  updateSettings(patch) {
    const result = applySettings(this.getSettings(), patch);
    this.data.settings = result.settings;
    this.settingsCache = null;
    this._save();
    return { settings: this.getSettings(), changes: result.changes };
  }

  // ---------- administrators (separate accounts from users) ----------

  /** Create an administrator, or replace their password/role. */
  upsertAdmin(username, password, role = 'support') {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw Object.assign(new Error('Admin username must be 3-30 characters: letters, numbers, "_", "." or "-"'), { status: 400 });
    if (String(password || '').length < 10) throw Object.assign(new Error('Admin password must be at least 10 characters'), { status: 400 });
    if (!['super', 'support'].includes(role)) throw Object.assign(new Error('role must be "super" or "support"'), { status: 400 });
    const salt = crypto.randomBytes(16).toString('hex');
    const prev = this.data.admins[username];
    this.data.admins[username] = { username, role, salt, hash: Store._hash(String(password), salt), createdAt: prev?.createdAt || Date.now() };
    this._save();
    return { username, role };
  }

  verifyAdmin(username, password) {
    const a = this.data.admins[String(username || '').trim().toLowerCase()];
    // Hash anyway so a missing admin takes as long as a wrong password.
    const hash = Store._hash(String(password || ''), a?.salt || '0'.repeat(32));
    if (!a || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.hash, 'hex'))) return null;
    return { username: a.username, role: a.role };
  }

  listAdmins() {
    return Object.values(this.data.admins).map(({ username, role, createdAt }) => ({ username, role, createdAt }));
  }

  removeAdmin(username) {
    if (!this.data.admins[username]) throw Object.assign(new Error('Admin not found'), { status: 404 });
    delete this.data.admins[username];
    this._save();
  }

  /** Every administrator action is written here (newest last, last 2000 kept). */
  audit(admin, action, target, detail) {
    this.data.audit.push({ ts: Date.now(), admin, action, target: target || null, detail: detail || null });
    if (this.data.audit.length > 2000) this.data.audit.splice(0, this.data.audit.length - 2000);
    this._save();
  }

  // ---------- administration of users ----------

  suspendUser(username, reason, by) {
    const u = this.data.users[username];
    if (!u) throw Object.assign(new Error('User not found'), { status: 404 });
    u.suspended = { at: Date.now(), reason: String(reason || '').trim().slice(0, 200), by };
    for (const [t, name] of this.sessions) if (name === username) this.sessions.delete(t);
    this._save();
  }

  unsuspendUser(username) {
    const u = this.data.users[username];
    if (!u) throw Object.assign(new Error('User not found'), { status: 404 });
    delete u.suspended;
    this._save();
  }

  /** Give or take away the Verified badge by hand (an administrator's decision). */
  setVerifiedByAdmin(username, verified) {
    const u = this.data.users[username];
    if (!u) throw Object.assign(new Error('User not found'), { status: 404 });
    if (verified) u.verifiedAt = Date.now();
    else delete u.verifiedAt;
    this._save();
  }

  /** Premium until `expiresAt` (grant), or ended now (revoke with null). */
  setPremiumByAdmin(username, expiresAt) {
    const u = this.data.users[username];
    if (!u) throw Object.assign(new Error('User not found'), { status: 404 });
    if (expiresAt) this.activateSubscription(username, { plan: 'granted', expiresAt });
    else if (u.subscription) {
      u.subscription.expiresAt = Date.now();
      this._save();
    }
  }

  /** One page of users for the dashboard. */
  listUsers({ q = '', filter = '', page = 1, pageSize = 25 } = {}) {
    q = String(q).trim().toLowerCase();
    let list = Object.values(this.data.users).filter((u) => (filter === 'deleted' ? (u.deletedAt || u.deletion) : !(u.deletedAt || u.deletion))).filter((u) => !q
      || u.username.includes(q) || u.displayName.toLowerCase().includes(q) || (u.phone || '').includes(q) || (u.email || '').includes(q));
    if (filter === 'premium') list = list.filter((u) => this.isPremium(u.username));
    else if (filter === 'verified') list = list.filter((u) => u.verifiedAt);
    else if (filter === 'business') list = list.filter((u) => u.business);
    else if (filter === 'suspended') list = list.filter((u) => u.suspended);
    list.sort((a, b) => (b.createdAt || b.deletedAt || 0) - (a.createdAt || a.deletedAt || 0));
    const total = list.length;
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 25));
    page = Math.max(1, Number(page) || 1);
    return { total, page, pageSize, users: list.slice((page - 1) * pageSize, page * pageSize).map((u) => this.adminUserView(u.username)) };
  }

  /** What administrators see of an account (contact details included; never password hashes or keys). */
  adminUserView(username) {
    const u = this.data.users[username];
    if (!u) return null;
    return {
      username: u.username,
      displayName: u.displayName,
      phone: u.phone || null,
      email: u.email || null,
      createdAt: u.createdAt,
      lastSeen: u.lastSeen || null,
      verified: !!u.verifiedAt,
      premium: this.isPremium(username),
      premiumUntil: u.subscription?.expiresAt || null,
      plan: u.subscription?.plan || null,
      business: u.business ? u.business.category : null,
      suspended: u.suspended ? { at: u.suspended.at, reason: u.suspended.reason, by: u.suspended.by } : null,
      status: u.status || (u.suspended ? 'suspended' : 'active'),
      disabledAt: u.disabledAt || u.deletion?.requestedAt || null,
      deleted: u.deletedAt || null,
      deletion: u.deletion ? { requestedAt: u.deletion.requestedAt, eraseAt: u.deletion.eraseAt } : null,
      consent: u.consent ? { version: u.consent.version, at: u.consent.at, optional: Object.fromEntries(Object.entries(u.consent.optional || {}).map(([k, v]) => [k, v.granted])) } : null,
      chats: this._convsOf(username).length,
      channelsOwned: Object.values(this.data.channels).filter((c) => c.owner === username).length,
      apiKeys: Object.values(this.data.apiKeys).filter((k) => k.owner === username).length,
      devices: (u.devices || []).length,
    };
  }

  /** Numbers for the overview page. */
  stats(onlineCount = 0) {
    const day = 86400000;
    const now = Date.now();
    const everyone = Object.values(this.data.users);
    const users = everyone.filter((u) => !u.deletedAt && !u.deletion);
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const bucket = (ts, days) => Math.floor((startOfToday - new Date(new Date(ts).setHours(0, 0, 0, 0)).getTime()) / day) < days ? Math.floor((startOfToday - new Date(new Date(ts).setHours(0, 0, 0, 0)).getTime()) / day) : -1;
    const days = 14;
    const signups = Array(days).fill(0);
    for (const u of users) {
      const b = bucket(u.createdAt, days);
      if (b >= 0) signups[days - 1 - b] += 1;
    }
    const messages = Array(days).fill(0);
    let totalMessages = 0;
    for (const list of Object.values(this.data.messages)) {
      for (const m of list) {
        if (m.type === 'system') continue;
        totalMessages += 1;
        const b = bucket(m.ts, days);
        if (b >= 0) messages[days - 1 - b] += 1;
      }
    }
    return {
      users: {
        total: users.length,
        deleted: everyone.filter((u) => u.deletedAt).length,
        deleting: everyone.filter((u) => u.deletion && !u.deletedAt).length,
        deletionOverdue: everyone.filter((u) => u.deletion && !u.deletedAt && Date.now() - u.deletion.requestedAt > 24 * 3600 * 1000).length,
        online: onlineCount,
        newToday: users.filter((u) => u.createdAt >= startOfToday).length,
        new7d: users.filter((u) => u.createdAt >= now - 7 * day).length,
        verified: users.filter((u) => u.verifiedAt).length,
        premium: users.filter((u) => this.isPremium(u.username)).length,
        business: users.filter((u) => u.business).length,
        suspended: users.filter((u) => u.suspended).length,
      },
      content: {
        chats: Object.keys(this.data.conversations).length,
        groups: Object.values(this.data.conversations).filter((c) => c.type === 'group').length,
        messages: totalMessages,
        statuses: Object.keys(this.data.statuses).length,
        channels: Object.keys(this.data.channels).length,
        channelPosts: Object.values(this.data.channelPosts).reduce((n, l) => n + l.length, 0),
        products: users.reduce((n, u) => n + (u.catalogue?.products.length || 0), 0),
        mediaFiles: Object.keys(this.data.media).length,
        mediaBytes: Object.values(this.data.media).reduce((n, m) => n + (m.size || 0), 0),
        apiKeys: Object.keys(this.data.apiKeys).length,
        webhooks: Object.keys(this.data.webhooks).length,
        openReports: this.data.reports.length,
      },
      series: { days, signups, messages, from: startOfToday - (days - 1) * day },
    };
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
      about: 'Hey there! I am using VartiQ.',
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
      about: business ? 'Business account' : 'Hey there! I am using VartiQ.',
      phone,
      ...(email ? { email } : {}),
      lastSeen: now,
      createdAt: now,
    };
    this._contactIdx = null;
    if (business) {
      try {
        this.setBusiness(username, business);
      } catch (err) {
        delete this.data.users[username];
        this._contactIdx = null;
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

  /** Lookup tables for phone and email, so signing in doesn't scan every user. Dropped whenever a user or contact changes. */
  _contacts() {
    if (!this._contactIdx) {
      const idx = { phone: new Map(), email: new Map() };
      for (const u of Object.values(this.data.users)) {
        if (u.phone && !idx.phone.has(u.phone)) idx.phone.set(u.phone, u.username);
        if (u.email && !idx.email.has(u.email)) idx.email.set(u.email, u.username);
      }
      this._contactIdx = idx;
    }
    return this._contactIdx;
  }

  findByPhone(phone) {
    return this._contacts().phone.get(phone) || null;
  }

  findByEmail(email) {
    return this._contacts().email.get(email) || null;
  }

  /** Set a verified mobile number (`channel` "sms") or email ("email"). A business's contact email follows it. */
  setContact(username, channel, value) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    const field = channel === 'sms' ? 'phone' : 'email';
    const owner = field === 'phone' ? this.findByPhone(value) : this.findByEmail(value);
    if (owner && owner !== username) throw new Error(`This ${field === 'phone' ? 'mobile number' : 'email'} is already registered`);
    u[field] = value;
    this._contactIdx = null;
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
    if (this.isClosed(username)) throw Object.assign(new Error('This account is being deleted and can no longer be used. Its data is erased within 24 hours.'), { status: 403, code: 'account_deletion_pending' });
    const sus = this.data.users[username]?.suspended;
    if (sus) throw Object.assign(new Error(`This account is suspended${sus.reason ? `: ${sus.reason}` : ''}`), { status: 403, code: 'account_suspended' });
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, username);
    return { token, user: this.publicUser(username) };
  }

  /** A login session token or an API key, as sent in `Authorization: Bearer …`. */
  userForToken(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (session) return this.data.users[session]?.suspended ? null : session;
    if (!String(token).startsWith(Store.API_KEY_PREFIX)) return null;
    const hash = Store._keyHash(token);
    const key = Object.values(this.data.apiKeys).find((k) => k.hash === hash);
    if (!key || !this.data.users[key.owner] || this.data.users[key.owner].suspended) return null;
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
    if (u.deletion || u.deletedAt) return { username: u.username, displayName: 'Deleted account', about: '', lastSeen: null, deleted: true };
    const out = { username: u.username, displayName: u.displayName, about: u.about, lastSeen: u.lastSeen };
    if (u.business) out.business = { ...Store._publicBusiness(u.business), productCount: (u.catalogue?.products || []).length };
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

  // ---------- appearance preferences ----------

  prefsOf(username) {
    return { ...(this.data.users[username]?.prefs || {}) };
  }

  setPrefs(username, patch) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    u.prefs = { ...(u.prefs || {}), ...patch };
    this._save();
    return u.prefs;
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
    // The catalogue belongs to the business profile: it goes too (with its images).
    for (const p of u.catalogue?.products || []) if (p.image) this.deleteMedia(p.image);
    delete u.catalogue;
    this._save();
  }

  // ---------- public channels ----------
  //
  // A channel is a one-to-many feed: its owner and admins post, anyone can read it and follow
  // it. Channel posts are public, so they are NOT end-to-end encrypted.

  getChannel(idOrHandle) {
    const key = String(idOrHandle || '').replace(/^@/, '').toLowerCase();
    return this.data.channels[key] || Object.values(this.data.channels).find((c) => c.handle === key) || null;
  }

  static channelRole(ch, username) {
    if (ch.owner === username) return 'owner';
    return ch.admins.includes(username) ? 'admin' : null;
  }

  /** What a person sees of a channel. `unread` only for followers. */
  channelView(ch, viewer) {
    const posts = this.data.channelPosts[ch.id] || [];
    const last = posts[posts.length - 1];
    const f = ch.followers[viewer];
    return {
      id: ch.id,
      handle: ch.handle,
      name: ch.name,
      description: ch.description,
      ...(ch.category ? { category: ch.category } : {}),
      owner: ch.owner,
      admins: ch.admins,
      followers: Object.keys(ch.followers).length,
      following: !!f,
      role: Store.channelRole(ch, viewer),
      createdAt: ch.createdAt,
      lastPost: last ? { text: last.text.slice(0, 140), ts: last.ts } : null,
      ...(f ? { unread: posts.filter((p) => p.ts > f.lastRead && p.by !== viewer).length } : {}),
    };
  }

  createChannel(owner, { handle, name, description, category }) {
    if (!this.data.users[owner]) throw new Error('No such user');
    handle = String(handle || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(handle)) throw new Error('Handle must be 3-30 characters: letters, numbers or "_"');
    if (this.getChannel(handle)) throw new Error('That channel handle is already taken');
    const mine = Object.values(this.data.channels).filter((c) => c.owner === owner).length;
    const maxChannels = this.getSettings().limits.channelsPerOwner;
    if (mine >= maxChannels) throw new Error(`You can have at most ${maxChannels} channels`);
    const ch = {
      id: crypto.randomBytes(5).toString('hex'),
      handle,
      ...Store._checkChannel({ name, description, category }),
      owner,
      admins: [],
      followers: {},
      createdAt: Date.now(),
    };
    ch.followers[owner] = { since: ch.createdAt, lastRead: ch.createdAt };
    this.data.channels[ch.id] = ch;
    this.data.channelPosts[ch.id] = [];
    this._save();
    return ch;
  }

  static _checkChannel(input, base = {}) {
    const str = (v, max, field, required = false) => {
      const t = String(v ?? '').trim();
      if (required && !t) throw new Error(`${field} is required`);
      if (t.length > max) throw new Error(`${field} is too long (max ${max} characters)`);
      return t;
    };
    const out = { ...base };
    if (input.name !== undefined || !base.name) out.name = str(input.name, 60, 'name', true);
    if (input.description !== undefined || base.description === undefined) out.description = str(input.description, 300, 'description');
    if (input.category !== undefined) {
      const c = str(input.category, 30, 'category');
      if (c) out.category = c;
      else delete out.category;
    }
    return out;
  }

  updateChannel(by, id, input) {
    const ch = this.data.channels[id];
    if (!ch) throw new Error('Channel not found');
    if (!Store.channelRole(ch, by)) throw Object.assign(new Error('Only the channel owner or admins can change it'), { status: 403 });
    Object.assign(ch, Store._checkChannel(input, ch));
    this._save();
    return ch;
  }

  deleteChannel(by, id) {
    const ch = this.data.channels[id];
    if (!ch) throw new Error('Channel not found');
    if (ch.owner !== by) throw Object.assign(new Error('Only the owner can delete a channel'), { status: 403 });
    delete this.data.channels[id];
    delete this.data.channelPosts[id];
    this.data.reports = this.data.reports.filter((r) => r.channelId !== id);
    this._save();
    return Object.keys(ch.followers);
  }

  followChannel(username, id) {
    const ch = this.data.channels[id];
    if (!ch) throw new Error('Channel not found');
    if (!ch.followers[username]) ch.followers[username] = { since: Date.now(), lastRead: Date.now() };
    this._save();
    return ch;
  }

  unfollowChannel(username, id) {
    const ch = this.data.channels[id];
    if (!ch) throw new Error('Channel not found');
    if (ch.owner === username) throw Object.assign(new Error('The owner cannot unfollow their own channel. Delete it instead.'), { status: 403 });
    delete ch.followers[username];
    ch.admins = ch.admins.filter((a) => a !== username);
    this._save();
    return ch;
  }

  setChannelAdmin(owner, id, username, isAdmin) {
    const ch = this.data.channels[id];
    if (!ch) throw new Error('Channel not found');
    if (ch.owner !== owner) throw Object.assign(new Error('Only the owner can manage admins'), { status: 403 });
    if (!this.data.users[username]) throw new Error('User not found');
    if (isAdmin) {
      if (username === owner) throw new Error('The owner is already in charge');
      if (!ch.admins.includes(username)) {
        if (ch.admins.length >= Store.CHANNEL_ADMINS_MAX) throw new Error(`A channel can have at most ${Store.CHANNEL_ADMINS_MAX} admins`);
        ch.admins.push(username);
        if (!ch.followers[username]) ch.followers[username] = { since: Date.now(), lastRead: Date.now() };
      }
    } else {
      ch.admins = ch.admins.filter((a) => a !== username);
    }
    this._save();
    return ch;
  }

  postToChannel(by, id, text) {
    const ch = this.data.channels[id];
    if (!ch) throw new Error('Channel not found');
    if (!Store.channelRole(ch, by)) throw Object.assign(new Error('Only the channel owner or admins can post'), { status: 403 });
    text = String(text ?? '').trim();
    if (!text) throw new Error('Post is empty');
    if (text.length > 4000) throw new Error('Post is too long (max 4000 characters)');
    const posts = this.data.channelPosts[id];
    const post = { id: crypto.randomBytes(6).toString('hex'), channelId: id, text, by, ts: Date.now() };
    posts.push(post);
    if (posts.length > Store.CHANNEL_POSTS_MAX) posts.splice(0, posts.length - Store.CHANNEL_POSTS_MAX);
    this._touchList('channelPosts', id);
    if (ch.followers[by]) ch.followers[by].lastRead = post.ts;
    this._save();
    return post;
  }

  deleteChannelPost(by, id, postId) {
    const ch = this.data.channels[id];
    if (!ch) throw new Error('Channel not found');
    if (!Store.channelRole(ch, by)) throw Object.assign(new Error('Only the channel owner or admins can delete posts'), { status: 403 });
    const posts = this.data.channelPosts[id];
    const i = posts.findIndex((p) => p.id === postId);
    if (i < 0) throw new Error('Post not found');
    posts.splice(i, 1);
    this._touchList('channelPosts', id);
    this._save();
  }

  /** Newest `limit` posts (before a timestamp for older pages), oldest first. */
  channelPostsPage(id, { before, limit = 30 } = {}) {
    const all = (this.data.channelPosts[id] || []).filter((p) => !before || p.ts < before);
    const page = all.slice(-limit - 1);
    const hasMore = page.length > limit;
    const posts = hasMore ? page.slice(1) : page;
    return { posts, hasMore, nextBefore: hasMore ? posts[0].ts : null };
  }

  markChannelRead(username, id) {
    const f = this.data.channels[id]?.followers[username];
    if (f) {
      f.lastRead = Date.now();
      this._save();
    }
  }

  /** Channels matching `q` (name, handle, description, category), biggest first; no `q` = the most followed. */
  searchChannels(q, limit = 30) {
    q = String(q || '').trim().toLowerCase().replace(/^@/, '');
    return Object.values(this.data.channels)
      .filter((c) => !q || c.handle.includes(q) || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || (c.category || '').toLowerCase().includes(q))
      .sort((a, b) => Object.keys(b.followers).length - Object.keys(a.followers).length || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  channelsOf(username) {
    return Object.values(this.data.channels).filter((c) => c.followers[username]);
  }

  /** One report per person per channel. They are kept for whoever runs the service to review. */
  reportChannel(reporter, id, reason) {
    const ch = this.data.channels[id];
    if (!ch) throw new Error('Channel not found');
    if (ch.owner === reporter) throw new Error('You cannot report your own channel');
    reason = String(reason ?? '').trim().slice(0, 200);
    if (!reason) throw new Error('Say what is wrong');
    const existing = this.data.reports.find((r) => r.channelId === id && r.reporter === reporter);
    if (existing) Object.assign(existing, { reason, ts: Date.now() });
    else this.data.reports.push({ channelId: id, reporter, reason, ts: Date.now() });
    this._save();
  }

  // ---------- product catalogue (business accounts) ----------

  /** The catalogue anyone can see on a business profile, or null for a non-business account. */
  catalogueOf(username) {
    const u = this.data.users[username];
    if (!u?.business) return null;
    const c = u.catalogue || { currency: 'INR', products: [] };
    return { currency: c.currency, products: c.products.map((p) => ({ ...p })) };
  }

  _catalogueFor(username) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    if (!u.business) throw Object.assign(new Error('Only business accounts have a catalogue'), { status: 403 });
    u.catalogue = u.catalogue || { currency: 'INR', products: [] };
    return u.catalogue;
  }

  static _checkProduct(input, base = {}) {
    const str = (v, max, field, required = false) => {
      const t = String(v ?? '').trim();
      if (required && !t) throw new Error(`${field} is required`);
      if (t.length > max) throw new Error(`${field} is too long (max ${max} characters)`);
      return t;
    };
    const has = (k) => input[k] !== undefined;
    const out = { ...base };
    if (has('name') || !base.name) out.name = str(input.name, 80, 'name', true);
    if (has('description')) out.description = str(input.description, 1000, 'description');
    if (has('category')) out.category = str(input.category, 40, 'category');
    if (has('unit')) out.unit = str(input.unit, 20, 'unit');
    if (has('sku')) out.sku = str(input.sku, 40, 'sku');
    if (has('price')) {
      if (input.price === null || input.price === '') out.price = null; // "price on request"
      else {
        const n = Number(input.price);
        if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new Error('price must be a number from 0 to 1,000,000,000');
        if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new Error('price must have no more than 2 decimals');
        out.price = Math.round(n * 100) / 100;
      }
    }
    if (has('link')) {
      let link = str(input.link, 300, 'link');
      if (link) {
        if (!/^https?:\/\//i.test(link)) link = `https://${link}`;
        try {
          if (!new URL(link).hostname.includes('.')) throw new Error();
        } catch {
          throw new Error('link is not a valid URL');
        }
      }
      out.link = link;
    }
    if (has('available')) out.available = !!input.available;
    out.price = out.price === undefined ? null : out.price;
    out.available = out.available === undefined ? true : out.available;
    for (const k of ['description', 'category', 'unit', 'sku', 'link']) if (!out[k]) delete out[k];
    return out;
  }

  addProduct(username, input) {
    const c = this._catalogueFor(username);
    const maxProducts = this.getSettings().limits.catalogueMax;
    if (c.products.length >= maxProducts) throw new Error(`A catalogue can have at most ${maxProducts} products`);
    const now = Date.now();
    const product = { id: crypto.randomBytes(6).toString('hex'), ...Store._checkProduct(input), createdAt: now, updatedAt: now };
    c.products.push(product);
    this._save();
    return { ...product };
  }

  updateProduct(username, id, input) {
    const c = this._catalogueFor(username);
    const i = c.products.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('Product not found');
    const old = c.products[i];
    // Optional text fields can be cleared by sending an empty value.
    c.products[i] = { ...Store._checkProduct(input, old), id, image: old.image, createdAt: old.createdAt, updatedAt: Date.now() };
    for (const k of ['description', 'category', 'unit', 'sku', 'link']) if (input[k] !== undefined && !String(input[k]).trim()) delete c.products[i][k];
    if (!c.products[i].image) delete c.products[i].image;
    this._save();
    return { ...c.products[i] };
  }

  deleteProduct(username, id) {
    const c = this._catalogueFor(username);
    const p = c.products.find((x) => x.id === id);
    if (!p) throw new Error('Product not found');
    if (p.image) this.deleteMedia(p.image);
    c.products = c.products.filter((x) => x.id !== id);
    this._save();
  }

  /** Attach (or remove, with null) a product's picture. */
  setProductImage(username, id, mediaId) {
    const c = this._catalogueFor(username);
    const p = c.products.find((x) => x.id === id);
    if (!p) throw new Error('Product not found');
    if (p.image) this.deleteMedia(p.image);
    if (mediaId) p.image = mediaId;
    else delete p.image;
    p.updatedAt = Date.now();
    this._save();
    return { ...p };
  }

  setCatalogueCurrency(username, currency) {
    const c = this._catalogueFor(username);
    const code = String(currency || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new Error('currency must be a 3-letter code such as INR or USD');
    c.currency = code;
    this._save();
    return code;
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
    const list = this.data.messages[convId];
    list.push(msg);
    this._touchList('messages', convId);
    this._save();
    return list[list.length - 1]; // the tracked copy (the same object when nothing is tracked)
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
      .filter((u) => u.username !== exclude && !u.deletedAt && !u.deletion)
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
    if (!this.data.users[b] || this.isClosed(b)) throw new Error('User not found');
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
      this._indexConv(this.data.conversations[id]);
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
    this._indexConv(this.data.conversations[id]);
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

  /** Every conversation `username` is in. Members never change after a chat is made, so the table is only added to. */
  _convsOf(username) {
    if (!this._convIdx) {
      this._convIdx = new Map();
      for (const c of Object.values(this.data.conversations)) this._indexConv(c);
    }
    return this._convIdx.get(username) || [];
  }

  _indexConv(conv) {
    if (!this._convIdx) return;
    for (const m of conv.members) {
      if (!this._convIdx.has(m)) this._convIdx.set(m, []);
      this._convIdx.get(m).push(conv);
    }
  }

  /** Everyone `username` shares a chat with. */
  peersOf(username) {
    const peers = new Set();
    for (const c of this._convsOf(username)) for (const m of c.members) if (m !== username) peers.add(m);
    return peers;
  }

  conversationsFor(username) {
    return this._convsOf(username)
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
    // Scope: a chat (voice message), a status, or `{ publicBy }` (catalogue images, visible to every signed-in person).
    const where = typeof scope === 'string' ? { convId: scope } : scope.publicBy ? { publicBy: scope.publicBy } : { statusId: scope.statusId };
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
    const allowed = meta.publicBy
      ? true
      : meta.statusId
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
      if (this.isClosed(peer)) throw new Error('This account was deleted. You can no longer send messages to it.');
      if (this.hasBlocked(from, peer)) {
        throw new Error(`Unblock ${this.publicUser(peer)?.displayName || peer} to send a message`);
      }
      // The sender isn't told; the message just never gets delivered.
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
    const list = this.data.messages[convId];
    list.push(msg);
    this._touchList('messages', convId);
    this._save();
    return list[list.length - 1]; // the tracked copy (the same object when nothing is tracked)
  }

  /**
   * Record a voice/video call in the conversation history.
   * `call` is `{ kind: 'audio'|'video', status: 'completed'|'missed'|'declined', duration, group }`.
   * `joined`: everyone who took part; for them the entry is not unread.
   */
  addCallMessage(convId, from, { kind, status, duration = 0, group = false, recorded = false }, joined = []) {
    const conv = this.getConversation(convId);
    if (!conv || !conv.members.includes(from)) throw new Error('Not a member of this chat');
    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      convId,
      from,
      type: 'call',
      text: '',
      call: { kind, status, duration, ...(recorded ? { recorded: true } : {}), ...(group ? { group: true, joined: [...joined] } : {}) },
      ts: Date.now(),
      deliveredTo: [],
      // Only calls someone missed should show up as unread for them.
      readBy: conv.members.filter((m) => m !== from && (joined.includes(m) || (!group && status === 'completed'))),
    };
    const list = this.data.messages[convId];
    list.push(msg);
    this._touchList('messages', convId);
    this._save();
    return list[list.length - 1]; // the tracked copy (the same object when nothing is tracked)
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
    this._touchMsg(found.convId, m);
    this._save();
    return { convId: found.convId, message: this.viewFor(m, username) };
  }

  // ---------- status updates (disappear after statusTtlMs) ----------

  /** Everyone `username` has a one-to-one chat with: the audience for their status updates. */
  directPeers(username) {
    const peers = new Set();
    for (const c of this._convsOf(username)) {
      if (c.type === 'direct') c.members.forEach((m) => m !== username && peers.add(m));
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

  /** One message was delivered to `username` (it was online when the message arrived). */
  addDelivered(msg, username) {
    if (msg.deliveredTo.includes(username)) return;
    msg.deliveredTo.push(username);
    this._touchMsg(msg.convId, msg);
    this._save();
  }

  /** Mark messages delivered to `username`. Returns messages whose status changed. */
  markDelivered(convId, username) {
    const changed = [];
    for (const m of this.data.messages[convId] || []) {
      if (m.from !== username && !m.deliveredTo.includes(username) && Store.visibleTo(m, username)) {
        m.deliveredTo.push(username);
        this._touchMsg(convId, m);
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
      if (touched) {
        this._touchMsg(convId, m);
        changed.push(m);
      }
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
      this._touchMsg(convId, m);
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
Store.CHANNELS_PER_OWNER = 10;
Store.CHANNEL_ADMINS_MAX = 5;
Store.CHANNEL_POSTS_MAX = 5000;
Store.CATALOGUE_MAX = 100;
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
