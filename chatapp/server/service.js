'use strict';

const { Store } = require('./store');
const { normalisePhone, normaliseEmail } = require('./otp');
const { createWebAuthn } = require('./webauthn');
const { FEATURES, versionLess } = require('./features');
const appearance = require('./appearance');
const BusinessHours = require('../public/business-hours.js');

/** An error with an HTTP status and a stable machine-readable code (used by the REST API). */
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const VOICE_MAX_BYTES = 3 * 1024 * 1024;
const VOICE_MAX_SECONDS = 5 * 60;
const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const PRODUCT_IMAGE_MAX_BYTES = 1024 * 1024;
const PAGE_MAX = 100;

/**
 * Everything a signed-in user can do, shared by the Socket.IO handlers (the web app)
 * and the REST API (other platforms), so both behave identically and every change is
 * pushed live to connected clients and webhooks through `notify`.
 *
 * Each action is `(me, payload) => result` and throws on bad input.
 */
function createService({ store, io, isOnline, webhooks, iceServers, otp, kyc, payments, translator }) {
  const userRoom = (u) => `user:${u}`;

  // ---------- chat lock ----------
  //
  // A user can lock chats with a secret code. A locked chat's messages are only
  // sent to a device after the code is entered in that "app session": one page
  // load of the web app (Socket.IO auth.appSession / X-App-Session header), or
  // one REST credential. A new login or a reload means locked again.

  //
  // Hidden chats go one step further: they are left out of the chat list, and nothing
  // about them (messages, previews, typing) reaches a session until it "reveals" them
  // with the secret code or a fingerprint/face check. Revealing lasts for the app session.

  const unlocked = new Map(); // lockKey -> Set(convId)
  const revealed = new Set(); // lockKeys that opened their hidden chats
  const webauthn = createWebAuthn();
  const attempts = new Map(); // username -> { fails, until }
  const MAX_FAILS = 5;

  /** Identifies one app session of `username`. */
  const lockKeyFor = (username, credential, appSession) =>
    `${username}|${credential || ''}|${appSession ? String(appSession).slice(0, 64) : '-'}`;

  const isRevealed = (lockKey) => !!(lockKey && revealed.has(lockKey));
  const isUnlocked = (me, convId, ctx) => {
    if (store.isChatHidden(me, convId)) return isRevealed(ctx?.lockKey);
    return !store.isChatLocked(me, convId) || !!(ctx?.lockKey && unlocked.get(ctx.lockKey)?.has(convId));
  };
  const hiddenFrom = (me, convId, lockKey) => store.isChatHidden(me, convId) && !isRevealed(lockKey);

  const requireUnlocked = (me, convId, ctx) => {
    if (!isUnlocked(me, convId, ctx)) throw new ApiError(423, 'chat_locked', 'This chat is locked. Unlock it with your secret code.');
  };

  /** What a locked chat's message looks like before it's unlocked: no content. */
  const redactMessage = (m) => ({
    id: m.id,
    convId: m.convId,
    from: m.from,
    ts: m.ts,
    deliveredTo: m.deliveredTo,
    readBy: m.readBy,
    ...(m.clientId ? { clientId: m.clientId } : {}),
    ...(m.deleted ? { deleted: true } : {}),
    locked: true,
  });

  /** A conversation summary for `me`, with the lock state and a redacted preview when locked. */
  const lockView = (me, c, lockKey) => {
    if (store.isChatHidden(me, c.id)) {
      // Closed hidden chats look locked; once revealed they are open (and marked hidden).
      const open = isRevealed(lockKey);
      return { ...c, hidden: true, locked: !open, unlocked: open, lastMessage: open || !c.lastMessage ? c.lastMessage : redactMessage(c.lastMessage) };
    }
    if (!store.isChatLocked(me, c.id)) return { ...c, locked: false };
    const open = !!(lockKey && unlocked.get(lockKey)?.has(c.id));
    return { ...c, locked: true, unlocked: open, lastMessage: open || !c.lastMessage ? c.lastMessage : redactMessage(c.lastMessage) };
  };

  /** The version of an event a device (or webhook, lockKey null) of `username` may receive; null = nothing. */
  const eventFor = (username, event, payload, lockKey) => {
    if (CONV_EVENTS.has(event)) return hiddenFrom(username, payload.convId, lockKey) ? null : payload;
    if (event === 'message:new') {
      const m = payload.message;
      if (hiddenFrom(username, m.convId, lockKey)) return null;
      return isUnlocked(username, m.convId, { lockKey }) ? payload : { message: redactMessage(m) };
    }
    if (event === 'conversation:new' || event === 'conversation:updated') {
      if (hiddenFrom(username, payload.conversation.id, lockKey)) return null;
      return { ...payload, conversation: lockView(username, payload.conversation, lockKey) };
    }
    return payload;
  };
  // Events that only name a chat (no content): dropped for closed hidden chats.
  const CONV_EVENTS = new Set(['typing', 'message:status', 'message:deleted', 'message:expired', 'message:starred']);
  const LOCK_SENSITIVE = new Set(['message:new', 'conversation:new', 'conversation:updated', ...CONV_EVENTS]);

  /**
   * Prove it is you: the secret code, or a fingerprint/face check from an enrolled device
   * (`{ biometric: { id, clientDataJSON, authenticatorData, signature } }`). Both count
   * against the same wrong-attempts limit.
   */
  const verifyProof = (me, proof, what = 'secret code') => {
    const bio = proof?.biometric;
    checkSecret(me, () => {
      if (!bio) return store.verifyLockCode(me, proof?.code);
      const credential = store.passkeysOf(me).find((k) => k.id === bio.id);
      if (!credential) return false;
      try {
        store.setPasskeyCounter(me, credential.id, webauthn.verifyAssertion(me, credential, bio));
        return true;
      } catch (err) {
        if (err instanceof webauthn.WebAuthnError) return false;
        throw err;
      }
    }, bio ? 'fingerprint or face check' : what);
  };

  /** Wrong codes count against the user; after MAX_FAILS they must wait (doubling, up to an hour). */
  const checkSecret = (me, ok, what = 'secret code') => {
    const a = attempts.get(me) || { fails: 0, until: 0 };
    if (a.until > Date.now()) {
      throw new ApiError(429, 'too_many_attempts', `Too many wrong attempts. Try again in ${Math.ceil((a.until - Date.now()) / 1000)} seconds.`);
    }
    if (ok()) {
      attempts.delete(me);
      return;
    }
    a.fails += 1;
    if (a.fails >= MAX_FAILS) a.until = Date.now() + Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (a.fails - MAX_FAILS));
    attempts.set(me, a);
    const left = MAX_FAILS - a.fails;
    throw new ApiError(403, 'wrong_code', `Wrong ${what}${left > 0 ? ` (${left} ${left === 1 ? 'try' : 'tries'} left)` : ''}`);
  };

  // ---------- end-to-end encryption ----------

  const B64U = /^[A-Za-z0-9_-]+$/;
  const b64len = (s, bytes) => typeof s === 'string' && B64U.test(s) && Buffer.from(s, 'base64url').length === bytes;

  /**
   * Check an encrypted message's envelope: well-formed, from one of my devices, and with a
   * key wrap for exactly every device of every member (so nobody is silently left out and
   * nothing is wrapped for a device that no longer exists). A stale device list is a
   * 409 `keys_changed`: the sender re-fetches the keys and encrypts again.
   */
  const checkEnvelope = (me, conv, env, { media = false } = {}) => {
    const bad = (why) => new ApiError(400, 'invalid_envelope', `Invalid encrypted message (${why})`);
    if (!env || typeof env !== 'object' || env.v !== 1) throw bad('version');
    const own = store.devicesOf(me).map((d) => d.id);
    if (!own.includes(env.sd)) throw new ApiError(409, 'keys_changed', 'This device is no longer registered for encryption. Reload and try again.');
    if (!b64len(env.iv, 12) || !b64len(env.eph, 65)) throw bad('iv/eph');
    if (typeof env.ct !== 'string' || !B64U.test(env.ct) || env.ct.length > 64 * 1024) throw bad('ct');
    if (media && !b64len(env.mi, 12)) throw bad('mi');
    if (!env.w || typeof env.w !== 'object') throw bad('w');
    const expected = new Set(conv.members.flatMap((m) => store.devicesOf(m).map((d) => d.id)));
    const given = Object.keys(env.w);
    if (given.length !== expected.size || given.some((id) => !expected.has(id))) {
      throw new ApiError(409, 'keys_changed', "Someone's encryption keys changed. Try sending again.");
    }
    const w = {};
    for (const id of given) {
      const e = env.w[id];
      if (!e || !b64len(e.iv, 12) || !b64len(e.k, 48)) throw bad('wrap');
      w[id] = { iv: e.iv, k: e.k };
    }
    return { v: 1, sd: env.sd, iv: env.iv, ct: env.ct, eph: env.eph, ...(media ? { mi: env.mi } : {}), w };
  };

  /** Tell everyone who shares a chat with `me` (and my own devices) that my device keys changed. */
  const announceDevices = (me) => {
    for (const p of [me, ...peersOf(me)]) io.to(userRoom(p)).emit('e2ee:update', { username: me });
  };

  const channelPostTimes = new Map(); // user -> recent post times (rate limit)
  const channelOrThrow = (id) => {
    const ch = store.getChannel(id);
    if (!ch) throw new ApiError(404, 'not_found', 'Channel not found');
    return ch;
  };

  /** Free accounts: up to 3 locked chats and 1 hidden chat. Past that needs Premium (402). */
  const requireRoom = (me, kind) => {
    if (store.isPremium(me)) return;
    const { freeChatLocks, freeHiddenChats } = store.getSettings().limits;
    const [used, max, noun] = kind === 'lock'
      ? [store.lockedChats(me).length, freeChatLocks, `lock up to ${freeChatLocks} chat${freeChatLocks === 1 ? '' : 's'}`]
      : [store.hiddenChats(me).length, freeHiddenChats, `hide ${freeHiddenChats} chat${freeHiddenChats === 1 ? '' : 's'}`];
    if (used >= max) throw new ApiError(402, 'premium_required', `Free accounts can ${noun}. Upgrade to Premium to ${kind === 'lock' ? 'lock' : 'hide'} more.`);
  };

  const subscriptionView = (me) => {
    const sub = store.subscriptionOf(me);
    const premium = store.isPremium(me);
    return {
      premium,
      plan: premium ? sub.plan : null,
      expiresAt: sub?.expiresAt || null,
      expired: !!sub && !premium,
      perks: ['Unlimited locked and hidden chats', 'Call recording', 'Colour themes', 'Custom app icons and avatar shapes'],
      limits: { free: { chatLocks: store.getSettings().limits.freeChatLocks, hiddenChats: store.getSettings().limits.freeHiddenChats }, premium: 'unlimited' },
      usage: { chatLocks: store.lockedChats(me).length, hiddenChats: store.hiddenChats(me).length },
      plans: payments ? payments.listPlans() : [],
      available: !!payments?.available,
      sandbox: !!payments?.sandbox,
    };
  };

  /** Tell people their Premium ended (called every minute): their badge goes away. */
  let lastSweep = Date.now();
  const expireSubscriptions = () => {
    const now = Date.now();
    for (const u of store.expiredBetween(lastSweep, now)) {
      announceProfile(u);
      io.to(userRoom(u)).emit('subscription:update', subscriptionView(u));
      io.to(userRoom(u)).emit('appearance:update', appearance.effective(store.prefsOf(u), false));
    }
    lastSweep = now;
  };

  const contactDestination = (body) => {
    try {
      if (body.phone) return { channel: 'sms', to: normalisePhone(body.phone) };
      if (body.email) return { channel: 'email', to: normaliseEmail(body.email) };
    } catch (err) {
      throw new ApiError(400, err.code, err.message);
    }
    throw new ApiError(400, 'invalid_request', 'Send "phone" or "email"');
  };

  /** Push an event to all of a user's connected devices and to their webhooks. */
  const notify = (username, event, payload) => {
    if (LOCK_SENSITIVE.has(event) && (store.lockedChats(username).length || store.hiddenChats(username).length)) {
      // Each device gets the version its own app session may see.
      for (const sid of io.sockets.adapter.rooms.get(userRoom(username)) || []) {
        const sock = io.sockets.sockets.get(sid);
        const version = sock && eventFor(username, event, payload, sock.data.lockKey);
        if (version) sock.emit(event, version);
      }
      const forHooks = eventFor(username, event, payload, null);
      if (forHooks) webhooks?.dispatch(username, event, forHooks);
      return;
    }
    io.to(userRoom(username)).emit(event, payload);
    webhooks?.dispatch(username, event, payload);
  };

  const notifyMembers = (conv, event, payload) => {
    for (const m of conv.members) notify(m, event, payload);
  };

  /** `username` as `viewer` sees them: blocking (either way) hides online status and last seen. */
  const userView = (username, viewer) => ({
    ...store.publicUserFor(username, viewer),
    online: isOnline(username) && !store.blockedEither(username, viewer),
  });
  const usersFor = (usernames, viewer) => {
    const users = {};
    for (const u of usernames) users[u] = userView(u, viewer);
    return users;
  };

  /**
   * Mark a new message delivered to online members and push it to everyone in the
   * chat who may see it. Returns the sender's view of the message.
   */
  const postMessage = (conv, msg) => {
    const recipients = conv.members.filter((m) => Store.visibleTo(msg, m));
    for (const m of recipients) {
      if (m !== msg.from && isOnline(m)) msg.deliveredTo.push(m);
    }
    store._save();
    for (const m of recipients) notify(m, 'message:new', { message: store.viewFor(msg, m) });
    return store.viewFor(msg, msg.from);
  };

  /** Store and broadcast a new message from `me`; a retried clientId just gets its message back. */
  const sendMessage = (me, convId, text, opts) => {
    const conv = store.getConversation(convId);
    const dup = conv && store.findByClientId(convId, me, opts.clientId);
    if (dup) return store.viewFor(dup, me);
    const isFirst = conv && !(store.data.messages[convId] || []).some((m) => m.type !== 'system');
    const msg = store.addMessage(convId, me, text, opts);

    // A brand new direct chat appears in the recipient's list on first message.
    if (isFirst && conv.type === 'direct') {
      for (const m of conv.members) {
        if (m !== me && Store.visibleTo(msg, m)) {
          notify(m, 'conversation:new', { conversation: store.summarize(conv, m), users: usersFor(conv.members, m) });
        }
      }
    }
    const view = postMessage(conv, msg);
    autoReplies(conv, msg);
    return view;
  };

  // ---------- business automatic replies ----------

  const GREETING_GAP_MS = 14 * 24 * 60 * 60 * 1000; // greet again after two quiet weeks
  const AWAY_GAP_MS = 6 * 60 * 60 * 1000; // at most one away message per chat every 6 hours

  /**
   * When someone messages a business in a one-to-one chat, send the business's
   * greeting (new conversation, or after 14 quiet days) and away message
   * (outside business hours), if it has turned them on.
   */
  function autoReplies(conv, msg) {
    if (conv.type !== 'direct' || msg.auto || msg.type === 'system') return;
    const biz = conv.members.find((m) => m !== msg.from);
    const business = store.getBusiness(biz);
    if (!business || store.blockedEither(biz, msg.from)) return;
    const msgs = store.data.messages[conv.id] || [];
    const earlier = msgs.filter((m) => m.id !== msg.id && m.type !== 'system' && Store.visibleTo(m, biz));
    const quietFor = earlier.length ? msg.ts - earlier[earlier.length - 1].ts : Infinity;
    const replies = [];
    if (business.greeting?.enabled && quietFor > GREETING_GAP_MS) replies.push(['greeting', business.greeting.text]);
    if (business.away?.enabled && !BusinessHours.isOpenNow(business, new Date(msg.ts))
      && !msgs.some((m) => m.auto === 'away' && msg.ts - m.ts < AWAY_GAP_MS)) {
      replies.push(['away', business.away.text]);
    }
    for (const [auto, text] of replies) {
      try {
        postMessage(conv, store.addMessage(conv.id, biz, text, { auto }));
      } catch (err) {
        console.warn(`auto ${auto} reply from ${biz} failed: ${err.message}`);
      }
    }
  }

  /** Notify message senders that their messages' delivery/read status changed. */
  const notifyStatus = (convId, changed) => {
    if (!changed.length) return;
    const conv = store.getConversation(convId);
    const messages = changed.map((m) => ({ id: m.id, deliveredTo: m.deliveredTo, readBy: m.readBy }));
    if (conv) notifyMembers(conv, 'message:status', { convId, messages });
  };

  const peersOf = (u) => {
    const peers = new Set();
    for (const c of store.conversationsFor(u)) c.members.forEach((m) => m !== u && peers.add(m));
    return peers;
  };

  const broadcastPresence = (u) => {
    for (const p of peersOf(u)) {
      const { online, lastSeen } = userView(u, p);
      notify(p, 'presence', { username: u, online, lastSeen });
    }
  };

  /** Send each person their own view of a status (only the owner sees who viewed it). */
  const broadcastStatus = (status, event) => {
    for (const u of [status.owner, ...store.statusAudience(status.owner)]) {
      notify(u, event, event === 'status:deleted' ? { id: status.id } : { status: store.statusView(status, u) });
    }
  };

  const member = (me, convId) => {
    const conv = store.getConversation(convId);
    if (!conv || !conv.members.includes(me)) throw new ApiError(404, 'not_found', 'Conversation not found');
    return conv;
  };

  let calls = null; // set by setCalls (the call manager needs postMessage, so it's created after us)

  const conversationView = (me, conv, ctx) => lockView(me, { ...store.summarize(conv, me), activeCall: calls?.activeCallFor(conv.id) || null }, ctx?.lockKey);

  const lockSettings = (me) => ({
    hasCode: store.hasLockCode(me),
    lockedChats: store.lockedChats(me),
    hiddenCount: store.hiddenChats(me).length,
    biometric: store.passkeysOf(me).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt })),
  });
  /** My devices hear everything; webhooks only learn about locked chats (never hidden chats or devices). */
  const announceLocks = (me) => {
    io.to(userRoom(me)).emit('chatlock:update', lockSettings(me));
    webhooks?.dispatch(me, 'chatlock:update', { hasCode: store.hasLockCode(me), lockedChats: store.lockedChats(me) });
  };
  /** The chat list changed (chats hidden, unhidden, locks cleared): my devices should reload it. */
  const announceChatList = (me) => io.to(userRoom(me)).emit('hidden:update', {});

  const actions = {
    me(me) {
      return {
        user: store.publicUser(me),
        iceServers,
        blocked: store.blockedList(me),
        defaultDisappear: store.defaultDisappear(me),
        business: store.getBusiness(me),
        contact: store.contactOf(me),
        privacy: { profileViews: store.profileViewsEnabled(me) },
        appearance: appearance.effective(store.prefsOf(me), store.isPremium(me)),
      };
    },

    // ----- personalisation (colour theme, app icon, avatar shape) -----

    /** My look. Premium options revert to the defaults while Premium is not active (my choices are kept for when it comes back). */
    appearance(me) {
      const premium = store.isPremium(me);
      return { appearance: appearance.effective(store.prefsOf(me), premium), saved: store.prefsOf(me), premium };
    },

    setAppearance(me, patch) {
      const { patch: clean, needsPremium } = (() => {
        try {
          return appearance.checkPatch(patch);
        } catch (err) {
          throw new ApiError(400, 'invalid_request', err.message);
        }
      })();
      if (needsPremium && !store.isPremium(me)) {
        throw new ApiError(402, 'premium_required', `${needsPremium} are a Premium feature. Upgrade to Premium to use them.`);
      }
      store.setPrefs(me, clean);
      const result = actions.appearance(me);
      io.to(userRoom(me)).emit('appearance:update', result.appearance);
      return result;
    },

    // ----- profile views -----

    /** I opened someone's profile: they can see that (when both of us have profile views on). */
    viewProfile(me, { username }) {
      const target = String(username || '').toLowerCase();
      if (!store.publicUser(target)) throw new ApiError(404, 'not_found', 'User not found');
      if (store.recordProfileView(me, target)) io.to(userRoom(target)).emit('profile:viewed', {});
      return {};
    },

    /** Who viewed my profile (last 90 days), whether or not they are in my contacts, with the last view date. */
    profileViews(me) {
      if (!store.profileViewsEnabled(me)) {
        return { enabled: false, retentionDays: Store.PROFILE_VIEWS_DAYS, viewers: [] };
      }
      const list = store.profileViewsOf(me);
      return {
        enabled: true,
        retentionDays: Store.PROFILE_VIEWS_DAYS,
        viewers: list.map((v) => ({ user: userView(v.username, me), inContact: v.inContact, lastViewedAt: v.lastViewedAt })),
      };
    },

    /** Turn profile views on or off. Off: my views are not recorded, I can't see who viewed me, and my list is erased. */
    setProfileViews(me, { enabled }) {
      store.setProfileViewsEnabled(me, !!enabled);
      io.to(userRoom(me)).emit('profile:viewed', {});
      return { privacy: { profileViews: store.profileViewsEnabled(me) } };
    },

    // ----- public channels -----

    /** Search the public directory (no `q`: the most followed channels). */
    channelsSearch(me, { q }) {
      const channels = store.searchChannels(q);
      return { channels: channels.map((c) => store.channelView(c, me)), users: usersFor(new Set(channels.map((c) => c.owner)), me) };
    },

    /** Channels I follow or own, with unread counts. */
    channelsMine(me) {
      const channels = store.channelsOf(me);
      return { channels: channels.map((c) => store.channelView(c, me)), users: usersFor(new Set(channels.map((c) => c.owner)), me) };
    },

    channelGet(me, { id }) {
      const ch = channelOrThrow(id);
      return { channel: store.channelView(ch, me), users: usersFor(new Set([ch.owner, ...ch.admins]), me) };
    },

    channelCreate(me, fields) {
      const ch = store.createChannel(me, fields || {});
      return { channel: store.channelView(ch, me) };
    },

    channelUpdate(me, { id, ...fields }) {
      const ch = store.updateChannel(me, channelOrThrow(id).id, fields);
      for (const f of Object.keys(ch.followers)) io.to(userRoom(f)).emit('channel:updated', { channel: store.channelView(ch, f) });
      return { channel: store.channelView(ch, me) };
    },

    channelDelete(me, { id }) {
      const channelId = channelOrThrow(id).id;
      const followers = store.deleteChannel(me, channelId);
      for (const f of followers) io.to(userRoom(f)).emit('channel:deleted', { id: channelId });
      return {};
    },

    channelFollow(me, { id }) {
      const ch = store.followChannel(me, channelOrThrow(id).id);
      io.to(userRoom(me)).emit('channel:updated', { channel: store.channelView(ch, me) });
      return { channel: store.channelView(ch, me) };
    },

    channelUnfollow(me, { id }) {
      const ch = store.unfollowChannel(me, channelOrThrow(id).id);
      io.to(userRoom(me)).emit('channel:updated', { channel: store.channelView(ch, me) });
      return { channel: store.channelView(ch, me) };
    },

    /** Owner only: make someone an admin (they can post), or take it away. */
    channelAdmin(me, { id, username, admin }) {
      const ch = store.setChannelAdmin(me, channelOrThrow(id).id, String(username || '').toLowerCase(), admin !== false);
      for (const f of Object.keys(ch.followers)) io.to(userRoom(f)).emit('channel:updated', { channel: store.channelView(ch, f) });
      return { channel: store.channelView(ch, me) };
    },

    /** Channels are public: anyone signed in can read the posts, without following. */
    channelPosts(me, { id, before, limit }) {
      const ch = channelOrThrow(id);
      const n = Math.max(1, Math.min(PAGE_MAX, Number(limit) || 30));
      const page = store.channelPostsPage(ch.id, { before: Number(before) || undefined, limit: n });
      if (ch.followers[me]) store.markChannelRead(me, ch.id);
      return { ...page, users: usersFor(new Set(page.posts.map((p) => p.by)), me) };
    },

    /** Owner or admin: publish a post. Followers get it live. */
    channelPost(me, { id, text }) {
      const ch = channelOrThrow(id);
      const recent = (channelPostTimes.get(me) || []).filter((t) => t > Date.now() - 60000);
      if (recent.length >= 20) throw new ApiError(429, 'rate_limited', 'Posting too fast. Try again in a minute.');
      const post = store.postToChannel(me, ch.id, text);
      recent.push(Date.now());
      channelPostTimes.set(me, recent);
      for (const f of Object.keys(ch.followers)) io.to(userRoom(f)).emit('channel:post', { post, channel: store.channelView(ch, f) });
      return { post };
    },

    channelPostDelete(me, { id, postId }) {
      const ch = channelOrThrow(id);
      store.deleteChannelPost(me, ch.id, postId);
      for (const f of Object.keys(ch.followers)) io.to(userRoom(f)).emit('channel:post-deleted', { channelId: ch.id, postId, channel: store.channelView(ch, f) });
      return {};
    },

    channelRead(me, { id }) {
      store.markChannelRead(me, channelOrThrow(id).id);
      return {};
    },

    channelReport(me, { id, reason }) {
      store.reportChannel(me, channelOrThrow(id).id, reason);
      return {};
    },

    // ----- product catalogue (business profiles) -----

    /** A business's catalogue: anyone signed in can look (omit `username` for my own). */
    catalogue(me, { username } = {}) {
      const owner = username ? String(username).toLowerCase() : me;
      const c = store.catalogueOf(owner);
      if (!c) throw new ApiError(404, 'not_found', 'This account has no catalogue');
      return { owner, ...c };
    },

    saveProduct(me, { id, ...fields }) {
      const product = id ? store.updateProduct(me, id, fields) : store.addProduct(me, fields);
      return { product };
    },

    deleteProduct(me, { id }) {
      store.deleteProduct(me, id);
      return {};
    },

    /** Set a product's picture (JPEG, PNG or WebP, up to 1 MB), replacing the old one. */
    setProductImage(me, { id, mime, data }) {
      if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('Picture is empty');
      if (data.length > PRODUCT_IMAGE_MAX_BYTES) throw new ApiError(413, 'too_large', 'Picture is too large (max 1 MB)');
      mime = String(mime || '').split(';')[0].trim();
      if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw new ApiError(415, 'unsupported_media_type', 'Use a JPEG, PNG or WebP picture');
      if (!store.catalogueOf(me)?.products.some((p) => p.id === id)) throw new ApiError(404, 'not_found', 'Product not found');
      const mediaId = store.saveMedia({ publicBy: me }, data, mime);
      try {
        return { product: store.setProductImage(me, id, mediaId) };
      } catch (err) {
        store.deleteMedia(mediaId);
        throw err;
      }
    },

    removeProductImage(me, { id }) {
      return { product: store.setProductImage(me, id, null) };
    },

    setCatalogueCurrency(me, { currency }) {
      return { currency: store.setCatalogueCurrency(me, currency) };
    },

    // ----- translating received messages -----

    translateLanguages() {
      return { languages: translator?.languages || [], available: !!translator?.available, sandbox: !!translator?.sandbox };
    },

    /** Choose the language received messages of this chat are shown in (`lang` null/'' turns it off). Private to me. */
    setTranslation(me, { convId, lang }) {
      member(me, convId);
      lang = lang ? String(lang).toLowerCase() : null;
      if (lang && !translator?.isLanguage(lang)) throw new ApiError(400, 'invalid_request', 'Unknown language');
      if (lang && !translator.available) throw new ApiError(503, 'translation_unavailable', 'Translation is not available right now');
      store.setTranslateTo(me, convId, lang);
      io.to(userRoom(me)).emit('translate:update', { convId, lang });
      return { convId, lang };
    },

    /**
     * Translate texts the app has decrypted, into this chat's chosen language. Only works for
     * chats where translation is on. Texts are passed through and not stored or logged.
     */
    async translateTexts(me, { convId, texts }, ctx) {
      member(me, convId);
      requireUnlocked(me, convId, ctx);
      const target = store.translateTo(me, convId);
      if (!target) throw new ApiError(400, 'translation_off', 'Turn on translation for this chat first');
      if (!translator) throw new ApiError(503, 'translation_unavailable', 'Translation is not available right now');
      return { target, translations: await translator.translate(me, target, texts) };
    },

    // ----- Premium subscription -----

    subscriptionStatus(me) {
      return subscriptionView(me);
    },

    /** Start paying for a plan ('daily' | 'monthly' | 'yearly'). Returns where to pay. */
    async subscriptionCheckout(me, { plan }) {
      if (!payments) throw new ApiError(503, 'payments_unavailable', 'Subscriptions are not available right now');
      return payments.checkout(me, plan);
    },

    /** After paying: the server asks the payment service, and switches Premium on when it was paid. */
    async subscriptionConfirm(me, { orderId }) {
      if (!payments) throw new ApiError(503, 'payments_unavailable', 'Subscriptions are not available right now');
      await payments.confirm(me, orderId);
      const view = subscriptionView(me);
      announceProfile(me);
      io.to(userRoom(me)).emit('subscription:update', view);
      io.to(userRoom(me)).emit('appearance:update', appearance.effective(store.prefsOf(me), true));
      return view;
    },

    // ----- verified badge (KYC) -----

    kycStatus(me) {
      return { verified: store.isVerified(me), available: !!kyc?.available, sandbox: !!kyc?.sandbox, types: kyc ? kyc.listTypes(me) : [] };
    },

    /** Send the ID number to the verification gateway, which texts a code. The ID is not kept. */
    async kycStart(me, { type, idNumber }) {
      if (!kyc) throw new ApiError(503, 'kyc_unavailable', 'Identity verification is not available right now');
      return kyc.start(me, { type, idNumber });
    },

    /** Check the code once; success gives the account the Verified badge. */
    async kycVerify(me, { requestId, otp: code }) {
      if (!kyc) throw new ApiError(503, 'kyc_unavailable', 'Identity verification is not available right now');
      await kyc.verify(me, { requestId, otp: code });
      return { verified: true, user: announceProfile(me) };
    },

    // ----- verified mobile number and email -----

    /** Send a code to a new mobile number (`{ phone }`) or email (`{ email }`) to add or change it. */
    async requestContactCode(me, body = {}) {
      const dest = contactDestination(body);
      const owner = dest.channel === 'sms' ? store.findByPhone(dest.to) : store.findByEmail(dest.to);
      if (owner === me) throw new ApiError(400, 'invalid_request', `That is already your ${dest.channel === 'sms' ? 'mobile number' : 'email'}`);
      if (owner) throw new ApiError(409, `${dest.channel === 'sms' ? 'phone' : 'email'}_taken`, `This ${dest.channel === 'sms' ? 'mobile number' : 'email'} is already registered`);
      return otp.request({ ...dest, purpose: 'contact' });
    },

    /** Save the number or email once its code checks out: `{ phone | email, requestId, code }`. */
    verifyContact(me, body = {}) {
      const dest = contactDestination(body);
      otp.verify({ requestId: body.requestId, code: body.code, ...dest, purpose: 'contact' });
      store.setContact(me, dest.channel, dest.to);
      announceProfile(me);
      return { contact: store.contactOf(me), business: store.getBusiness(me) };
    },

    updateProfile(me, { displayName, about }) {
      store.updateProfile(me, { displayName, about });
      return { user: announceProfile(me) };
    },

    // ----- business profile -----

    business(me) {
      return { business: store.getBusiness(me) };
    },

    /** Become a business account, or update the business details. */
    setBusiness(me, input) {
      const { phone, email } = store.contactOf(me) || {};
      if (!phone || !email) {
        throw new ApiError(400, 'verification_required', 'A business account needs a verified mobile number and email. Add them in your profile first.');
      }
      const business = store.setBusiness(me, input || {});
      return { business, user: announceProfile(me) };
    },

    /** Back to a personal account. */
    removeBusiness(me) {
      store.removeBusiness(me);
      return { business: null, user: announceProfile(me) };
    },

    // ----- disappearing messages -----

    /** Timer for this chat, in seconds (null/0 = off). Everyone in the chat sees a notice. */
    setDisappearing(me, { convId, seconds }, ctx) {
      member(me, convId);
      requireUnlocked(me, convId, ctx);
      const conv = store.setDisappearing(convId, me, seconds);
      postMessage(conv, store.addSystemMessage(convId, me, { event: 'disappearing', seconds: conv.disappearAfter || null }));
      // notify() redacts per device for members who locked this chat.
      for (const m of conv.members) notify(m, 'conversation:updated', { conversation: { ...store.summarize(conv, m), activeCall: calls?.activeCallFor(conv.id) || null } });
      return { conversation: conversationView(me, conv, ctx) };
    },

    /** Timer applied to new chats I start (seconds, null/0 = off). */
    setDefaultDisappear(me, { seconds }) {
      return { defaultDisappear: store.setDefaultDisappear(me, seconds) };
    },

    searchUsers(me, { q }) {
      return { users: store.searchUsers(q, me).map((u) => userView(u.username, me)) };
    },

    getUser(me, { username }) {
      const u = String(username || '').toLowerCase();
      if (!store.publicUser(u)) throw new ApiError(404, 'not_found', 'User not found');
      return { user: userView(u, me), blocked: store.hasBlocked(me, u) };
    },

    block(me, { username, blocked }) {
      const target = String(username || '').toLowerCase();
      const list = store.setBlocked(me, target, !!blocked);
      // Sync my other devices, and refresh what each side sees of the other's presence.
      notify(me, 'blocked:update', { blocked: list });
      const theirView = userView(me, target);
      notify(target, 'presence', { username: me, online: theirView.online, lastSeen: theirView.lastSeen });
      return { blocked: list, user: userView(target, me) };
    },

    blocked(me) {
      return { blocked: store.blockedList(me) };
    },

    conversations(me, _payload, ctx) {
      // Hidden chats never appear here; they are listed by `listHidden` once revealed.
      const conversations = store.conversationsFor(me).filter((c) => !store.isChatHidden(me, c.id)).map((c) => conversationView(me, c, ctx));
      const people = new Set();
      conversations.forEach((c) => c.members.forEach((m) => people.add(m)));
      return { conversations, users: usersFor(people, me), hiddenCount: store.hiddenChats(me).length };
    },

    getConversation(me, { convId }, ctx) {
      const conv = member(me, convId);
      return { conversation: conversationView(me, conv, ctx), users: usersFor(conv.members, me) };
    },

    openDirect(me, { username }, ctx) {
      const conv = store.getOrCreateDirect(me, String(username || '').toLowerCase());
      return { conversation: conversationView(me, conv, ctx) };
    },

    createGroup(me, { name, members }, ctx) {
      const conv = store.createGroup(me, name, members);
      for (const m of conv.members) {
        notify(m, 'conversation:new', { conversation: store.summarize(conv, m), users: usersFor(conv.members, m) });
      }
      return { conversation: conversationView(me, conv, ctx) };
    },

    /** Newest `limit` messages (before `before`, a timestamp, for older pages). */
    messages(me, { convId, before, limit }, ctx) {
      member(me, convId);
      requireUnlocked(me, convId, ctx);
      const n = Math.max(1, Math.min(PAGE_MAX, Number(limit) || 50));
      const page = store.getMessages(convId, me, { before: Number(before) || undefined, limit: n + 1 });
      const hasMore = page.length > n;
      const messages = hasMore ? page.slice(1) : page;
      return { messages, hasMore, nextBefore: hasMore ? messages[0].ts : null };
    },

    sendText(me, { convId, text, masked, clientId, e2ee }, ctx) {
      const conv = member(me, convId);
      requireUnlocked(me, convId, ctx);
      // With `e2ee` the text is inside the encrypted envelope and the server never sees it.
      const env = e2ee ? checkEnvelope(me, conv, e2ee) : undefined;
      return { message: sendMessage(me, convId, env ? '' : text, { masked: !!masked, clientId, e2ee: env }) };
    },

    // ----- end-to-end encryption: device keys -----

    e2eeDevices(me) {
      return { devices: store.publicDevices(me) };
    },

    /** Register this device's public key (the private key never leaves the device). */
    registerDevice(me, { name, publicKey }) {
      const device = store.addDevice(me, { name, publicKey });
      announceDevices(me);
      return { device, devices: store.publicDevices(me) };
    },

    removeDevice(me, { id }) {
      store.removeDevice(me, String(id));
      announceDevices(me);
      return { devices: store.publicDevices(me) };
    },

    /** Public keys of every device of every member of a chat, to encrypt for (and to check senders). */
    conversationKeys(me, { convId }) {
      const conv = member(me, convId);
      return { keys: Object.fromEntries(conv.members.map((m) => [m, store.publicDevices(m)])) };
    },

    sendVoice(me, { convId, clientId, duration, mime, data, e2ee }, ctx) {
      const conv = member(me, convId);
      requireUnlocked(me, convId, ctx);
      const env = e2ee ? checkEnvelope(me, conv, e2ee, { media: true }) : undefined;
      const dup = store.findByClientId(convId, me, clientId);
      if (dup) return { message: store.viewFor(dup, me) };
      if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('Recording is empty');
      if (data.length > VOICE_MAX_BYTES) throw new ApiError(413, 'too_large', 'Recording is too large');
      mime = String(mime || '').split(';')[0].trim();
      if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) throw new ApiError(415, 'unsupported_media_type', 'Unsupported audio format');
      duration = Math.min(Number(duration) || 0, VOICE_MAX_SECONDS);
      const mediaId = store.saveMedia(convId, data, mime);
      try {
        return { message: sendMessage(me, convId, '', { clientId, voice: { mediaId, duration, mime }, e2ee: env }) };
      } catch (err) {
        store.deleteMedia(mediaId);
        throw err;
      }
    },

    markRead(me, { convId }, ctx) {
      member(me, convId);
      requireUnlocked(me, convId, ctx);
      const changed = store.markRead(convId, me);
      notifyStatus(convId, changed);
      return { updated: changed.length };
    },

    deleteMessage(me, { id }, ctx) {
      const found = store.findMessage(id);
      if (found && store.isMember(found.convId, me)) requireUnlocked(me, found.convId, ctx);
      const { convId, message } = store.deleteMessage(id, me);
      notifyMembers(store.getConversation(convId), 'message:deleted', { convId, id: message.id });
      return {};
    },

    star(me, { id, starred }, ctx) {
      const found = store.findMessage(id);
      if (found && store.isMember(found.convId, me)) requireUnlocked(me, found.convId, ctx);
      const { convId, message } = store.setStarred(id, me, !!starred);
      // Stars are private: only my own devices hear about it.
      notify(me, 'message:starred', { convId, id: message.id, starred: !!message.starred });
      return { message };
    },

    starred(me, _payload, ctx) {
      return { messages: store.starredFor(me).map((m) => (isUnlocked(me, m.convId, ctx) ? m : redactMessage(m))) };
    },

    // ----- chat lock -----

    lockSettings(me) {
      return lockSettings(me);
    },

    /** Create the secret code, or change it (needs `currentCode`). */
    setLockCode(me, { code, currentCode }) {
      if (store.hasLockCode(me)) checkSecret(me, () => store.verifyLockCode(me, currentCode), 'current secret code');
      store.setLockCode(me, code, currentCode);
      announceLocks(me);
      return lockSettings(me);
    },

    /** Forgot the code: get a code by SMS on the account's mobile number. */
    requestLockResetCode(me) {
      const { phone } = store.contactOf(me) || {};
      if (!phone) throw new ApiError(400, 'verification_required', 'Add a mobile number to your account first, or reset with your password');
      return otp.request({ channel: 'sms', to: phone, purpose: 'chatlock-reset' });
    },

    /**
     * Forgot the code: choose a new one, proven with the SMS code
     * (`{ requestId, code, newCode }`) or, for older accounts, the password.
     */
    resetLockCode(me, { password, requestId, code, newCode }) {
      if (requestId) {
        Store._checkLockCode(newCode);
        const { phone } = store.contactOf(me) || {};
        otp.verify({ requestId, code, channel: 'sms', to: phone, purpose: 'chatlock-reset' });
        store.resetLockCode(me, null, newCode);
        announceLocks(me);
        return lockSettings(me);
      }
      checkSecret(me, () => {
        try {
          store.resetLockCode(me, password, newCode);
          return true;
        } catch (err) {
          if (/Password is wrong/.test(err.message)) return false;
          throw err;
        }
      }, 'password');
      announceLocks(me);
      return lockSettings(me);
    },

    /** Lock a chat. It is locked straight away, everywhere, including this session. */
    lockChat(me, { convId }) {
      member(me, convId);
      if (store.isChatHidden(me, convId)) throw new ApiError(409, 'conflict', 'Hidden chats are already protected. Unhide the chat to lock it instead.');
      if (!store.isChatLocked(me, convId)) requireRoom(me, 'lock');
      store.setChatLocked(me, convId, true);
      for (const [key, set] of unlocked) if (key.startsWith(`${me}|`)) set.delete(convId);
      announceLocks(me);
      return lockSettings(me);
    },

    /** Remove the lock from a chat for good (needs the code). */
    removeChatLock(me, { convId, code, biometric }) {
      member(me, convId);
      if (!store.isChatLocked(me, convId)) return lockSettings(me);
      verifyProof(me, { code, biometric });
      store.setChatLocked(me, convId, false);
      announceLocks(me);
      return lockSettings(me);
    },

    /** Open a locked chat for the rest of this app session. For a hidden chat this reveals all hidden chats. */
    unlockChat(me, { convId, code, biometric }, ctx) {
      const conv = member(me, convId);
      if (!ctx?.lockKey) throw new ApiError(400, 'bad_request', 'No app session to unlock');
      if (store.isChatHidden(me, convId)) {
        verifyProof(me, { code, biometric });
        revealed.add(ctx.lockKey);
      } else if (store.isChatLocked(me, convId)) {
        verifyProof(me, { code, biometric });
        if (!unlocked.has(ctx.lockKey)) unlocked.set(ctx.lockKey, new Set());
        unlocked.get(ctx.lockKey).add(convId);
      }
      return { conversation: conversationView(me, conv, ctx) };
    },

    /** Lock every unlocked chat again, and close hidden chats, in this app session ("Lock now"). */
    relock(me, _payload, ctx) {
      if (ctx?.lockKey) {
        unlocked.delete(ctx.lockKey);
        revealed.delete(ctx.lockKey);
      }
      return lockSettings(me);
    },

    // ----- hidden chats -----

    /** Hide a chat from the chat list. Needs a secret code (it protects hidden chats). */
    hideChat(me, { convId, username }, ctx) {
      // Hide a specific contact's chat, even before they have ever written to you.
      if (!convId && username) convId = store.getOrCreateDirect(me, String(username).toLowerCase()).id;
      member(me, convId);
      if (!store.hasLockCode(me)) throw new ApiError(400, 'code_required', 'Set a secret code first: it protects your hidden chats');
      if (!store.isChatHidden(me, convId)) requireRoom(me, 'hide');
      store.setChatHidden(me, convId, true);
      for (const [key, set] of unlocked) if (key.startsWith(`${me}|`)) set.delete(convId);
      announceLocks(me);
      announceChatList(me);
      return { ...lockSettings(me), convId };
    },

    /** Put a hidden chat back in the chat list (the session must have revealed hidden chats). */
    unhideChat(me, { convId }, ctx) {
      const conv = member(me, convId);
      if (store.isChatHidden(me, convId) && !isRevealed(ctx?.lockKey)) throw new ApiError(423, 'chat_locked', 'Open your hidden chats with your secret code first');
      store.setChatHidden(me, convId, false);
      announceLocks(me);
      announceChatList(me);
      return { conversation: conversationView(me, conv, ctx), ...lockSettings(me) };
    },

    /** Open hidden chats for this app session, with the secret code or a fingerprint/face check. */
    revealHidden(me, { code, biometric }, ctx) {
      if (!ctx?.lockKey) throw new ApiError(400, 'bad_request', 'No app session to unlock');
      verifyProof(me, { code, biometric });
      revealed.add(ctx.lockKey);
      return actions.listHidden(me, {}, ctx);
    },

    /** The hidden chats (only after `revealHidden` in this session). */
    listHidden(me, _payload, ctx) {
      if (!isRevealed(ctx?.lockKey)) throw new ApiError(423, 'chat_locked', 'Open your hidden chats with your secret code first');
      const conversations = store.conversationsFor(me).filter((c) => store.isChatHidden(me, c.id)).map((c) => conversationView(me, c, ctx));
      const people = new Set();
      conversations.forEach((c) => c.members.forEach((m) => people.add(m)));
      return { conversations, users: usersFor(people, me) };
    },

    /** Close hidden chats again in this session. */
    hideAgain(me, _payload, ctx) {
      if (ctx?.lockKey) revealed.delete(ctx.lockKey);
      return lockSettings(me);
    },

    /** Settings: bring every hidden chat back to the chat list. Needs the code or fingerprint/face. */
    clearHidden(me, { code, biometric }) {
      verifyProof(me, { code, biometric });
      const ids = store.clearHidden(me);
      announceLocks(me);
      announceChatList(me);
      return { cleared: ids.length, ...lockSettings(me) };
    },

    /** Settings: remove the lock from every locked chat. Needs the code or fingerprint/face. */
    clearChatLocks(me, { code, biometric }) {
      verifyProof(me, { code, biometric });
      const ids = store.clearLocked(me);
      for (const set of unlocked.values()) ids.forEach((id) => set.delete(id));
      announceLocks(me);
      announceChatList(me);
      return { cleared: ids.length, ...lockSettings(me) };
    },

    // ----- fingerprint / face lock -----

    /** A one-time challenge to sign: to set up a device (`register`) or to prove it is you. */
    biometricChallenge(me) {
      return {
        challenge: webauthn.challenge(me),
        userId: Buffer.from(me).toString('base64url'),
        credentials: store.passkeysOf(me).map((k) => k.id),
      };
    },

    /** Set up this device's fingerprint/face lock (confirm with the secret code). */
    addBiometric(me, { code, name, credential }) {
      if (!store.hasLockCode(me)) throw new ApiError(400, 'code_required', 'Set a secret code first');
      verifyProof(me, { code });
      let entry;
      try {
        entry = webauthn.verifyRegistration(me, credential || {});
      } catch (err) {
        if (err instanceof webauthn.WebAuthnError) throw new ApiError(400, 'biometric_failed', err.message);
        throw err;
      }
      store.addPasskey(me, entry, name);
      announceLocks(me);
      return lockSettings(me);
    },

    /** Remove a device's fingerprint/face lock (confirm with the code or another check). */
    removeBiometric(me, { id, code, biometric }) {
      verifyProof(me, { code, biometric });
      store.removePasskey(me, String(id));
      announceLocks(me);
      return lockSettings(me);
    },

    /** What I'm doing in a chat: 'typing' or 'recording' (a voice message); isTyping=false clears it. */
    typing(me, { convId, isTyping, activity }) {
      const conv = member(me, convId);
      activity = activity === 'recording' ? 'recording' : 'typing';
      for (const m of conv.members) {
        if (m === me || (conv.type === 'direct' && store.blockedEither(me, m))) continue;
        notify(m, 'typing', { convId, username: me, isTyping: !!isTyping, activity });
      }
      return {};
    },

    // ----- status updates -----

    statuses(me) {
      const statuses = store.statusesFor(me);
      return { statuses, users: usersFor(new Set(statuses.map((s) => s.owner)), me) };
    },

    postStatus(me, { type, text, bg, caption, mime, data }) {
      let status;
      if (type === 'image') {
        if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('Photo is empty');
        if (data.length > PHOTO_MAX_BYTES) throw new ApiError(413, 'too_large', 'Photo is too large');
        mime = String(mime || '').split(';')[0].trim();
        if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new ApiError(415, 'unsupported_media_type', 'Unsupported image format');
        const id = store.newStatusId();
        const mediaId = store.saveMedia({ statusId: id }, data, mime);
        try {
          status = store.addStatus(me, { type, mediaId, caption }, id);
        } catch (err) {
          store.deleteMedia(mediaId);
          throw err;
        }
      } else {
        status = store.addStatus(me, { type, text, bg });
      }
      broadcastStatus(status, 'status:new');
      return { status: store.statusView(status, me) };
    },

    viewStatus(me, { id }) {
      const ts = store.markStatusViewed(id, me);
      if (ts) notify(store.data.statuses[id].owner, 'status:viewed', { id, username: me, ts });
      return {};
    },

    deleteStatus(me, { id }) {
      // Everyone who could see it hears about the delete, so look up the audience first.
      const status = store.data.statuses[id];
      if (!status || status.owner !== me) throw new ApiError(404, 'not_found', 'Status not found');
      broadcastStatus(status, 'status:deleted');
      store.deleteStatus(id, me);
      return {};
    },

    /** Replying to a status sends a message in the one-to-one chat with its owner. */
    replyStatus(me, { id, text, clientId, e2ee }, ctx) {
      const status = store.data.statuses[id];
      if (!store.canSeeStatus(status, me) || status.owner === me) throw new ApiError(404, 'not_found', 'Status not found');
      const conv = store.getOrCreateDirect(me, status.owner);
      const preview = status.type === 'text' ? status.text.slice(0, 120) : status.caption.slice(0, 120);
      const env = e2ee ? checkEnvelope(me, conv, e2ee) : undefined;
      const message = sendMessage(me, conv.id, env ? '' : text, {
        clientId,
        e2ee: env,
        statusReply: { statusId: status.id, owner: status.owner, type: status.type, preview, ...(status.bg ? { bg: status.bg } : {}) },
      });
      return { message, conversation: conversationView(me, conv, ctx) };
    },

    activeCall(me, { convId }) {
      member(me, convId);
      return { call: calls?.activeCallFor(convId) || null };
    },
  };

  /** Tell my devices and the people I chat with that my profile changed. */
  function announceProfile(me) {
    const user = store.publicUser(me);
    notify(me, 'user:updated', { user: { ...user, online: isOnline(me) } });
    for (const p of peersOf(me)) notify(p, 'user:updated', { user: userView(me, p) });
    return user;
  }

  /** Delete messages whose timer ran out, and tell everyone in those chats. */
  const pruneExpired = () => {
    for (const { convId, ids } of store.pruneMessages()) {
      const conv = store.getConversation(convId);
      if (conv) notifyMembers(conv, 'message:expired', { convId, ids });
    }
  };

  /** May this app session download this media (voice notes of locked chats need unlocking)? */
  const mediaAllowed = (me, mediaId, ctx) => {
    const convId = store.mediaConversation(mediaId);
    return !convId || isUnlocked(me, convId, ctx);
  };

  /** Forget unlocks tied to a credential (on logout) or one app session (on disconnect). */
  const forgetUnlocks = ({ credential, lockKey }) => {
    if (lockKey) {
      unlocked.delete(lockKey);
      revealed.delete(lockKey);
    }
    if (credential) {
      for (const key of [...unlocked.keys(), ...revealed]) {
        if (key.split('|')[1] === credential) {
          unlocked.delete(key);
          revealed.delete(key);
        }
      }
    }
  };

  // ---------- feature switches and platform status (set by administrators) ----------

  const featureLabel = Object.fromEntries(FEATURES.map((f) => [f.id, f.label]));
  /** Actions that need a feature to be on. A function decides per call (so turning things off or reading stays possible). */
  const GATES = {
    createGroup: 'groups',
    sendVoice: 'voiceMessages',
    setDisappearing: (p) => (p?.seconds ? 'disappearing' : null),
    setDefaultDisappear: (p) => (p?.seconds ? 'disappearing' : null),
    statuses: 'status', postStatus: 'status', viewStatus: 'status', deleteStatus: 'status', replyStatus: 'status',
    channelsSearch: 'channels', channelsMine: 'channels', channelGet: 'channels', channelCreate: 'channels', channelUpdate: 'channels',
    channelDelete: 'channels', channelFollow: 'channels', channelUnfollow: 'channels', channelAdmin: 'channels', channelPosts: 'channels',
    channelPost: 'channels', channelPostDelete: 'channels', channelRead: 'channels', channelReport: 'channels',
    viewProfile: 'profileViews', profileViews: 'profileViews',
    translateLanguages: 'translation', translateTexts: 'translation', setTranslation: (p) => (p?.lang ? 'translation' : null),
    lockChat: 'chatLock',
    setAppearance: 'appearance',
    hideChat: 'hideChat',
    setBusiness: 'business',
    catalogue: 'catalogue', saveProduct: 'catalogue', deleteProduct: 'catalogue', setProductImage: 'catalogue', removeProductImage: 'catalogue', setCatalogueCurrency: 'catalogue',
    subscriptionCheckout: 'premium',
    kycStart: 'verification',
  };
  const assertFeature = (id) => {
    if (!store.featureOn(id)) throw new ApiError(403, 'feature_disabled', `${featureLabel[id] || id} is turned off by the administrator`);
  };
  for (const [name, gate] of Object.entries(GATES)) {
    const fn = actions[name];
    actions[name] = function gated(me, payload, ctx) {
      const id = typeof gate === 'function' ? gate(payload) : gate;
      if (id) assertFeature(id);
      return fn.call(actions, me, payload, ctx);
    };
  }

  /** The public configuration every client (web and mobile) reads at start-up and when it changes. */
  const config = () => {
    const s = store.getSettings();
    return {
      features: Object.fromEntries(FEATURES.map((f) => [f.id, s.features[f.id] !== false])),
      maintenance: s.maintenance.on ? { on: true, message: s.maintenance.message } : { on: false },
      announcement: s.announcement || '',
      minClientVersion: s.minClientVersion || null,
      limits: { free: { chatLocks: s.limits.freeChatLocks, hiddenChats: s.limits.freeHiddenChats } },
    };
  };
  const broadcastConfig = () => io.emit('config:update', config());

  /** Throws while maintenance is on, or when the client is older than the minimum version. */
  const assertAvailable = (clientVersion) => {
    const s = store.getSettings();
    if (s.maintenance.on) throw new ApiError(503, 'maintenance', s.maintenance.message);
    if (s.minClientVersion && clientVersion && versionLess(clientVersion, s.minClientVersion)) {
      throw new ApiError(426, 'update_required', `Please update the app to version ${s.minClientVersion} or newer`);
    }
  };

  return {
    actions,
    config,
    broadcastConfig,
    /** An administrator changed someone's badge or Premium: tell their devices and their contacts. */
    refreshAccount(username) {
      announceProfile(username);
      io.to(userRoom(username)).emit('subscription:update', subscriptionView(username));
      io.to(userRoom(username)).emit('appearance:update', appearance.effective(store.prefsOf(username), store.isPremium(username)));
    },
    assertAvailable,
    assertFeature,
    notify,
    lockKeyFor,
    mediaAllowed,
    pruneExpired,
    expireSubscriptions,
    forgetUnlocks,
    userRoom,
    userView,
    postMessage,
    notifyStatus,
    broadcastPresence,
    broadcastStatus,
    setCalls(c) { calls = c; },
  };
}

module.exports = { createService, ApiError };
