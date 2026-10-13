'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');
const { Store } = require('./store');
const { createCallManager } = require('./calls');

// STUN/TURN servers handed to browsers for WebRTC. Override with a JSON array,
// e.g. ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
function iceServersFromEnv() {
  if (process.env.ICE_SERVERS) {
    try {
      return JSON.parse(process.env.ICE_SERVERS);
    } catch (err) {
      console.error('Invalid ICE_SERVERS JSON, using defaults:', err.message);
    }
  }
  return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
}

function createApp({ store = new Store(), tls = null, iceServers = iceServersFromEnv(), ringTimeoutMs } = {}) {
  const app = express();
  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  // Voice messages are uploaded over the socket.
  const io = new Server(server, { maxHttpBufferSize: 4 * 1024 * 1024 });

  // username -> number of connected sockets
  const online = new Map();
  const isOnline = (u) => (online.get(u) || 0) > 0;

  app.use(express.json({ limit: '50kb' }));
  // Icons rarely change; let browsers keep them so they still render while offline.
  app.use('/icons', express.static(path.join(__dirname, '..', 'public', 'icons'), { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.post('/api/register', (req, res) => {
    try {
      const { username, password, displayName } = req.body || {};
      res.json(store.register(username, password, displayName));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/login', (req, res) => {
    try {
      const { username, password } = req.body || {};
      res.json(store.login(username, password));
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  const bearer = (req) => req.get('authorization')?.replace(/^Bearer /, '');

  app.post('/api/logout', (req, res) => {
    store.logout(bearer(req));
    res.json({ ok: true });
  });

  // Voice-message audio, for members of the chat it was sent in.
  app.get('/media/:id', (req, res) => {
    const username = store.userForToken(bearer(req));
    if (!username) return res.status(401).end();
    const media = store.getMedia(req.params.id, username);
    if (!media) return res.status(404).end();
    res.set({ 'Content-Type': media.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(media.buffer);
  });

  // ---------- realtime ----------

  io.use((socket, next) => {
    const username = store.userForToken(socket.handshake.auth?.token);
    if (!username) return next(new Error('unauthorized'));
    socket.data.username = username;
    next();
  });

  const userRoom = (u) => `user:${u}`;

  const emitToMembers = (conv, event, payload) => {
    for (const m of conv.members) io.to(userRoom(m)).emit(event, payload);
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
    for (const m of recipients) io.to(userRoom(m)).emit('message:new', { message: store.viewFor(msg, m) });
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
          io.to(userRoom(m)).emit('conversation:new', { conversation: store.summarize(conv, m), users: usersFor(conv.members, m) });
        }
      }
    }
    return postMessage(conv, msg);
  };

  const statusPayload = (msgs) =>
    msgs.map((m) => ({ id: m.id, deliveredTo: m.deliveredTo, readBy: m.readBy }));

  /** Notify message senders that their messages' delivery/read status changed. */
  const notifyStatus = (convId, changed) => {
    if (!changed.length) return;
    const conv = store.getConversation(convId);
    if (conv) emitToMembers(conv, 'message:status', { convId, messages: statusPayload(changed) });
  };

  const peersOf = (u) => {
    const peers = new Set();
    for (const c of store.conversationsFor(u)) c.members.forEach((m) => m !== u && peers.add(m));
    return peers;
  };

  const broadcastPresence = (u) => {
    for (const p of peersOf(u)) {
      const { online: isOn, lastSeen } = userView(u, p);
      io.to(userRoom(p)).emit('presence', { username: u, online: isOn, lastSeen });
    }
  };

  // Wrap a handler so thrown errors are returned through the ack callback.
  const handle = (fn) => async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...(await fn(payload || {})) });
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  };

  const calls = createCallManager({ io, store, isOnline, userRoom, postMessage, handle, ringTimeoutMs });

  const VOICE_MAX_BYTES = 3 * 1024 * 1024;
  const VOICE_MAX_SECONDS = 5 * 60;

  io.on('connection', (socket) => {
    const me = socket.data.username;
    socket.join(userRoom(me));
    online.set(me, (online.get(me) || 0) + 1);
    if (online.get(me) === 1) broadcastPresence(me);

    // Anything sent while we were offline is now delivered.
    for (const c of store.conversationsFor(me)) notifyStatus(c.id, store.markDelivered(c.id, me));

    calls.attach(socket);

    socket.on('me', handle(() => ({ user: store.publicUser(me), iceServers, blocked: store.blockedList(me) })));

    socket.on('conversations', handle(() => {
      const conversations = store.conversationsFor(me).map((c) => ({ ...c, activeCall: calls.activeCallFor(c.id) }));
      const people = new Set();
      conversations.forEach((c) => c.members.forEach((m) => people.add(m)));
      return { conversations, users: usersFor(people, me) };
    }));

    socket.on('users:search', handle(({ q }) => ({
      users: store.searchUsers(q, me).map((u) => userView(u.username, me)),
    })));

    socket.on('user:block', handle(({ username, blocked }) => {
      const target = String(username || '').toLowerCase();
      const list = store.setBlocked(me, target, !!blocked);
      // Sync my other devices, and refresh what each side sees of the other's presence.
      io.to(userRoom(me)).emit('blocked:update', { blocked: list });
      const theirView = userView(me, target);
      io.to(userRoom(target)).emit('presence', { username: me, online: theirView.online, lastSeen: theirView.lastSeen });
      return { blocked: list, user: userView(target, me) };
    }));

    socket.on('chat:direct', handle(({ username }) => {
      const conv = store.getOrCreateDirect(me, String(username || '').toLowerCase());
      const summary = store.summarize(conv, me);
      return { conversation: summary };
    }));

    socket.on('group:create', handle(({ name, members }) => {
      const conv = store.createGroup(me, name, members);
      for (const m of conv.members) {
        io.to(userRoom(m)).emit('conversation:new', { conversation: store.summarize(conv, m), users: usersFor(conv.members, m) });
      }
      return { conversation: store.summarize(conv, me) };
    }));

    socket.on('messages:get', handle(({ convId, before }) => ({
      messages: store.getMessages(convId, me, { before }),
    })));

    socket.on('message:send', handle(({ convId, text, masked, clientId }) => ({
      message: sendMessage(me, convId, text, { masked: !!masked, clientId }),
    })));

    socket.on('voice:send', handle(({ convId, clientId, duration, mime, data }) => {
      if (!store.isMember(convId, me)) throw new Error('Not a member of this chat');
      const dup = store.findByClientId(convId, me, clientId);
      if (dup) return { message: store.viewFor(dup, me) };
      if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('Recording is empty');
      if (data.length > VOICE_MAX_BYTES) throw new Error('Recording is too large');
      mime = String(mime || '').split(';')[0];
      if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) throw new Error('Unsupported audio format');
      duration = Math.min(Number(duration) || 0, VOICE_MAX_SECONDS);
      const mediaId = store.saveMedia(convId, data, mime);
      try {
        return { message: sendMessage(me, convId, '', { clientId, voice: { mediaId, duration, mime } }) };
      } catch (err) {
        store.deleteMedia(mediaId);
        throw err;
      }
    }));

    socket.on('message:star', handle(({ id, starred }) => {
      const { convId, message } = store.setStarred(id, me, !!starred);
      // Stars are private: only my own devices hear about it.
      io.to(userRoom(me)).emit('message:starred', { convId, id: message.id, starred: !!message.starred });
      return { message };
    }));

    socket.on('messages:starred', handle(() => ({ messages: store.starredFor(me) })));

    socket.on('messages:read', handle(({ convId }) => {
      notifyStatus(convId, store.markRead(convId, me));
      return {};
    }));

    socket.on('message:delete', handle(({ id }) => {
      const { convId, message } = store.deleteMessage(id, me);
      emitToMembers(store.getConversation(convId), 'message:deleted', { convId, id: message.id });
      return {};
    }));

    // What I'm doing in a chat: 'typing' or 'recording' (a voice message); isTyping=false clears it.
    socket.on('typing', ({ convId, isTyping, activity } = {}) => {
      const conv = store.getConversation(convId);
      if (!conv || !conv.members.includes(me)) return;
      activity = activity === 'recording' ? 'recording' : 'typing';
      for (const m of conv.members) {
        if (m === me || (conv.type === 'direct' && store.blockedEither(me, m))) continue;
        io.to(userRoom(m)).emit('typing', { convId, username: me, isTyping: !!isTyping, activity });
      }
    });

    socket.on('profile:update', handle(({ displayName, about }) => {
      const user = store.updateProfile(me, { displayName, about });
      io.to(userRoom(me)).emit('user:updated', { user: { ...user, online: true } });
      for (const p of peersOf(me)) io.to(userRoom(p)).emit('user:updated', { user: userView(me, p) });
      return { user };
    }));

    socket.on('disconnect', () => {
      const n = (online.get(me) || 1) - 1;
      if (n <= 0) {
        online.delete(me);
        store.touchLastSeen(me);
        broadcastPresence(me);
      } else {
        online.set(me, n);
      }
    });
  });

  return { app, server, io, store, calls };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  // Browsers only allow camera/microphone on https:// or localhost, so serve
  // HTTPS when a certificate is provided (needed to call from other devices).
  const tls = process.env.SSL_KEY && process.env.SSL_CERT
    ? { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }
    : null;
  const { server, store } = createApp({ tls });
  server.listen(port, () => console.log(`ChatApp running at ${tls ? 'https' : 'http'}://localhost:${port}`));
  const shutdown = () => {
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
