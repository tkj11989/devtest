'use strict';

const fs = require('fs');
const crypto = require('crypto');
const compression = require('compression');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');
const { Store } = require('./store');
const { createCallManager } = require('./calls');
const { createPush } = require('./push');
const { createService } = require('./service');
const { createWebhookDispatcher } = require('./webhooks');
const { createApiRouter } = require('./api');
const { createOtpService, createOtpSender } = require('./otp');
const { createAuth } = require('./auth');
const { createLinking } = require('./linking');
const { createAdminRouter } = require('./admin');
const { createKyc, createKycGateway } = require('./kyc');
const { createTranslator, createTranslateGateway } = require('./translate');
const { createPayments, plansFromEnv } = require('./payments');
const { selectProvider } = require('./payment-providers');

// STUN/TURN servers handed to browsers for WebRTC. Override with a JSON array,
// e.g. ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
function iceServersFromEnv() {
  // Your own TURN server (coturn with use-auth-secret): every person gets short-lived credentials, so the relay
  // cannot be used by strangers. TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349 TURN_SECRET=... [TURN_TTL_SECONDS=86400]
  if (process.env.TURN_URLS && process.env.TURN_SECRET) {
    const urls = process.env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean);
    const ttl = Number(process.env.TURN_TTL_SECONDS) || 24 * 60 * 60;
    const stun = urls.filter((u) => u.startsWith('turn:')).map((u) => u.replace(/^turn:/, 'stun:').replace(/\?.*$/, '')); // STUN addresses take no ?transport=
    return (username) => {
      const name = `${Math.floor(Date.now() / 1000) + ttl}:${username}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(name).digest('base64');
      return [{ urls: [...new Set(stun)] }, { urls, username: name, credential }];
    };
  }
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
  'user:get': 'getUser',
  'profile:view': 'viewProfile',
  'profile:views': 'profileViews',
  'profile:views-set': 'setProfileViews',
  'chat:direct': 'openDirect',
  'group:create': 'createGroup',
  'messages:get': 'messages',
  'message:send': 'sendText',
  'voice:send': 'sendVoice',
  'pin:set': 'setLoginPin',
  'sessions:list': 'sessionsList',
  'sessions:end-others': 'endOtherSessions',
  'link:create': 'linkCodeCreate',
  'link:list': 'linkedDevices',
  'link:remove': 'unlinkDevice',
  'photos:get': 'photos',
  'photo:rotate': 'setPhotoRotation',
  'photo:upload': 'uploadPhoto',
  'photo:main': 'setMainPhoto',
  'photo:delete': 'deletePhoto',
  'photo:privacy': 'setPhotoPrivacy',
  'photos:user': 'userPhotos',
  'photo:report': 'reportPhoto',
  'poll:send': 'sendPoll',
  'poll:vote': 'votePoll',
  'poll:close': 'closePoll',
  'event:send': 'sendEvent',
  'event:rsvp': 'rsvpEvent',
  'event:edit': 'updateEvent',
  'event:cancel': 'cancelEvent',
  'location:send': 'sendLocation',
  'location:update': 'updateLocation',
  'location:stop': 'stopLocation',
  'push:config': 'pushConfig',
  'push:subscribe': 'pushSubscribe',
  'push:unsubscribe': 'pushUnsubscribe',
  'push:settings': 'pushSettings',
  'push:test': 'pushTest',
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
  'chat:continue': 'continueChat',
  'settings:default-disappear': 'setDefaultDisappear',
  'business:get': 'business',
  'business:set': 'setBusiness',
  'business:remove': 'removeBusiness',
  'me:contact-code': 'requestContactCode',
  'me:contact-verify': 'verifyContact',
  'chatlock:reset-sms': 'requestLockResetCode',
  'chatlock:clear': 'clearChatLocks',
  'channels:search': 'channelsSearch',
  'channels:mine': 'channelsMine',
  'channel:get': 'channelGet',
  'channel:create': 'channelCreate',
  'channel:update': 'channelUpdate',
  'channel:delete': 'channelDelete',
  'channel:follow': 'channelFollow',
  'channel:unfollow': 'channelUnfollow',
  'channel:admin': 'channelAdmin',
  'channel:posts': 'channelPosts',
  'channel:post': 'channelPost',
  'channel:post-delete': 'channelPostDelete',
  'channel:read': 'channelRead',
  'channel:report': 'channelReport',
  'catalogue:get': 'catalogue',
  'catalogue:save': 'saveProduct',
  'catalogue:delete': 'deleteProduct',
  'catalogue:currency': 'setCatalogueCurrency',
  'catalogue:image-remove': 'removeProductImage',
  'catalogue:image': 'setProductImage',
  'translate:languages': 'translateLanguages',
  'translate:set': 'setTranslation',
  'translate:text': 'translateTexts',
  'guardian:status': 'guardianStatus',
  'guardian:resend': 'guardianResend',
  'guardian:contact': 'guardianContact',
  'consent:status': 'consentStatus',
  'consent:accept': 'consentAccept',
  'consent:set': 'consentSet',
  'account:export': 'accountExport',
  'account:delete-code': 'accountDeleteCode',
  'account:delete': 'accountDelete',
  'appearance:get': 'appearance',
  'appearance:set': 'setAppearance',
  'subscription:status': 'subscriptionStatus',
  'subscription:checkout': 'subscriptionCheckout',
  'payments:history': 'paymentHistory',
  'subscription:confirm': 'subscriptionConfirm',
  'kyc:status': 'kycStatus',
  'kyc:start': 'kycStart',
  'kyc:verify': 'kycVerify',
  'e2ee:register': 'registerDevice',
  'e2ee:devices': 'e2eeDevices',
  'e2ee:remove': 'removeDevice',
  'e2ee:keys': 'conversationKeys',
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
 *   recordConsentMs  how long a call-recording request waits for answers (default 30 s)
 *   webhooks         { allowPrivate, retryDelaysMs } for webhook delivery
 *   rateLimit        { windowMs, max, authMax } for the REST API
 *   corsOrigins      allowed origins for the REST API ('*' or a list)
 *   trustProxy       Express `trust proxy` setting (env TRUST_PROXY) so the real client address is used behind nginx/Cloudflare
 *   push             { vapid, sender, extraHosts } for push notifications (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, PUSH_SUBJECT; see push.js)
 *   messageSweepMs   how often expired disappearing messages are removed
 *   accountEraseDelayMs  how long after a deletion request the account's data is erased (default 1 hour; never more than 24 hours)
 *   kyc              { gateway, sandbox } for identity verification (see kyc.js; KYC_WEBHOOK_URL, KYC_SANDBOX=1)
 *   otp              { sender, exposeCodes, ttlMs, resendMs, … } for one-time login codes
 *                    (see otp.js; by default codes go to OTP_WEBHOOK_URL or the console)
 */
function createApp({
  store = new Store(),
  tls = null,
  iceServers = iceServersFromEnv(),
  ringTimeoutMs,
  recordConsentMs,
  webhooks: webhookOptions = { allowPrivate: process.env.WEBHOOKS_ALLOW_PRIVATE === '1' },
  rateLimit,
  // Browser apps on other websites may only call the API when listed: CORS_ORIGINS, or just our own address when PUBLIC_URL is set.
  corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : (process.env.PUBLIC_URL ? [new URL(process.env.PUBLIC_URL).origin] : '*'),
  messageSweepMs = 5000,
  subscriptionSweepMs = 60 * 1000,
  deletionSweepMs = 60 * 1000,
  accountEraseDelayMs = Number(process.env.ACCOUNT_ERASE_DELAY_MS) || 60 * 60 * 1000,
  otp: otpOptions = {},
  kyc: kycOptions = {},
  payments: paymentOptions = {},
  razorpay: razorpayOptions = {},
  paymentProvider = undefined,
  admin: adminOptions = {},
  translate: translateOptions = {},
  push: pushOptions = {},
  trustProxy = process.env.TRUST_PROXY,
  publicUrl = process.env.PUBLIC_URL,
  guardianSweepMs = 60 * 60 * 1000,
} = {}) {
  const app = express();
  // Behind nginx or Cloudflare every request comes from the proxy: trust its forwarded address, or the sign-in rate limits
  // would treat all visitors as one person. TRUST_PROXY: `loopback` (one proxy on this machine), a number of proxies, or a list of addresses.
  if (trustProxy !== undefined && trustProxy !== '') app.set('trust proxy', /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);
  // Browser features this app uses: location (sharing), microphone and camera (voice notes and calls). Nothing embedded in a page
  // may use them, and the features it never uses are switched off.
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=(self), payment=(), usb=(), serial=(), hid=(), display-capture=()');
    next();
  });
  // JSON and text are sent compressed (a member of a big group has a 90 KB chat list). COMPRESSION=0 turns it off, for example
  // when nginx already compresses.
  if (process.env.COMPRESSION !== '0') app.use(compression({ threshold: 1024 }));
  // Headers for every page: the app may only load its own scripts (so an injected script cannot run or phone home), nothing may
  // frame it, browsers must keep using https once they have seen it, and files are never guessed to be another type.
  // The admin dashboard, the guardian page and the API docs set their own, stricter or special policies below.
  const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!/^\/(admin|api\/docs|guardian)(\/|$)/.test(req.path)) res.set('Content-Security-Policy', APP_CSP);
    next();
  });
  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  // Voice messages and status photos are uploaded over the socket.
  const io = new Server(server, { maxHttpBufferSize: 4 * 1024 * 1024 });

  // username -> number of connected sockets
  const online = new Map();
  const openByLock = new Map(); // lockKey -> how many sockets are open (so a disconnect doesn't scan every socket)
  const isOnline = (u) => (online.get(u) || 0) > 0;

  const webhooks = createWebhookDispatcher({ store, ...webhookOptions });
  const otp = createOtpService({ sender: createOtpSender(), exposeCodes: process.env.OTP_DEV_CODES === '1', ...otpOptions });
  const linking = createLinking();
  const auth = createAuth({ store, otp, linking, onLogin: (u, info) => service.notifyNewLogin(u, info), publicUrl, minAge: () => store.getSettings().limits.minAge, assertSignupsOpen: () => service.assertFeature('registration') });
  const kyc = createKyc({ store, otp, gateway: createKycGateway(), sandbox: process.env.KYC_SANDBOX === '1', ...kycOptions });
  const payments = createPayments({
    store,
    // Who takes the money: PAYMENT_PROVIDER, or the first configured one (Razorpay: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
    // RAZORPAY_WEBHOOK_SECRET). Pass `paymentProvider` to use another one (see payment-providers.js).
    provider: paymentProvider !== undefined ? paymentProvider : selectProvider({ razorpay: razorpayOptions }),
    publicUrl,
    onPaid: (e) => service.paymentReceived(e),
    onRefund: (e) => service.paymentRefunded(e),
    plans: plansFromEnv(),
    currency: process.env.PLAN_CURRENCY || 'INR',
    ...paymentOptions,
  });
  const translator = createTranslator({ gateway: createTranslateGateway(), sandbox: process.env.TRANSLATE_SANDBOX === '1', ...translateOptions });
  // Push notifications: the key pair that identifies this server to the browsers' push services is kept next to the data.
  const dataDir = store.file ? path.dirname(store.file) : store.mediaDir ? path.dirname(store.mediaDir) : null;
  const push = createPush({
    store,
    isOnline,
    featureOn: () => store.featureOn('push'),
    subject: () => { const e = store.getSettings().legal?.contactEmail; return e ? `mailto:${e}` : undefined; },
    vapid: { file: dataDir ? path.join(dataDir, 'vapid.json') : undefined },
    ...pushOptions,
  });
  const service = createService({ store, io, isOnline, linking, webhooks, iceServers, otp, kyc, payments, translator, push, publicUrl, accountEraseDelayMs });
  const { actions } = service;

  // Wrap a handler so thrown errors are returned through the ack callback.
  const handle = (fn) => async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const result = await fn(payload || {});
      await store.whenSaved(); // acknowledged means saved
      reply({ ok: true, ...result });
    } catch (err) {
      reply({ ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  };

  const calls = createCallManager({ io, store, isOnline, reachable: (u) => isOnline(u) || push.canWake(u), pushCall: push.call, notify: service.notify, postMessage: service.postMessage, handle, ringTimeoutMs, recordConsentMs, assertCallsOn: () => service.assertFeature('calls'), assertRecordingOn: () => service.assertFeature('callRecording') });
  service.setCalls(calls);

  // Public REST API for other platforms (see /api/docs). It parses its own bodies.
  // Administrator accounts come from the environment (ADMIN_USERNAME, ADMIN_PASSWORD) or the `admin` option.
  const adminUser = adminOptions.username ?? process.env.ADMIN_USERNAME ?? 'admin';
  const adminPassword = adminOptions.password ?? process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    store.upsertAdmin(adminUser, adminPassword, 'super');
    // Lost phone: start once with ADMIN_RESET_2FA=1, sign in, set up two-step again, then remove the line.
    if (process.env.ADMIN_RESET_2FA === '1' && store.clearAdminTotp(adminUser)) console.warn(`Two-step sign-in cleared for ${adminUser} (ADMIN_RESET_2FA=1): remove that line after you have set it up again.`);
  }
  const adminRouter = createAdminRouter({
    store,
    service,
    io,
    onlineCount: () => online.size,
    integrations: () => ({
      otp: process.env.OTP_WEBHOOK_URL ? 'gateway' : 'console',
      kyc: kyc.available ? (kyc.sandbox ? 'sandbox' : 'live') : 'off',
      payments: !payments.available ? 'off' : payments.sandbox ? 'sandbox' : `${payments.providerId}${payments.provider.testMode ? ' (test mode)' : ''}`,
      translation: translator.available ? (translator.sandbox ? 'sandbox' : 'live') : 'off',
    }),
    ...(adminOptions.router || {}),
  });
  app.use('/admin/api', adminRouter);
  app.use('/admin', (req, res, next) => {
    // The dashboard is its own page: no framing, no outside scripts.
    res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'" });
    next();
  });
  app.use('/api/v1', createApiRouter({ store, service, accounts: auth, webhooks, rateLimit, corsOrigins }));
  // Terms of Use and Privacy Notice: public pages (company details come from the dashboard's Legal settings).
  const legal = require('./legal');
  app.get('/legal/:doc', (req, res) => {
    const html = legal.documentHtml(req.params.doc, legal.details(store.getSettings()), req.query.lang);
    if (!html) return res.status(404).send('Not found');
    return res.type('html').send(html);
  });
  // The parent or guardian's page: opened from the private link sent to them (no sign-in; the link is the key).
  app.get('/guardian/:token', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    const html = require('./guardian').pageHtml();
    // Its one inline script is allowed by hash, so nothing else can run on this page.
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] || '';
    const hash = crypto.createHash('sha256').update(script).digest('base64');
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    res.type('html').send(html);
  });
  app.get('/api/docs', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'api-docs.html')));
  // Swagger UI is served from node_modules so the docs work without internet access.
  app.use('/api/docs/assets', express.static(require('swagger-ui-dist').getAbsoluteFSPath(), { maxAge: '7d' }));

  // ---------- payment provider: "payment received" ----------

  // The provider (Razorpay today) tells us a payment was received, or refunded, in a signed notification to POST /webhooks/<id>.
  // It needs the raw body to check the signature. Anything that does not verify is refused; repeats are harmless (each payment
  // counts once). Nothing here names a vendor: the provider object does the vendor-specific parts.
  app.post('/webhooks/:provider', express.raw({ type: () => true, limit: '200kb' }), (req, res) => {
    const pv = payments.provider;
    if (!pv || pv.id !== req.params.provider) return res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    if (!pv.webhookConfigured) return res.status(503).json({ error: { code: 'not_configured', message: `${pv.label} webhooks are not set up` } });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!pv.verifyWebhook(raw, req.headers)) return res.status(400).json({ error: { code: 'bad_signature', message: 'Signature does not match' } });
    let event;
    try {
      event = pv.parseWebhook(JSON.parse(raw.toString('utf8')));
    } catch {
      return res.status(400).json({ error: { code: 'invalid_request', message: 'Not JSON' } });
    }
    let outcome = { status: 'ignored' };
    if (event.kind === 'paid') outcome = payments.receive(event);
    else if (event.kind === 'refund') outcome = payments.refund(event);
    return res.json({ ok: true, status: outcome.status });
  });

  // Where the provider sends the person after paying. The address is checked by the provider's own signature, and we also ask the
  // provider whether the order was paid before trusting it.
  const paymentReturn = async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    const page = (status, title, text) => res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#F1F5FB;color:#0B1A33}main{max-width:420px;margin:16px;background:#fff;border-radius:14px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}h1{font-size:22px}@media(prefers-color-scheme:dark){body{background:#07101F;color:#E6EDF7}main{background:#0C1730}}</style></head><body><main><h1>${title}</h1><p>${text}</p><p><a href="/">Back to VartiQ</a></p></main></body></html>`);
    const pv = payments.provider;
    if (req.params.provider && pv?.id !== req.params.provider) return page(404, 'Not found', 'This page does not exist.');
    const r = pv && pv.verifyReturn(req.query);
    if (!r?.valid) return page(400, 'This link is not valid', 'We could not check this payment. If you paid, open VartiQ: your Premium switches on as soon as the payment is confirmed.');
    if (!r.paid) return page(200, 'Payment not completed', 'No money was taken. Go back to VartiQ and try again when you are ready.');
    const user = r.reference.slice(0, r.reference.lastIndexOf('.'));
    const order = user && store.orderOf(user, r.reference);
    if (!order) return page(200, 'Payment received', 'Thank you. Open VartiQ: your Premium is switched on as soon as the payment is confirmed.');
    try {
      const st = await pv.status({ providerRef: order.providerRef, reference: r.reference, amount: order.amount, currency: order.currency });
      if (st.paid) payments.receive({ reference: r.reference, paymentId: st.paymentId || r.paymentId, amountMinor: st.amountMinor, currency: st.currency, method: st.method });
    } catch (err) {
      console.error(`${pv.label} return check failed:`, err.message); // the webhook will still arrive
    }
    return page(200, 'Payment received', 'Thank you! Your Premium is on. You can close this page and go back to VartiQ.');
  };
  app.get('/premium/return/:provider', paymentReturn);
  app.get('/premium/return', paymentReturn); // the first address we used, kept so links already sent keep working

  app.use(express.json({ limit: '50kb' }));

  // Icons rarely change; let browsers keep them so they still render while offline.
  app.use('/icons', express.static(path.join(__dirname, '..', 'public', 'icons'), { maxAge: '7d' }));
  // The service worker (notifications) must always be fetched fresh, or a fix could take days to reach people.
  app.get('/sw.js', (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/', 'Content-Type': 'text/javascript; charset=utf-8' });
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });
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
    res.set({ 'Content-Type': media.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(media.buffer);
  });

  // Expired status updates disappear for everyone.
  const pruneTimer = setInterval(() => {
    for (const s of store.pruneStatuses()) service.broadcastStatus(s, 'status:deleted');
  }, 60 * 1000);
  pruneTimer.unref();
  // Disappearing messages: remove them as soon as their timer runs out.
  const expiryTimer = setInterval(() => { service.pruneExpired(); }, messageSweepMs);
  // Premium that ran out: update badges for everyone.
  const subscriptionTimer = setInterval(() => service.expireSubscriptions(), subscriptionSweepMs);
  // Accounts people asked to delete: their data is erased within 24 hours (by default about an hour after the request).
  const deletionTimer = setInterval(() => { service.eraseDueAccounts(); }, deletionSweepMs);
  // Children who turn 18 are released from their guardian's controls.
  const guardianTimer = setInterval(() => { service.releaseGuardians(); }, guardianSweepMs);
  const rotateTimer = setInterval(() => { service.rotatePhotos(); }, guardianSweepMs);
  rotateTimer.unref();
  guardianTimer.unref();
  subscriptionTimer.unref();
  deletionTimer.unref();
  expiryTimer.unref();
  server.on('close', () => {
    clearInterval(pruneTimer);
    clearInterval(expiryTimer);
    clearInterval(subscriptionTimer);
    clearInterval(deletionTimer);
    clearInterval(guardianTimer);
    clearInterval(rotateTimer);
    webhooks.stop();
    push.stop();
    otp.stop();
    kyc.stop();
    payments.stop();
    adminRouter.stop();
  });

  // ---------- realtime ----------

  // Accepts a login session token or an API key.
  io.use((socket, next) => {
    // Maintenance mode, or an app older than the minimum version: nobody gets in.
    try {
      service.assertAvailable(socket.handshake.auth?.clientVersion);
    } catch (err) {
      return next(Object.assign(new Error(err.code), { data: { code: err.code, message: err.message } }));
    }
    const token = socket.handshake.auth?.token;
    const username = store.userForToken(token);
    if (!username) return next(new Error('unauthorized'));
    if (String(token).startsWith('cak_') && !store.featureOn('developerApi')) return next(new Error('unauthorized'));
    socket.data.username = username;
    // One page load of the web app = one app session for chat lock (survives reconnects, not reloads).
    socket.data.lockKey = service.lockKeyFor(username, socket.handshake.auth.token, socket.handshake.auth.appSession);
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.data.username;
    socket.join(service.userRoom(me));
    online.set(me, (online.get(me) || 0) + 1);
    openByLock.set(socket.data.lockKey, (openByLock.get(socket.data.lockKey) || 0) + 1);
    if (online.get(me) === 1) service.broadcastPresence(me);

    // Anything sent while we were offline is now delivered.
    for (const c of store.conversationsFor(me)) service.notifyStatus(c.id, store.markDelivered(c.id, me));

    // Until the current Terms and Privacy Notice are accepted, only the events needed to accept (or leave) get through.
    const CONSENT_EVENTS = new Set(['me', 'consent:status', 'consent:accept', 'consent:set', 'account:export', 'account:delete-code', 'account:delete']);
    const GUARDIAN_EVENTS = new Set([...CONSENT_EVENTS, 'guardian:status', 'guardian:resend', 'guardian:contact']);
    socket.use(([event, ...args], next) => {
      const ack = args[args.length - 1];
      if (!CONSENT_EVENTS.has(event) && !store.consentUpToDate(me, legal.VERSION)) {
        if (typeof ack === 'function') ack({ ok: false, code: 'consent_required', error: 'Please accept the current Terms of Use and Privacy Notice to continue' });
        return undefined;
      }
      // A child's account does nothing until the parent or guardian has agreed.
      if (!GUARDIAN_EVENTS.has(event) && store.guardianState(me) === 'pending') {
        if (typeof ack === 'function') ack({ ok: false, code: 'guardian_required', error: 'Your parent or guardian needs to approve your account first' });
        return undefined;
      }
      return next();
    });

    calls.attach(socket);
    const ctx = { lockKey: socket.data.lockKey, credential: socket.handshake.auth.token, origin: `${socket.handshake.secure ? 'https' : 'http'}://${socket.handshake.headers.host}` };
    for (const [event, action] of Object.entries(SOCKET_ACTIONS)) {
      socket.on(event, handle((payload) => {
        service.assertAvailable();
        return actions[action](me, payload, ctx);
      }));
    }

    socket.on('disconnect', () => {
      // Closing the last tab of an app session locks its chats again.
      const open = (openByLock.get(ctx.lockKey) || 1) - 1;
      if (open > 0) openByLock.set(ctx.lockKey, open);
      else openByLock.delete(ctx.lockKey);
      const stillOpen = open > 0;
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

  return { app, server, io, store, calls, service, webhooks, otp, push };
}

if (require.main === module) {
  (async () => {
    const port = Number(process.env.PORT) || 3000;
    // Switches that give away verification, Premium or login codes are for development only: a production server refuses them.
    if (process.env.NODE_ENV === 'production') {
      const unsafe = ['OTP_DEV_CODES', 'KYC_SANDBOX', 'PAYMENTS_SANDBOX', 'TRANSLATE_SANDBOX', 'WEBHOOKS_ALLOW_PRIVATE'].filter((k) => process.env[k] === '1');
      if (process.env.PREMIUM_FOR_ALL === '1') unsafe.push('PREMIUM_FOR_ALL');
      if (unsafe.length) {
        console.error(`Refusing to start in production with testing switches on: ${unsafe.join(', ')}. Remove them from the environment file.`);
        process.exit(1);
      }
      if (!process.env.DATABASE_URL) console.warn('Production is using the data/db.json file store, which rewrites the whole file on every change. Set DATABASE_URL to use PostgreSQL.');
      if (!process.env.PUBLIC_URL) console.warn('PUBLIC_URL is not set: parent/guardian links, payment returns and the CORS allow-list will not work properly.');
    }
    // Browsers only allow camera/microphone on https:// or localhost, so serve
    // HTTPS when a certificate is provided (needed to call from other devices).
    const tls = process.env.SSL_KEY && process.env.SSL_CERT
      ? { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }
      : null;
    // DATABASE_URL set: keep the data in PostgreSQL. Otherwise it lives in data/db.json.
    const store = process.env.DATABASE_URL
      ? await Store.open({ databaseUrl: process.env.DATABASE_URL, mediaDir: process.env.MEDIA_DIR })
      : new Store();
    const { server } = createApp({ tls, store });
    // HOST=127.0.0.1 keeps the app reachable only through nginx on the same machine (recommended in production).
    const host = process.env.HOST || undefined;
    server.listen(port, host, () => {
      console.log(`VartiQ running at ${tls ? 'https' : 'http'}://${host || 'localhost'}:${port}`);
      console.log(process.env.DATABASE_URL ? 'Data: PostgreSQL' : 'Data: data/db.json (set DATABASE_URL to use PostgreSQL)');
      if (!process.env.OTP_WEBHOOK_URL) console.log('Login codes are printed here (set OTP_WEBHOOK_URL to send real SMS/email).');
      if (process.env.OTP_DEV_CODES === '1') console.warn('OTP_DEV_CODES=1: login codes are also shown in the app. Never use this in production.');
    });
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await store.close();
      } catch (err) {
        console.error('Could not save on shutdown:', err.message);
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })().catch((err) => {
    console.error('Could not start:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp };
