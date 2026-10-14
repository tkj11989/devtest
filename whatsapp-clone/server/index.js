'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');
const { Store } = require('./store');
const { createCallManager } = require('./calls');
const { createService } = require('./service');
const { createWebhookDispatcher } = require('./webhooks');
const { createApiRouter } = require('./api');
const { createOtpService, createOtpSender } = require('./otp');
const { createAuth } = require('./auth');

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

/**
 * Socket.IO event -> service action. The web app uses these; other platforms can
 * use the same events (see README), or the REST API in api.js.
 */
const SOCKET_ACTIONS = {
  me: 'me',
  conversations: 'conversations',
  'users:search': 'searchUsers',
  'user:block': 'block',
  'chat:direct': 'openDirect',
  'group:create': 'createGroup',
  'messages:get': 'messages',
  'message:send': 'sendText',
  'voice:send': 'sendVoice',
  'message:star': 'star',
  'messages:starred': 'starred',
  'messages:read': 'markRead',
  'message:delete': 'deleteMessage',
  typing: 'typing',
  'profile:update': 'updateProfile',
  statuses: 'statuses',
  'status:post': 'postStatus',
  'status:view': 'viewStatus',
  'status:delete': 'deleteStatus',
  'status:reply': 'replyStatus',
  'chatlock:settings': 'lockSettings',
  'chatlock:set-code': 'setLockCode',
  'chatlock:reset-code': 'resetLockCode',
  'chatlock:lock': 'lockChat',
  'chatlock:remove': 'removeChatLock',
  'chatlock:unlock': 'unlockChat',
  'chatlock:relock': 'relock',
  'chat:disappearing': 'setDisappearing',
  'settings:default-disappear': 'setDefaultDisappear',
  'business:get': 'business',
  'business:set': 'setBusiness',
  'business:remove': 'removeBusiness',
  'me:contact-code': 'requestContactCode',
  'me:contact-verify': 'verifyContact',
  'chatlock:reset-sms': 'requestLockResetCode',
  'chatlock:clear': 'clearChatLocks',
  'hidden:hide': 'hideChat',
  'hidden:unhide': 'unhideChat',
  'hidden:reveal': 'revealHidden',
  'hidden:list': 'listHidden',
  'hidden:close': 'hideAgain',
  'hidden:clear': 'clearHidden',
  'biometric:challenge': 'biometricChallenge',
  'biometric:add': 'addBiometric',
  'biometric:remove': 'removeBiometric',
};

/**
 * Options:
 *   store            data store (defaults to data/db.json)
 *   tls              { key, cert } to serve HTTPS
 *   iceServers       STUN/TURN servers handed to browsers
 *   ringTimeoutMs    how long calls ring
 *   webhooks         { allowPrivate, retryDelaysMs } for webhook delivery
 *   rateLimit        { windowMs, max, authMax } for the REST API
 *   corsOrigins      allowed origins for the REST API ('*' or a list)
 *   messageSweepMs   how often expired disappearing messages are removed
 *   otp              { sender, exposeCodes, ttlMs, resendMs, … } for one-time login codes
 *                    (see otp.js; by default codes go to OTP_WEBHOOK_URL or the console)
 */
