'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Simple JSON-file backed data store for users, conversations and messages.
 * Everything is kept in memory and flushed to disk (debounced) on change.
 * Pass `file: null` to keep data in memory only (used by tests).
 */
class Store {
  constructor({ file } = {}) {
    this.file = file === undefined ? path.join(__dirname, '..', 'data', 'db.json') : file;
    this.data = { users: {}, conversations: {}, messages: {}, media: {} };
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
      this.data = { users: {}, conversations: {}, messages: {}, media: {}, ...parsed };
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

  login(username, password) {
    username = String(username || '').trim().toLowerCase();
    const user = this.data.users[username];
    if (!user) throw new Error('Invalid username or password');
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

  userForToken(token) {
    return this.sessions.get(token) || null;
  }

  logout(token) {
    this.sessions.delete(token);
  }

  publicUser(username) {
    const u = this.data.users[username];
    if (!u) return null;
    return { username: u.username, displayName: u.displayName, about: u.about, lastSeen: u.lastSeen };
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

  updateProfile(username, { displayName, about }) {
    const u = this.data.users[username];
    if (!u) throw new Error('No such user');
    if (typeof displayName === 'string' && displayName.trim()) u.displayName = displayName.trim().slice(0, 40);
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
    return Object.values(this.data.users)
      .filter((u) => u.username !== exclude)
      .filter((u) => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q))
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

  summarize(conv, username) {
    const msgs = (this.data.messages[conv.id] || []).filter((m) => Store.visibleTo(m, username));
    const unread = msgs.filter((m) => m.from !== username && !m.readBy.includes(username)).length;
    const last = msgs[msgs.length - 1];
    return {
      ...conv,
      lastMessage: last ? this.viewFor(last, username) : null,
      unread,
    };
  }

  /** Messages from someone `username` has blocked are stored but never shown to them. */
  static visibleTo(msg, username) {
    return !msg.hiddenFor?.includes(username);
  }

  /** A message as `username` may see it: per-user fields are reduced to their own view. */
  viewFor(msg, username) {
    const { starredBy, hiddenFor, ...rest } = msg;
    if (starredBy?.includes(username)) rest.starred = true;
    return rest;
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

  saveMedia(convId, buffer, mime) {
    const id = crypto.randomBytes(12).toString('hex');
    if (this.mediaDir) {
      fs.mkdirSync(this.mediaDir, { recursive: true });
      fs.writeFileSync(path.join(this.mediaDir, id), buffer);
    } else {
      this.memoryMedia.set(id, buffer);
    }
    this.data.media[id] = { convId, mime, size: buffer.length, createdAt: Date.now() };
    this._save();
    return id;
  }

  /** `{ mime, buffer }` if `username` may access the media, else null. */
  getMedia(id, username) {
    const meta = this.data.media[id];
    if (!meta || !this.isMember(meta.convId, username)) return null;
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
   */
  addMessage(convId, from, text, { masked = false, clientId, voice } = {}) {
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

    text = voice ? '' : String(text || '').trim();
    if (!voice && !text) throw new Error('Message is empty');
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
    if (masked && !voice) msg.masked = true;
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

  starredFor(username) {
    const out = [];
    for (const [convId, msgs] of Object.entries(this.data.messages)) {
      if (!this.isMember(convId, username)) continue;
      for (const m of msgs) if (m.starredBy?.includes(username) && !m.deleted) out.push(this.viewFor(m, username));
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
      delete m.masked;
      delete m.starredBy;
      this._save();
      return { convId, message: m };
    }
    throw new Error('Message not found');
  }
}

module.exports = { Store };
