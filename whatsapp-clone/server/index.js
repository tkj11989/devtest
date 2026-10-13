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
  const io = new Server(server);

  // username -> number of connected sockets
  const online = new Map();
  const isOnline = (u) => (online.get(u) || 0) > 0;

  app.use(express.json({ limit: '50kb' }));
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

  app.post('/api/logout', (req, res) => {
    store.logout(req.get('authorization')?.replace(/^Bearer /, ''));
    res.json({ ok: true });
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

  /** Mark a new message delivered to online members and push it to everyone in the chat. */
  const postMessage = (conv, msg) => {
    for (const m of conv.members) {
      if (m !== msg.from && isOnline(m)) msg.deliveredTo.push(m);
    }
    store._save();
    emitToMembers(conv, 'message:new', { message: msg });
    return msg;
  };

  const statusPayload = (msgs) =>
    msgs.map((m) => ({ id: m.id, deliveredTo: m.deliveredTo, readBy: m.readBy }));

  /** Notify message senders that their messages' delivery/read status changed. */
  const notifyStatus = (convId, changed) => {
    if (!changed.length) return;
    const conv = store.getConversation(convId);
    if (conv) emitToMembers(conv, 'message:status', { convId, messages: statusPayload(changed) });
  };

  const presenceFor = (u) => ({ username: u, online: isOnline(u), lastSeen: store.publicUser(u)?.lastSeen });

  const broadcastPresence = (u) => {
    const payload = presenceFor(u);
    const peers = new Set();
    for (const c of store.conversationsFor(u)) c.members.forEach((m) => m !== u && peers.add(m));
    for (const p of peers) io.to(userRoom(p)).emit('presence', payload);
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

  io.on('connection', (socket) => {
    const me = socket.data.username;
    socket.join(userRoom(me));
    online.set(me, (online.get(me) || 0) + 1);
    if (online.get(me) === 1) broadcastPresence(me);

    // Anything sent while we were offline is now delivered.
    for (const c of store.conversationsFor(me)) notifyStatus(c.id, store.markDelivered(c.id, me));

    calls.attach(socket);

    socket.on('me', handle(() => ({ user: store.publicUser(me), iceServers })));

    socket.on('conversations', handle(() => {
      const conversations = store.conversationsFor(me);
      const people = new Set();
      conversations.forEach((c) => c.members.forEach((m) => people.add(m)));
      const users = {};
      for (const u of people) users[u] = { ...store.publicUser(u), online: isOnline(u) };
      return { conversations, users };
    }));

    socket.on('users:search', handle(({ q }) => ({
      users: store.searchUsers(q, me).map((u) => ({ ...u, online: isOnline(u.username) })),
    })));

    socket.on('chat:direct', handle(({ username }) => {
      const conv = store.getOrCreateDirect(me, String(username || '').toLowerCase());
      const summary = store.summarize(conv, me);
      return { conversation: summary };
    }));

    socket.on('group:create', handle(({ name, members }) => {
      const conv = store.createGroup(me, name, members);
      const users = {};
      conv.members.forEach((u) => (users[u] = { ...store.publicUser(u), online: isOnline(u) }));
      for (const m of conv.members) {
        io.to(userRoom(m)).emit('conversation:new', { conversation: store.summarize(conv, m), users });
      }
      return { conversation: store.summarize(conv, me) };
    }));

    socket.on('messages:get', handle(({ convId, before }) => ({
      messages: store.getMessages(convId, me, { before }),
    })));

    socket.on('message:send', handle(({ convId, text, masked, clientId }) => {
      const conv = store.getConversation(convId);
      const isFirst = conv && (store.data.messages[convId] || []).length === 0;
      const count = (store.data.messages[convId] || []).length;
      const msg = store.addMessage(convId, me, text, { masked: !!masked, clientId });
      // A retried send of a message we already have: just acknowledge it again.
      if ((store.data.messages[convId] || []).length === count) return { message: msg };

      // A brand new direct chat appears in the recipient's list on first message.
      if (isFirst && conv.type === 'direct') {
        const users = {};
        conv.members.forEach((u) => (users[u] = { ...store.publicUser(u), online: isOnline(u) }));
        for (const m of conv.members) {
          if (m !== me) io.to(userRoom(m)).emit('conversation:new', { conversation: store.summarize(conv, m), users });
        }
      }

      return { message: postMessage(conv, msg) };
    }));

    socket.on('messages:read', handle(({ convId }) => {
      notifyStatus(convId, store.markRead(convId, me));
      return {};
    }));

    socket.on('message:delete', handle(({ id }) => {
      const { convId, message } = store.deleteMessage(id, me);
      emitToMembers(store.getConversation(convId), 'message:deleted', { convId, id: message.id });
      return {};
    }));

    socket.on('typing', ({ convId, isTyping } = {}) => {
      const conv = store.getConversation(convId);
      if (!conv || !conv.members.includes(me)) return;
      for (const m of conv.members) {
        if (m !== me) io.to(userRoom(m)).emit('typing', { convId, username: me, isTyping: !!isTyping });
      }
    });

    socket.on('profile:update', handle(({ displayName, about }) => {
      const user = store.updateProfile(me, { displayName, about });
      const peers = new Set();
      for (const c of store.conversationsFor(me)) c.members.forEach((m) => peers.add(m));
      for (const p of peers) io.to(userRoom(p)).emit('user:updated', { user: { ...user, online: true } });
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