function createApp({
  store = new Store(),
  tls = null,
  iceServers = iceServersFromEnv(),
  ringTimeoutMs,
  webhooks: webhookOptions = { allowPrivate: process.env.WEBHOOKS_ALLOW_PRIVATE === '1' },
  rateLimit,
  corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()) : '*',
  messageSweepMs = 5000,
  otp: otpOptions = {},
} = {}) {
  const app = express();
  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  // Voice messages and status photos are uploaded over the socket.
  const io = new Server(server, { maxHttpBufferSize: 4 * 1024 * 1024 });

  // username -> number of connected sockets
  const online = new Map();
  const isOnline = (u) => (online.get(u) || 0) > 0;

  const webhooks = createWebhookDispatcher({ store, ...webhookOptions });
  const otp = createOtpService({ sender: createOtpSender(), exposeCodes: process.env.OTP_DEV_CODES === '1', ...otpOptions });
  const auth = createAuth({ store, otp });
  const service = createService({ store, io, isOnline, webhooks, iceServers, otp });
  const { actions } = service;

  // Wrap a handler so thrown errors are returned through the ack callback.
  const handle = (fn) => async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...(await fn(payload || {})) });
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  };

  const calls = createCallManager({ io, store, isOnline, notify: service.notify, postMessage: service.postMessage, handle, ringTimeoutMs });
  service.setCalls(calls);

  // Public REST API for other platforms (see /api/docs). It parses its own bodies.
  app.use('/api/v1', createApiRouter({ store, service, accounts: auth, webhooks, rateLimit, corsOrigins }));
  app.get('/api/docs', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'api-docs.html')));
  // Swagger UI is served from node_modules so the docs work without internet access.
  app.use('/api/docs/assets', express.static(require('swagger-ui-dist').getAbsoluteFSPath(), { maxAge: '7d' }));

  app.use(express.json({ limit: '50kb' }));

  // Icons rarely change; let browsers keep them so they still render while offline.
  app.use('/icons', express.static(path.join(__dirname, '..', 'public', 'icons'), { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const bearer = (req) => req.get('authorization')?.replace(/^Bearer /, '');

  app.post('/api/logout', (req, res) => {
    store.logout(bearer(req));
    service.forgetUnlocks({ credential: bearer(req) });
    res.json({ ok: true });
  });

  // Voice-message audio and status photos, for those allowed to see them.
  app.get('/media/:id', (req, res) => {
    const username = store.userForToken(bearer(req));
    if (!username) return res.status(401).end();
    const media = store.getMedia(req.params.id, username);
    if (!media) return res.status(404).end();
    // Voice notes from a locked chat need it unlocked in this app session.
    const ctx = { lockKey: service.lockKeyFor(username, bearer(req), req.get('x-app-session')) };
    if (!service.mediaAllowed(username, req.params.id, ctx)) return res.status(423).end();
    res.set({ 'Content-Type': media.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(media.buffer);
  });

  // Expired status updates disappear for everyone.
  const pruneTimer = setInterval(() => {
    for (const s of store.pruneStatuses()) service.broadcastStatus(s, 'status:deleted');
  }, 60 * 1000);
  pruneTimer.unref();
  // Disappearing messages: remove them as soon as their timer runs out.
  const expiryTimer = setInterval(() => service.pruneExpired(), messageSweepMs);
  expiryTimer.unref();
  server.on('close', () => {
    clearInterval(pruneTimer);
    clearInterval(expiryTimer);
    webhooks.stop();
    otp.stop();
  });

  // ---------- realtime ----------

  // Accepts a login session token or an API key.
  io.use((socket, next) => {
    const username = store.userForToken(socket.handshake.auth?.token);
    if (!username) return next(new Error('unauthorized'));
    socket.data.username = username;
    // One page load of the web app = one app session for chat lock (survives reconnects, not reloads).
    socket.data.lockKey = service.lockKeyFor(username, socket.handshake.auth.token, socket.handshake.auth.appSession);
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.data.username;
    socket.join(service.userRoom(me));
    online.set(me, (online.get(me) || 0) + 1);
    if (online.get(me) === 1) service.broadcastPresence(me);

    // Anything sent while we were offline is now delivered.
    for (const c of store.conversationsFor(me)) service.notifyStatus(c.id, store.markDelivered(c.id, me));

    calls.attach(socket);
    const ctx = { lockKey: socket.data.lockKey };
    for (const [event, action] of Object.entries(SOCKET_ACTIONS)) {
      socket.on(event, handle((payload) => actions[action](me, payload, ctx)));
    }

    socket.on('disconnect', () => {
      // Closing the last tab of an app session locks its chats again.
      const stillOpen = [...io.sockets.sockets.values()].some((s) => s.data.lockKey === ctx.lockKey);
      if (!stillOpen && socket.handshake.auth.appSession) service.forgetUnlocks({ lockKey: ctx.lockKey });
      const n = (online.get(me) || 1) - 1;
      if (n <= 0) {
        online.delete(me);
        store.touchLastSeen(me);
        service.broadcastPresence(me);
      } else {
        online.set(me, n);
      }
    });
  });

  return { app, server, io, store, calls, service, webhooks, otp };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  // Browsers only allow camera/microphone on https:// or localhost, so serve
  // HTTPS when a certificate is provided (needed to call from other devices).
  const tls = process.env.SSL_KEY && process.env.SSL_CERT
    ? { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }
    : null;
  const { server, store } = createApp({ tls });
  server.listen(port, () => {
    console.log(`ChatApp running at ${tls ? 'https' : 'http'}://localhost:${port}`);
    if (!process.env.OTP_WEBHOOK_URL) console.log('Login codes are printed here (set OTP_WEBHOOK_URL to send real SMS/email).');
    if (process.env.OTP_DEV_CODES === '1') console.warn('OTP_DEV_CODES=1: login codes are also shown in the app. Never use this in production.');
  });
  const shutdown = () => {
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
