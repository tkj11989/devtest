'use strict';

const { Store } = require('./store');

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
const PAGE_MAX = 100;

/**
 * Everything a signed-in user can do, shared by the Socket.IO handlers (the web app)
 * and the REST API (other platforms), so both behave identically and every change is
 * pushed live to connected clients and webhooks through `notify`.
 *
 * Each action is `(me, payload) => result` and throws on bad input.
 */
function createService({ store, io, isOnline, webhooks, iceServers }) {
  const userRoom = (u) => `user:${u}`;

  /** Push an event to all of a user's connected devices and to their webhooks. */
  const notify = (username, event, payload) => {
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
    const isFirst = conv && (store.data.messages[convId] || []).length === 0;
    const msg = store.addMessage(convId, me, text, opts);

    // A brand new direct chat appears in the recipient's list on first message.
    if (isFirst && conv.type === 'direct') {
      for (const m of conv.members) {
        if (m !== me && Store.visibleTo(msg, m)) {
          notify(m, 'conversation:new', { conversation: store.summarize(conv, m), users: usersFor(conv.members, m) });
        }
      }
    }
    return postMessage(conv, msg);
  };

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

  const conversationView = (me, conv) => ({ ...store.summarize(conv, me), activeCall: calls?.activeCallFor(conv.id) || null });

  const actions = {
    me(me) {
      return { user: store.publicUser(me), iceServers, blocked: store.blockedList(me) };
    },

    updateProfile(me, { displayName, about }) {
      const user = store.updateProfile(me, { displayName, about });
      notify(me, 'user:updated', { user: { ...user, online: isOnline(me) } });
      for (const p of peersOf(me)) notify(p, 'user:updated', { user: userView(me, p) });
      return { user };
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

    conversations(me) {
      const conversations = store.conversationsFor(me).map((c) => conversationView(me, c));
      const people = new Set();
      conversations.forEach((c) => c.members.forEach((m) => people.add(m)));
      return { conversations, users: usersFor(people, me) };
    },

    getConversation(me, { convId }) {
      const conv = member(me, convId);
      return { conversation: conversationView(me, conv), users: usersFor(conv.members, me) };
    },

    openDirect(me, { username }) {
      const conv = store.getOrCreateDirect(me, String(username || '').toLowerCase());
      return { conversation: conversationView(me, conv) };
    },

    createGroup(me, { name, members }) {
      const conv = store.createGroup(me, name, members);
      for (const m of conv.members) {
        notify(m, 'conversation:new', { conversation: store.summarize(conv, m), users: usersFor(conv.members, m) });
      }
      return { conversation: conversationView(me, conv) };
    },

    /** Newest `limit` messages (before `before`, a timestamp, for older pages). */
    messages(me, { convId, before, limit }) {
      member(me, convId);
      const n = Math.max(1, Math.min(PAGE_MAX, Number(limit) || 50));
      const page = store.getMessages(convId, me, { before: Number(before) || undefined, limit: n + 1 });
      const hasMore = page.length > n;
      const messages = hasMore ? page.slice(1) : page;
      return { messages, hasMore, nextBefore: hasMore ? messages[0].ts : null };
    },

    sendText(me, { convId, text, masked, clientId }) {
      member(me, convId);
      return { message: sendMessage(me, convId, text, { masked: !!masked, clientId }) };
    },

    sendVoice(me, { convId, clientId, duration, mime, data }) {
      member(me, convId);
      const dup = store.findByClientId(convId, me, clientId);
      if (dup) return { message: store.viewFor(dup, me) };
      if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('Recording is empty');
      if (data.length > VOICE_MAX_BYTES) throw new ApiError(413, 'too_large', 'Recording is too large');
      mime = String(mime || '').split(';')[0].trim();
      if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) throw new ApiError(415, 'unsupported_media_type', 'Unsupported audio format');
      duration = Math.min(Number(duration) || 0, VOICE_MAX_SECONDS);
      const mediaId = store.saveMedia(convId, data, mime);
      try {
        return { message: sendMessage(me, convId, '', { clientId, voice: { mediaId, duration, mime } }) };
      } catch (err) {
        store.deleteMedia(mediaId);
        throw err;
      }
    },

    markRead(me, { convId }) {
      member(me, convId);
      const changed = store.markRead(convId, me);
      notifyStatus(convId, changed);
      return { updated: changed.length };
    },

    deleteMessage(me, { id }) {
      const { convId, message } = store.deleteMessage(id, me);
      notifyMembers(store.getConversation(convId), 'message:deleted', { convId, id: message.id });
      return {};
    },

    star(me, { id, starred }) {
      const { convId, message } = store.setStarred(id, me, !!starred);
      // Stars are private: only my own devices hear about it.
      notify(me, 'message:starred', { convId, id: message.id, starred: !!message.starred });
      return { message };
    },

    starred(me) {
      return { messages: store.starredFor(me) };
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
    replyStatus(me, { id, text, clientId }) {
      const status = store.data.statuses[id];
      if (!store.canSeeStatus(status, me) || status.owner === me) throw new ApiError(404, 'not_found', 'Status not found');
      const conv = store.getOrCreateDirect(me, status.owner);
      const preview = status.type === 'text' ? status.text.slice(0, 120) : status.caption.slice(0, 120);
      const message = sendMessage(me, conv.id, text, {
        clientId,
        statusReply: { statusId: status.id, owner: status.owner, type: status.type, preview, ...(status.bg ? { bg: status.bg } : {}) },
      });
      return { message, conversation: conversationView(me, conv) };
    },

    activeCall(me, { convId }) {
      member(me, convId);
      return { call: calls?.activeCallFor(convId) || null };
    },
  };

  return {
    actions,
    notify,
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
