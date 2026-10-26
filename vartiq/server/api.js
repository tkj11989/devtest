'use strict';

const express = require('express');
const { ApiError } = require('./service');
const { buildOpenApiSpec } = require('./openapi');

/**
 * Public REST API, mounted at /api/v1.
 *
 * Auth: `Authorization: Bearer <token>` with a login session token (from
 * /auth/login) or an API key (from /api-keys). Errors are
 * `{ "error": { "code": "...", "message": "..." } }` with a matching HTTP status.
 *
 * Every write goes through the same service as the web app, so changes made
 * here appear live in connected apps and are delivered to webhooks.
 */
function createApiRouter({ store, service, accounts, webhooks, rateLimit = {}, corsOrigins = '*' }) {
  const router = express.Router();
  const { actions } = service;
  const limits = {
    windowMs: rateLimit.windowMs ?? 60 * 1000,
    max: rateLimit.max ?? (Number(process.env.API_RATE_LIMIT) || 120),
    authMax: rateLimit.authMax ?? 20,
  };

  // ---------- CORS (browser apps on other origins) ----------

  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && (corsOrigins === '*' || corsOrigins.includes(origin))) {
      res.set({
        'Access-Control-Allow-Origin': corsOrigins === '*' ? '*' : origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Expose-Headers': 'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After',
        'Access-Control-Max-Age': '600',
      });
      if (corsOrigins !== '*') res.vary('Origin');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // ---------- rate limiting (fixed window, in memory) ----------

  const buckets = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, limits.windowMs);
  sweep.unref();

  const limiter = (keyOf, max) => (req, res, next) => {
    const key = keyOf(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + limits.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const reset = Math.ceil((b.resetAt - now) / 1000);
    res.set({ 'RateLimit-Limit': String(max), 'RateLimit-Remaining': String(Math.max(0, max - b.count)), 'RateLimit-Reset': String(reset) });
    if (b.count > max) {
      res.set('Retry-After', String(reset));
      return next(new ApiError(429, 'rate_limited', 'Too many requests, slow down'));
    }
    next();
  };

  // ---------- helpers ----------

  const json = express.json({ limit: '50kb' });
  const bearer = (req) => req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  const auth = (req, res, next) => {
    try {
      service.assertAvailable(req.get('x-client-version'));
    } catch (err) {
      return next(err);
    }
    const token = bearer(req);
    const username = store.userForToken(token);
    if (!username) return next(new ApiError(401, 'unauthorized', 'Missing or invalid credentials. Send "Authorization: Bearer <token or API key>".'));
    if (String(token).startsWith('cak_') && !store.featureOn('developerApi')) {
      return next(new ApiError(403, 'feature_disabled', 'The developer API is turned off by the administrator'));
    }
    req.user = username;
    req.credential = token;
    // Chat lock: unlocks last for this credential (optionally narrowed with X-App-Session).
    req.ctx = { credential: token, lockKey: service.lockKeyFor(username, token, req.get('x-app-session')), origin: `${req.protocol}://${req.get('host')}` };
    next();
  };
  const authed = [auth, limiter((req) => `u:${req.credential}`, limits.max)];

  /** Run a service action and reply with its result (status 200, or 201 for creates). */
  const run = (fn, status = 200) => async (req, res, next) => {
    try {
      const result = await fn(req);
      if (result === undefined) return res.status(204).end();
      res.status(status).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** Clients may send an Idempotency-Key header instead of clientId to make retries safe. */
  const idempotency = (req) => req.body?.clientId ?? req.get('idempotency-key') ?? undefined;
  const p = (req, name) => req.params[name];
  /** The secret code, or a fingerprint/face proof, sent in the body. */
  const proof = (req) => ({ code: req.body?.code, biometric: req.body?.biometric });

  // ---------- meta ----------

  // Developer tools can be switched off by the administrator.
  router.use(['/api-keys', '/webhooks'], (req, res, next) => (store.featureOn('developerApi')
    ? next()
    : next(new ApiError(403, 'feature_disabled', 'The developer API is turned off by the administrator'))));

  // Anyone (signed in or not, web or mobile) reads this to know which features are on, maintenance and announcements.
  router.get('/config', (req, res) => res.json(service.config()));

  router.get('/health', (req, res) => res.json({ ok: true, version: 'v1', time: Date.now() }));
  router.get('/openapi.json', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
    res.json(buildOpenApiSpec({ serverUrl: base, webhookEvents: store.constructor.WEBHOOK_EVENTS }));
  });

  // ---------- auth ----------

  const authLimit = limiter((req) => `ip:${req.ip}`, limits.authMax);
  const open = (req, res, next) => {
    try {
      service.assertAvailable(req.get('x-client-version'));
      next();
    } catch (err) {
      next(err);
    }
  };
  router.post('/auth/otp', authLimit, open, json, run((req) => accounts.requestCode(req.body || {})));
  router.post('/auth/register', authLimit, open, json, run((req) => accounts.register(req.body || {}, { origin: `${req.protocol}://${req.get('host')}` }), 201));

  // ---------- parent or guardian ----------

  // The guardian's page works with the private link alone (no account). A wrong link is a plain 404, and tries are limited.
  const portal = service.guardianPortal;
  const guardianLimit = limiter((req) => `g:${req.ip}`, 60);
  router.get('/guardian/:token', guardianLimit, run((req) => portal.view(p(req, 'token'))));
  router.post('/guardian/:token/consent', guardianLimit, json, run((req) => portal.consent(p(req, 'token'), req.body || {})));
  router.put('/guardian/:token/controls', guardianLimit, json, run((req) => portal.controls(p(req, 'token'), req.body || {})));
  router.post('/guardian/:token/disable', guardianLimit, run((req) => portal.disable(p(req, 'token'))));
  router.post('/guardian/:token/enable', guardianLimit, run((req) => portal.enable(p(req, 'token'))));
  router.post('/guardian/:token/delete', guardianLimit, json, run((req) => portal.remove(p(req, 'token'), req.body || {})));
  router.post('/auth/login', authLimit, open, json, run((req) => accounts.login(req.body || {})));
  router.post('/auth/logout', ...authed, run((req) => {
    store.logout(req.credential);
    service.cutDeadSockets(req.user);
    service.forgetUnlocks({ credential: req.credential });
    return undefined;
  }));

  // ---------- me ----------

  router.get('/me', ...authed, run((req) => actions.me(req.user, {}, req.ctx)));
  router.patch('/me', ...authed, json, run((req) => actions.updateProfile(req.user, req.body || {})));
  // ---------- public channels ----------

  router.get('/channels', ...authed, run((req) => actions.channelsSearch(req.user, { q: req.query.q })));
  router.post('/channels', ...authed, json, run((req) => actions.channelCreate(req.user, req.body || {}), 201));
  router.get('/me/channels', ...authed, run((req) => actions.channelsMine(req.user)));
  router.get('/channels/:id', ...authed, run((req) => actions.channelGet(req.user, { id: p(req, 'id') })));
  router.patch('/channels/:id', ...authed, json, run((req) => actions.channelUpdate(req.user, { ...(req.body || {}), id: p(req, 'id') })));
  router.delete('/channels/:id', ...authed, run((req) => { actions.channelDelete(req.user, { id: p(req, 'id') }); return undefined; }));
  router.put('/channels/:id/follow', ...authed, run((req) => actions.channelFollow(req.user, { id: p(req, 'id') })));
  router.delete('/channels/:id/follow', ...authed, run((req) => actions.channelUnfollow(req.user, { id: p(req, 'id') })));
  router.put('/channels/:id/admins/:username', ...authed, run((req) => actions.channelAdmin(req.user, { id: p(req, 'id'), username: p(req, 'username'), admin: true })));
  router.delete('/channels/:id/admins/:username', ...authed, run((req) => actions.channelAdmin(req.user, { id: p(req, 'id'), username: p(req, 'username'), admin: false })));
  router.get('/channels/:id/posts', ...authed, run((req) => actions.channelPosts(req.user, { id: p(req, 'id'), before: req.query.before, limit: req.query.limit })));
  router.post('/channels/:id/posts', ...authed, json, run((req) => actions.channelPost(req.user, { id: p(req, 'id'), text: req.body?.text }), 201));
  router.delete('/channels/:id/posts/:postId', ...authed, run((req) => { actions.channelPostDelete(req.user, { id: p(req, 'id'), postId: p(req, 'postId') }); return undefined; }));
  router.post('/channels/:id/read', ...authed, run((req) => { actions.channelRead(req.user, { id: p(req, 'id') }); return undefined; }));
  router.post('/channels/:id/report', ...authed, json, run((req) => { actions.channelReport(req.user, { id: p(req, 'id'), reason: req.body?.reason }); return undefined; }));

  // ---------- product catalogue ----------

  router.get('/users/:username/catalogue', ...authed, run((req) => actions.catalogue(req.user, { username: p(req, 'username') })));
  router.get('/me/catalogue', ...authed, run((req) => actions.catalogue(req.user, {})));
  router.put('/me/catalogue/currency', ...authed, json, run((req) => actions.setCatalogueCurrency(req.user, { currency: req.body?.currency })));
  router.post('/me/catalogue/products', ...authed, json, run((req) => actions.saveProduct(req.user, { ...(req.body || {}), id: undefined }), 201));
  router.put('/me/catalogue/products/:id', ...authed, json, run((req) => actions.saveProduct(req.user, { ...(req.body || {}), id: p(req, 'id') })));
  router.delete('/me/catalogue/products/:id', ...authed, run((req) => { actions.deleteProduct(req.user, { id: p(req, 'id') }); return undefined; }));
  router.put('/me/catalogue/products/:id/image', ...authed, express.raw({ type: 'image/*', limit: '1mb' }),
    run((req) => actions.setProductImage(req.user, { id: p(req, 'id'), data: req.body, mime: req.get('content-type') })));
  router.delete('/me/catalogue/products/:id/image', ...authed, run((req) => actions.removeProductImage(req.user, { id: p(req, 'id') })));

  // Colour themes, app icons and avatar shapes (the catalogue is public so apps can apply the colours).
  router.get('/appearance', (req, res) => res.json(require('./appearance').catalogue()));
  router.get('/me/appearance', ...authed, run((req) => actions.appearance(req.user)));
  router.put('/me/appearance', ...authed, json, run((req) => actions.setAppearance(req.user, req.body)));
  // Terms of Use, Privacy Notice and consent; download or delete your data.
  const legal = require('./legal');
  router.get('/legal', (req, res) => res.json(legal.summary(store.getSettings())));
  router.get('/legal/:doc', (req, res) => {
    const doc = legal.documentData(req.params.doc, legal.details(store.getSettings()));
    if (!doc) return res.status(404).json({ error: { code: 'not_found', message: 'No such document' } });
    return res.json(doc);
  });
  router.get('/me/consent', ...authed, run((req) => actions.consentStatus(req.user)));
  router.post('/me/consent', ...authed, json, run((req) => actions.consentAccept(req.user, req.body || {})));
  router.put('/me/consent/:id', ...authed, json, run((req) => actions.consentSet(req.user, { id: p(req, 'id'), granted: req.body?.granted })));
  router.get('/me/export', ...authed, (req, res, next) => {
    try {
      const data = actions.accountExport(req.user);
      res.set('Content-Disposition', `attachment; filename="vartiq-${req.user}-data.json"`);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });
  router.post('/me/delete/code', ...authed, json, run((req) => actions.accountDeleteCode(req.user)));
  router.delete('/me', ...authed, json, run((req) => actions.accountDelete(req.user, req.body || {})));
  router.get('/translate/languages', ...authed, run((req) => actions.translateLanguages(req.user)));
  router.put('/conversations/:id/translation', ...authed, json, run((req) => actions.setTranslation(req.user, { convId: p(req, 'id'), lang: req.body?.lang })));
  router.post('/conversations/:id/translate', ...authed, json, run((req) => actions.translateTexts(req.user, { convId: p(req, 'id'), texts: req.body?.texts }, req.ctx)));
  router.post('/users/:username/view', ...authed, run((req) => { actions.viewProfile(req.user, { username: p(req, 'username') }); return undefined; }));
  router.get('/me/profile-views', ...authed, run((req) => actions.profileViews(req.user)));
  router.put('/me/privacy', ...authed, json, run((req) => actions.setProfileViews(req.user, { enabled: req.body?.profileViews })));
  router.get('/me/subscription', ...authed, run((req) => actions.subscriptionStatus(req.user)));
  router.post('/me/subscription/checkout', ...authed, json, run((req) => actions.subscriptionCheckout(req.user, { plan: req.body?.plan }, req.ctx)));
  router.get('/me/payments', ...authed, run((req) => actions.paymentHistory(req.user)));
  router.post('/me/subscription/confirm', ...authed, json, run((req) => actions.subscriptionConfirm(req.user, { orderId: req.body?.orderId })));
  router.get('/me/verification', ...authed, run((req) => actions.kycStatus(req.user)));
  router.post('/me/verification/otp', ...authed, json, run((req) => actions.kycStart(req.user, req.body || {})));
  router.post('/me/verification', ...authed, json, run((req) => actions.kycVerify(req.user, { requestId: req.body?.requestId, otp: req.body?.otp })));
  router.post('/me/contact/otp', ...authed, json, run((req) => actions.requestContactCode(req.user, req.body || {})));
  router.put('/me/contact', ...authed, json, run((req) => actions.verifyContact(req.user, req.body || {})));

  router.put('/me/default-disappearing', ...authed, json, run((req) => actions.setDefaultDisappear(req.user, { seconds: req.body?.seconds })));

  // ---------- business profile ----------

  router.get('/me/business', ...authed, run((req) => actions.business(req.user)));
  router.put('/me/business', ...authed, json, run((req) => actions.setBusiness(req.user, req.body || {})));
  router.delete('/me/business', ...authed, run((req) => actions.removeBusiness(req.user)));

  // ---------- API keys ----------

  router.get('/api-keys', ...authed, run((req) => ({ apiKeys: store.listApiKeys(req.user) })));
  router.post('/api-keys', ...authed, json, run((req) => {
    // A leaked key must not be able to mint more keys: creating keys needs a login session.
    if (req.credential.startsWith(store.constructor.API_KEY_PREFIX)) {
      throw new ApiError(403, 'forbidden', 'Create API keys with a login session token, not another API key');
    }
    return store.createApiKey(req.user, req.body?.name);
  }, 201));
  router.delete('/api-keys/:id', ...authed, run((req) => {
    store.revokeApiKey(req.user, p(req, 'id'));
    return undefined;
  }));

  // ---------- webhooks ----------

  router.get('/webhooks', ...authed, run((req) => ({ webhooks: store.listWebhooks(req.user), events: store.constructor.WEBHOOK_EVENTS })));
  router.post('/webhooks', ...authed, json, run((req) => store.createWebhook(req.user, req.body || {}), 201));
  router.get('/webhooks/:id', ...authed, run((req) => {
    const { secret, ...webhook } = store.getWebhook(req.user, p(req, 'id'));
    return { webhook };
  }));
  router.patch('/webhooks/:id', ...authed, json, run((req) => ({ webhook: store.updateWebhook(req.user, p(req, 'id'), req.body || {}) })));
  router.delete('/webhooks/:id', ...authed, run((req) => {
    store.deleteWebhook(req.user, p(req, 'id'));
    return undefined;
  }));
  router.post('/webhooks/:id/test', ...authed, run(async (req) => {
    const hook = store.getWebhook(req.user, p(req, 'id'));
    return { result: await webhooks.ping(hook) };
  }));

  // ---------- users & blocking ----------

  router.get('/users', ...authed, run((req) => actions.searchUsers(req.user, { q: req.query.q }, req.ctx)));
  router.get('/users/:username', ...authed, run((req) => actions.getUser(req.user, { username: p(req, 'username') }, req.ctx)));
  router.get('/blocked', ...authed, run((req) => actions.blocked(req.user, {}, req.ctx)));
  router.put('/blocked/:username', ...authed, run((req) => actions.block(req.user, { username: p(req, 'username'), blocked: true }, req.ctx)));
  router.delete('/blocked/:username', ...authed, run((req) => actions.block(req.user, { username: p(req, 'username'), blocked: false }, req.ctx)));

  // ---------- conversations & messages ----------

  router.get('/conversations', ...authed, run((req) => actions.conversations(req.user, {}, req.ctx)));
  router.post('/conversations', ...authed, json, run((req) => {
    const { type, username, name, members } = req.body || {};
    if (type === 'group') return actions.createGroup(req.user, { name, members }, req.ctx);
    if (type === 'direct' || (!type && username)) return actions.openDirect(req.user, { username }, req.ctx);
    throw new ApiError(400, 'bad_request', 'type must be "direct" (with username) or "group" (with name and members)');
  }, 201));
  router.get('/conversations/:id', ...authed, run((req) => actions.getConversation(req.user, { convId: p(req, 'id') }, req.ctx)));
  router.get('/conversations/:id/messages', ...authed, run((req) => actions.messages(req.user, {
    convId: p(req, 'id'),
    before: req.query.before,
    limit: req.query.limit,
  }, req.ctx)));
  router.post('/conversations/:id/messages', ...authed, json, run((req) => {
    const { text, masked } = req.body || {};
    return actions.sendText(req.user, { convId: p(req, 'id'), text, masked, clientId: idempotency(req), e2ee: req.body?.e2ee }, req.ctx);
  }, 201));
  router.post('/conversations/:id/voice', ...authed,
    express.raw({ type: () => true, limit: '3mb' }),
    run((req) => actions.sendVoice(req.user, {
      convId: p(req, 'id'),
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      mime: req.get('content-type'),
      duration: req.query.duration,
      clientId: req.query.clientId ?? req.get('idempotency-key'),
    }, req.ctx), 201));
  router.post('/conversations/:id/read', ...authed, run((req) => actions.markRead(req.user, { convId: p(req, 'id') }, req.ctx)));
  router.post('/conversations/:id/typing', ...authed, json, run((req) => {
    const { isTyping = true, activity } = req.body || {};
    actions.typing(req.user, { convId: p(req, 'id'), isTyping, activity }, req.ctx);
    return undefined;
  }));
  router.put('/conversations/:id/disappearing', ...authed, json, run((req) => actions.setDisappearing(req.user, {
    convId: p(req, 'id'),
    seconds: req.body?.seconds,
  }, req.ctx)));
  router.get('/conversations/:id/call', ...authed, run((req) => actions.activeCall(req.user, { convId: p(req, 'id') }, req.ctx)));

  router.delete('/messages/:id', ...authed, run((req) => {
    actions.deleteMessage(req.user, { id: p(req, 'id') }, req.ctx);
    return undefined;
  }));
  router.put('/messages/:id/star', ...authed, run((req) => actions.star(req.user, { id: p(req, 'id'), starred: true }, req.ctx)));
  router.delete('/messages/:id/star', ...authed, run((req) => actions.star(req.user, { id: p(req, 'id'), starred: false }, req.ctx)));
  router.get('/starred', ...authed, run((req) => actions.starred(req.user, {}, req.ctx)));

  router.get('/media/:id', ...authed, (req, res, next) => {
    const media = store.getMedia(p(req, 'id'), req.user);
    if (!media) return next(new ApiError(404, 'not_found', 'Media not found'));
    if (!service.mediaAllowed(req.user, p(req, 'id'), req.ctx)) {
      return next(new ApiError(423, 'chat_locked', 'This voice message is in a locked chat. Unlock the chat first.'));
    }
    res.set({ 'Content-Type': media.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(media.buffer);
  });

  // ---------- chat lock ----------

  router.get('/chat-lock', ...authed, run((req) => actions.lockSettings(req.user)));
  router.put('/chat-lock/code', ...authed, json, run((req) => actions.setLockCode(req.user, {
    code: req.body?.code,
    currentCode: req.body?.currentCode,
  })));
  router.post('/chat-lock/reset/otp', ...authed, run((req) => actions.requestLockResetCode(req.user)));
  router.post('/chat-lock/reset', ...authed, json, run((req) => actions.resetLockCode(req.user, {
    password: req.body?.password,
    requestId: req.body?.requestId,
    code: req.body?.code,
    newCode: req.body?.newCode,
  })));
  router.post('/chat-lock/relock', ...authed, run((req) => actions.relock(req.user, {}, req.ctx)));
  router.put('/conversations/:id/lock', ...authed, run((req) => actions.lockChat(req.user, { convId: p(req, 'id') })));
  router.delete('/conversations/:id/lock', ...authed, json, run((req) => actions.removeChatLock(req.user, {
    convId: p(req, 'id'),
    code: req.body?.code,
    biometric: req.body?.biometric,
  })));
  router.post('/conversations/:id/unlock', ...authed, json, run((req) => actions.unlockChat(req.user, {
    convId: p(req, 'id'),
    code: req.body?.code,
    biometric: req.body?.biometric,
  }, req.ctx)));
  router.post('/chat-lock/clear', ...authed, json, run((req) => actions.clearChatLocks(req.user, proof(req))));

  // ---------- profile photos ----------

  router.get('/me/photos', ...authed, run((req) => actions.photos(req.user)));
  router.post('/me/photos', ...authed, express.json({ limit: '1mb' }), run((req) => actions.uploadPhoto(req.user, { image: req.body?.image, thumb: req.body?.thumb }), 201));
  router.put('/me/photos/:id/main', ...authed, run((req) => actions.setMainPhoto(req.user, { id: p(req, 'id') })));
  router.delete('/me/photos/:id', ...authed, run((req) => actions.deletePhoto(req.user, { id: p(req, 'id') })));
  router.put('/me/login-pin', ...authed, json, run((req) => actions.setLoginPin(req.user, { pin: req.body?.pin, current: req.body?.current })));
  router.get('/me/sessions', ...authed, run((req) => actions.sessionsList(req.user, {}, req.ctx)));
  router.delete('/me/sessions', ...authed, run((req) => actions.endOtherSessions(req.user, {}, req.ctx)));
  router.post('/me/link-code', ...authed, run((req) => actions.linkCodeCreate(req.user, {}, req.ctx), 201));
  router.get('/me/linked-devices', ...authed, run((req) => actions.linkedDevices(req.user, {}, req.ctx)));
  router.delete('/me/linked-devices/:id', ...authed, run((req) => actions.unlinkDevice(req.user, { id: p(req, 'id') }, req.ctx)));
  router.put('/me/photo-rotation', ...authed, json, run((req) => actions.setPhotoRotation(req.user, { on: req.body?.on })));
  router.put('/me/photo-privacy', ...authed, json, run((req) => actions.setPhotoPrivacy(req.user, { who: req.body?.who })));
  router.get('/users/:username/photos', ...authed, run((req) => actions.userPhotos(req.user, { username: p(req, 'username') })));
  router.post('/users/:username/photos/:id/report', ...authed, json, run((req) => actions.reportPhoto(req.user, { username: p(req, 'username'), id: p(req, 'id'), reason: req.body?.reason, detail: req.body?.detail }), 201));

  // ---------- my parent or guardian (children) ----------

  router.get('/me/guardian', ...authed, run((req) => actions.guardianStatus(req.user)));
  router.post('/me/guardian/resend', ...authed, run((req) => actions.guardianResend(req.user, {}, req.ctx)));
  router.put('/me/guardian', ...authed, json, run((req) => actions.guardianContact(req.user, req.body || {}, req.ctx)));

  // ---------- push notifications ----------

  router.get('/push', ...authed, run((req) => actions.pushConfig(req.user)));
  router.put('/push/subscription', ...authed, json, run((req) => actions.pushSubscribe(req.user, { subscription: req.body?.subscription, userAgent: req.body?.userAgent || req.get('user-agent') })));
  router.post('/push/unsubscribe', ...authed, json, run((req) => actions.pushUnsubscribe(req.user, { endpoint: req.body?.endpoint })));
  router.patch('/push/settings', ...authed, json, run((req) => actions.pushSettings(req.user, req.body || {})));
  router.post('/push/test', ...authed, run((req) => actions.pushTest(req.user)));

  // ---------- location sharing ----------

  router.post('/conversations/:id/location', ...authed, json, run((req) => actions.sendLocation(req.user, {
    convId: p(req, 'id'),
    live: req.body?.live,
    location: req.body?.location,
    e2ee: req.body?.e2ee,
    clientId: idempotency(req),
  }, req.ctx), 201));
  router.put('/live-locations/:id', ...authed, json, run((req) => actions.updateLocation(req.user, { id: p(req, 'id'), location: req.body?.location, e2ee: req.body?.e2ee }, req.ctx)));
  router.delete('/live-locations/:id', ...authed, run((req) => actions.stopLocation(req.user, { id: p(req, 'id') })));

  // ---------- end-to-end encryption ----------

  router.get('/e2ee/devices', ...authed, run((req) => actions.e2eeDevices(req.user)));
  router.post('/e2ee/devices', ...authed, json, run((req) => actions.registerDevice(req.user, req.body || {}), 201));
  router.delete('/e2ee/devices/:id', ...authed, run((req) => actions.removeDevice(req.user, { id: p(req, 'id') })));
  router.get('/conversations/:id/keys', ...authed, run((req) => actions.conversationKeys(req.user, { convId: p(req, 'id') })));

  // ---------- hidden chats ----------

  router.put('/conversations/:id/hide', ...authed, run((req) => actions.hideChat(req.user, { convId: p(req, 'id') }, req.ctx)));
  router.delete('/conversations/:id/hide', ...authed, run((req) => actions.unhideChat(req.user, { convId: p(req, 'id') }, req.ctx)));
  router.put('/hidden-contacts/:username', ...authed, run((req) => actions.hideChat(req.user, { username: p(req, 'username') }, req.ctx)));
  router.get('/hidden-chats', ...authed, run((req) => actions.listHidden(req.user, {}, req.ctx)));
  router.post('/hidden-chats/reveal', ...authed, json, run((req) => actions.revealHidden(req.user, proof(req), req.ctx)));
  router.post('/hidden-chats/close', ...authed, run((req) => actions.hideAgain(req.user, {}, req.ctx)));
  router.post('/hidden-chats/clear', ...authed, json, run((req) => actions.clearHidden(req.user, proof(req))));

  // ---------- fingerprint / face lock ----------

  router.post('/biometric/challenge', ...authed, run((req) => actions.biometricChallenge(req.user)));
  router.post('/biometric', ...authed, json, run((req) => actions.addBiometric(req.user, {
    code: req.body?.code,
    name: req.body?.name,
    credential: req.body?.credential,
  }), 201));
  router.delete('/biometric/:id', ...authed, json, run((req) => actions.removeBiometric(req.user, { id: p(req, 'id'), ...proof(req) })));

  // ---------- status updates ----------

  router.get('/statuses', ...authed, run((req) => actions.statuses(req.user, {}, req.ctx)));
  router.post('/statuses', ...authed,
    json,
    express.raw({ type: 'image/*', limit: '3mb' }),
    run((req) => {
      if (Buffer.isBuffer(req.body)) {
        return actions.postStatus(req.user, { type: 'image', data: req.body, mime: req.get('content-type'), caption: req.query.caption }, req.ctx);
      }
      const { type = 'text', text, bg } = req.body || {};
      if (type !== 'text') throw new ApiError(400, 'bad_request', 'Send JSON { "type": "text", "text": "…" }, or the image itself with Content-Type: image/*');
      return actions.postStatus(req.user, { type, text, bg }, req.ctx);
    }, 201));
  router.delete('/statuses/:id', ...authed, run((req) => {
    actions.deleteStatus(req.user, { id: p(req, 'id') }, req.ctx);
    return undefined;
  }));
  router.post('/statuses/:id/view', ...authed, run((req) => {
    actions.viewStatus(req.user, { id: p(req, 'id') }, req.ctx);
    return undefined;
  }));
  router.post('/statuses/:id/replies', ...authed, json, run((req) => actions.replyStatus(req.user, {
    id: p(req, 'id'),
    text: req.body?.text,
    clientId: idempotency(req),
    e2ee: req.body?.e2ee,
  }, req.ctx), 201));

  // ---------- errors ----------

  router.use((req, res, next) => next(new ApiError(404, 'not_found', `No such endpoint: ${req.method} ${req.baseUrl}${req.path}`)));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const e = toApiError(err);
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    if (e.status >= 500) console.error(err);
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
  });

  return router;
}

/** Map errors thrown by the store/service to HTTP statuses. */
function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err.status && err.code && typeof err.code === 'string') return new ApiError(err.status, err.code, err.message);
  if (err.type === 'entity.parse.failed') return new ApiError(400, 'invalid_json', 'Request body is not valid JSON');
  if (err.type === 'entity.too.large') return new ApiError(413, 'too_large', 'Request body is too large');
  const msg = err.message || 'Something went wrong';
  if (/not found|not a member/i.test(msg)) return new ApiError(404, 'not_found', msg);
  if (/^Unblock|only delete your own|cannot be (deleted|starred)|cannot block yourself|Cannot chat with yourself/i.test(msg)) {
    return new ApiError(403, 'forbidden', msg);
  }
  if (/already taken|already registered/i.test(msg)) return new ApiError(409, 'conflict', msg);
  if (/at most/i.test(msg)) return new ApiError(409, 'limit_reached', msg);
  if (err.status && err.status < 500) return new ApiError(err.status, 'bad_request', msg);
  if (err instanceof TypeError || err instanceof ReferenceError) return new ApiError(500, 'internal_error', 'Internal server error');
  return new ApiError(400, 'bad_request', msg);
}

module.exports = { createApiRouter, toApiError };
