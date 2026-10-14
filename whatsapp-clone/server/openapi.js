'use strict';

const BusinessHours = require('../public/business-hours.js');

/**
 * OpenAPI 3.1 description of the REST API (served at /api/v1/openapi.json and
 * rendered at /api/docs). Keep in sync with server/api.js.
 */

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (schema) => ({ type: 'array', items: schema });
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const jsonBody = (schema, example) => ({ required: true, content: { 'application/json': { schema, ...(example ? { example } : {}) } } });
const ok = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const noContent = { description: 'Done (no body)' };
const errors = (...codes) => Object.fromEntries(codes.map((c) => [c, { $ref: `#/components/responses/E${c}` }]));
const idParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const CONV_ID = idParam('id', 'Conversation id. URL-encode it: direct chat ids contain colons, e.g. `dm%3Aalice%3Abob`.');

function op(tag, summary, { description, params, body, responses, auth = true }) {
  return {
    tags: [tag],
    summary,
    ...(description ? { description } : {}),
    ...(params ? { parameters: params } : {}),
    ...(body ? { requestBody: body } : {}),
    ...(auth ? {} : { security: [] }),
    responses,
  };
}

function buildOpenApiSpec({ serverUrl, webhookEvents }) {
  const schemas = {
    Error: obj({ error: obj({ code: { type: 'string', example: 'not_found' }, message: { type: 'string' } }, ['code', 'message']) }, ['error']),
    User: obj({
      username: { type: 'string', example: 'alice' },
      displayName: { type: 'string', example: 'Alice Smith' },
      about: { type: 'string' },
      lastSeen: { type: ['integer', 'null'], description: 'ms since epoch; null when hidden by blocking' },
      online: { type: 'boolean' },
      business: ref('BusinessPublic'),
      verified: { type: 'boolean', description: 'present (true) when the person passed identity verification; absent = not verified' },
      premium: { type: 'boolean', description: 'present (true) while the person has an active Premium subscription' },
    }, ['username', 'displayName']),
    DayHours: {
      oneOf: [
        obj({ mode: { const: 'hours' }, open: { type: 'string', pattern: '^\\d{2}:\\d{2}$', example: '09:00' }, close: { type: 'string', example: '18:00' } }, ['mode', 'open', 'close']),
        obj({ mode: { enum: ['open24', 'closed'] } }, ['mode']),
      ],
      description: 'A close time at or before the open time means open past midnight.',
    },
    BusinessHours: obj(Object.fromEntries(BusinessHours.DAYS.map((d) => [d, ref('DayHours')]))),
    BusinessPublic: obj({
      category: { type: 'string', enum: BusinessHours.CATEGORIES },
      description: { type: 'string', maxLength: 512 },
      address: { type: 'string', maxLength: 256 },
      email: { type: 'string', format: 'email' },
      website: { type: 'string', format: 'uri' },
      timezone: { type: 'string', example: 'Asia/Kolkata', description: 'IANA time zone the hours are in' },
      hours: { oneOf: [ref('BusinessHours'), { type: 'null' }] },
      since: { type: 'integer' },
      productCount: { type: 'integer', description: 'products in the catalogue (see `GET /users/{username}/catalogue`)' },
    }, ['category', 'timezone']),
    AutoReply: obj({ enabled: { type: 'boolean' }, text: { type: 'string', maxLength: 1000 } }),
    Business: {
      allOf: [ref('BusinessPublic'), obj({
        greeting: { ...ref('AutoReply'), description: 'Sent to customers who message you for the first time, or after 14 days without messages' },
        away: { ...ref('AutoReply'), description: 'Sent outside your business hours (at most once every 6 hours per chat)' },
      })],
    },
    Users: { type: 'object', additionalProperties: ref('User'), description: 'Users keyed by username' },
    Channel: obj({
      id: { type: 'string' },
      handle: { type: 'string', description: 'public name, 3-30 letters, numbers or _' },
      name: { type: 'string', maxLength: 60 },
      description: { type: 'string', maxLength: 300 },
      category: { type: 'string', maxLength: 30 },
      owner: { type: 'string', description: 'username of the owner' },
      admins: arrayOf({ type: 'string' }),
      followers: { type: 'integer' },
      following: { type: 'boolean' },
      role: { type: ['string', 'null'], enum: ['owner', 'admin', null], description: 'your role in the channel' },
      createdAt: { type: 'integer' },
      lastPost: { oneOf: [obj({ text: { type: 'string' }, ts: { type: 'integer' } }), { type: 'null' }] },
      unread: { type: 'integer', description: 'followers only: posts you have not read' },
    }, ['id', 'handle', 'name', 'owner', 'followers', 'following']),
    ChannelPost: obj({ id: { type: 'string' }, channelId: { type: 'string' }, text: { type: 'string', maxLength: 4000 }, by: { type: 'string' }, ts: { type: 'integer' } }, ['id', 'channelId', 'text', 'by', 'ts']),
    Product: obj({
      id: { type: 'string' },
      name: { type: 'string', maxLength: 80 },
      description: { type: 'string', maxLength: 1000 },
      price: { type: ['number', 'null'], description: 'in the catalogue currency, at most 2 decimals; null = price on request' },
      unit: { type: 'string', maxLength: 20, description: 'e.g. "per kg", "per hour"' },
      category: { type: 'string', maxLength: 40 },
      sku: { type: 'string', maxLength: 40 },
      link: { type: 'string', description: 'where to buy or read more (http/https)' },
      available: { type: 'boolean', description: 'false = shown as out of stock' },
      image: { type: 'string', description: 'media id: download it from `GET /media/{id}` with your token' },
      createdAt: { type: 'integer' },
      updatedAt: { type: 'integer' },
    }, ['id', 'name', 'price', 'available']),
    Catalogue: obj({ owner: { type: 'string' }, currency: { type: 'string', example: 'INR' }, products: arrayOf(ref('Product')) }, ['owner', 'currency', 'products']),
    Envelope: obj({
      v: { const: 1 },
      sd: { type: 'string', description: 'id of the sending device' },
      iv: { type: 'string', description: 'AES-GCM nonce for `ct` (12 bytes, base64url)' },
      ct: { type: 'string', description: 'AES-GCM ciphertext of the message JSON (base64url)' },
      eph: { type: 'string', description: 'one-time P-256 public key (65 bytes, base64url) used to wrap the content key' },
      mi: { type: 'string', description: 'voice messages: nonce for the encrypted audio' },
      w: { type: 'object', additionalProperties: obj({ iv: { type: 'string' }, k: { type: 'string' } }, ['iv', 'k']), description: 'the content key, wrapped once per recipient device id (a recipient only receives its own devices)' },
    }, ['v', 'sd', 'iv', 'ct', 'eph', 'w']),
    Device: obj({
      id: { type: 'string' },
      name: { type: 'string' },
      publicKey: { type: 'string', description: 'P-256 public key, 65 bytes uncompressed, base64url' },
      keyId: { type: 'string', description: 'short fingerprint of the key' },
      createdAt: { type: 'integer' },
    }, ['id', 'name', 'publicKey', 'keyId']),
    Message: obj({
      id: { type: 'string' },
      e2ee: { oneOf: [{ $ref: '#/components/schemas/Envelope' }], description: 'end-to-end encrypted message: `text` is absent and the content is in this envelope. Messages without it (REST API, business auto replies, older messages) are not end-to-end encrypted.' },
      convId: { type: 'string' },
      from: { type: 'string', description: 'username of the sender' },
      type: { type: 'string', enum: ['text', 'voice', 'call', 'system'], description: 'absent for text messages; `system` = a notice such as a timer change' },
      expiresAt: { type: 'integer', description: 'disappearing messages: when it will be deleted (ms since epoch)' },
      auto: { type: 'string', enum: ['greeting', 'away'], description: "a business's automatic reply" },
      system: obj({ event: { const: 'disappearing' }, seconds: { type: ['integer', 'null'] } }),
      text: { type: 'string' },
      ts: { type: 'integer', description: 'ms since epoch' },
      deliveredTo: arrayOf({ type: 'string' }),
      readBy: arrayOf({ type: 'string' }),
      clientId: { type: 'string', description: 'the clientId / Idempotency-Key it was sent with' },
      masked: { type: 'boolean', description: 'recipients should hide the text until tapped' },
      starred: { type: 'boolean', description: 'starred by you' },
      deleted: { type: 'boolean' },
      voice: obj({ mediaId: { type: 'string' }, duration: { type: 'integer', description: 'seconds' }, mime: { type: 'string' } }),
      call: obj({
        kind: { type: 'string', enum: ['audio', 'video'] },
        status: { type: 'string', enum: ['completed', 'missed', 'declined'] },
        duration: { type: 'integer' },
        group: { type: 'boolean' },
        joined: arrayOf({ type: 'string' }),
      }),
      statusReply: obj({ statusId: { type: 'string' }, owner: { type: 'string' }, type: { type: 'string' }, preview: { type: 'string' }, bg: { type: 'string' } }),
      locked: { type: 'boolean', description: 'true: the chat is locked and not unlocked in this session, so the content is withheld' },
    }, ['id', 'convId', 'from', 'ts']),
    ActiveCall: obj({
      callId: { type: 'string' },
      kind: { type: 'string', enum: ['audio', 'video'] },
      group: { type: 'boolean' },
      participants: arrayOf({ type: 'string' }),
      startedBy: { type: 'string' },
    }),
    Conversation: obj({
      id: { type: 'string', example: 'dm:alice:bob' },
      type: { type: 'string', enum: ['direct', 'group'] },
      name: { type: 'string', description: 'groups only' },
      members: arrayOf({ type: 'string' }),
      owner: { type: 'string' },
      admins: arrayOf({ type: 'string' }),
      createdAt: { type: 'integer' },
      lastMessage: { oneOf: [ref('Message'), { type: 'null' }] },
      unread: { type: 'integer' },
      translateTo: { type: 'string', description: 'language code received messages are shown in (private to you)' },
      activeCall: { oneOf: [ref('ActiveCall'), { type: 'null' }] },
      disappearAfter: { type: 'integer', description: 'disappearing messages timer in seconds (absent = off)' },
      disappearSetBy: { type: 'string' },
      locked: { type: 'boolean', description: 'you locked this chat with your secret code (or it is hidden and not yet revealed)' },
      unlocked: { type: 'boolean', description: 'locked chats only: unlocked in this session' },
      hidden: { type: 'boolean', description: 'the chat is hidden (left out of `GET /conversations`; `locked` is true until revealed)' },
    }, ['id', 'type', 'members']),
    ChatLock: obj({
      hasCode: { type: 'boolean', description: 'a secret code has been set' },
      lockedChats: arrayOf({ type: 'string' }),
      hiddenCount: { type: 'integer', description: 'how many chats are hidden (their ids are only listed by `GET /hidden-chats` once revealed)' },
      biometric: arrayOf(obj({ id: { type: 'string' }, name: { type: 'string' }, createdAt: { type: 'integer' } })),
    }, ['hasCode', 'lockedChats']),
    Proof: obj({
      code: { type: 'string', description: 'the secret code' },
      biometric: obj({
        id: { type: 'string', description: 'credential id (base64url)' },
        clientDataJSON: { type: 'string' },
        authenticatorData: { type: 'string' },
        signature: { type: 'string' },
      }, ['id', 'clientDataJSON', 'authenticatorData', 'signature']),
    }),
    Status: obj({
      id: { type: 'string' },
      owner: { type: 'string' },
      type: { type: 'string', enum: ['text', 'image'] },
      text: { type: 'string' },
      bg: { type: 'string', example: '#0670DE' },
      mediaId: { type: 'string', description: 'image: download from /media/{id}' },
      caption: { type: 'string' },
      ts: { type: 'integer' },
      expiresAt: { type: 'integer' },
      viewed: { type: 'boolean', description: "someone else's update you've seen" },
      views: arrayOf(obj({ username: { type: 'string' }, ts: { type: 'integer' } })),
    }, ['id', 'owner', 'type', 'ts', 'expiresAt']),
    ApiKey: obj({
      id: { type: 'string', example: 'key_3f9a1c2b7d4e' },
      name: { type: 'string' },
      preview: { type: 'string', example: 'cak_AbCd…wXyZ' },
      createdAt: { type: 'integer' },
      lastUsedAt: { type: ['integer', 'null'] },
    }),
    Webhook: obj({
      id: { type: 'string', example: 'wh_8e1d2c3b4a5f' },
      url: { type: 'string', format: 'uri' },
      events: arrayOf({ type: 'string' }),
      description: { type: 'string' },
      active: { type: 'boolean' },
      failures: { type: 'integer', description: 'failed deliveries in a row (switched off at 20)' },
      lastDelivery: { type: ['object', 'null'] },
      createdAt: { type: 'integer' },
    }),
    WebhookEvent: obj({
      id: { type: 'string', example: 'evt_9b8a7c6d5e4f3a2b' },
      event: { type: 'string', enum: webhookEvents },
      createdAt: { type: 'integer' },
      user: { type: 'string', description: 'the webhook owner this event is for' },
      data: { type: 'object', description: 'Same payload as the Socket.IO event of that name' },
    }, ['id', 'event', 'createdAt', 'user', 'data']),
    Session: obj({ token: { type: 'string' }, user: ref('User') }, ['token', 'user']),
    Subscription: obj({
      premium: { type: 'boolean' },
      plan: { type: ['string', 'null'], enum: ['daily', 'monthly', 'yearly', null] },
      expiresAt: { type: ['integer', 'null'], description: 'ms since epoch' },
      expired: { type: 'boolean', description: 'had Premium before, and it has ended' },
      limits: obj({ free: obj({ chatLocks: { type: 'integer' }, hiddenChats: { type: 'integer' } }), premium: { const: 'unlimited' } }),
      usage: obj({ chatLocks: { type: 'integer' }, hiddenChats: { type: 'integer' } }),
      plans: arrayOf(obj({ id: { type: 'string' }, label: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' } })),
      available: { type: 'boolean', description: 'payments are configured on this server' },
      sandbox: { type: 'boolean', description: 'development stand-in: orders are marked paid without payment' },
    }, ['premium', 'limits', 'usage', 'plans']),
    OtpSent: obj({
      requestId: { type: 'string', description: 'send this back with the code' },
      channel: { type: 'string', enum: ['sms', 'email'] },
      sentTo: { type: 'string', description: 'masked destination, e.g. `+91•••••••210`' },
      expiresIn: { type: 'integer', description: 'seconds the code stays valid (300)' },
      resendIn: { type: 'integer', description: 'seconds before another code can be sent (30)' },
      devCode: { type: 'string', description: 'only when the server runs with OTP_DEV_CODES=1 (development)' },
    }, ['requestId', 'channel', 'sentTo', 'expiresIn', 'resendIn']),
    OtpProof: obj({ requestId: { type: 'string' }, code: { type: 'string', pattern: '^\\d{6}$' } }, ['requestId', 'code']),
    Contact: obj({ phone: { type: ['string', 'null'], description: 'E.164, e.g. +919876543210' }, email: { type: ['string', 'null'] } }),
  };

  const errorResponse = (description) => ({ description, content: { 'application/json': { schema: ref('Error') } } });
  const responses = {
    E400: errorResponse('Invalid request'),
    E401: errorResponse('Missing or invalid credentials'),
    E403: errorResponse('Not allowed'),
    E404: errorResponse('Not found'),
    E409: errorResponse('Conflict (e.g. username taken, limit reached)'),
    E413: errorResponse('Body too large'),
    E415: errorResponse('Unsupported media type'),
    E423: errorResponse('The chat is locked: unlock it with POST /conversations/{id}/unlock (code `chat_locked`)'),
    E429: errorResponse('Rate limited, or a code was requested too soon (`otp_too_soon`, `otp_limit`); see Retry-After'),
    E503: errorResponse('Not available: the service is in maintenance (`maintenance`) or the feature is not configured on this server (e.g. `kyc_unavailable`, `payments_unavailable`)'),
    E426: errorResponse('The app is older than the minimum version the administrator allows (`update_required`)'),
    E402: errorResponse('Premium required (`premium_required`: free accounts can lock 3 chats and hide 1) or payment not received yet (`payment_pending`)'),
    E502: errorResponse('The SMS/email gateway could not send the code (`otp_delivery_failed`)'),
  };

  const T = { auth: 'Auth', me: 'Account', keys: 'API keys', hooks: 'Webhooks', users: 'Users', conv: 'Conversations', msg: 'Messages', status: 'Status', lock: 'Chat lock', hide: 'Hide chat', e2ee: 'Encryption', i18n: 'Translation', chan: 'Channels', biz: 'Business', meta: 'Meta' };

  const paths = {
    '/health': { get: op(T.meta, 'Health check', { auth: false, responses: { 200: ok(obj({ ok: { type: 'boolean' } })) } }) },

    '/config': {
      get: op(T.meta, 'App configuration: which features are on', {
        auth: false,
        description: 'Read this when your app starts (and again when the Socket.IO event `config:update` arrives). It says which features the administrator has switched on (hide the others in your UI: the server refuses them with `403 feature_disabled`), whether the service is in **maintenance** (every other call then answers `503 maintenance`), an **announcement** to show people, and the **minimum app version** (send your version in the `X-Client-Version` header, or `auth.clientVersion` on the socket; older apps get `426 update_required`). Mobile and web apps use the same endpoint.',
        responses: { 200: ok(obj({
          features: { type: 'object', additionalProperties: { type: 'boolean' }, example: { registration: true, calls: true, channels: false } },
          maintenance: obj({ on: { type: 'boolean' }, message: { type: 'string' } }, ['on']),
          announcement: { type: 'string' },
          minClientVersion: { type: ['string', 'null'] },
          limits: obj({ free: obj({ chatLocks: { type: 'integer' }, hiddenChats: { type: 'integer' } }) }),
        }, ['features', 'maintenance'])) },
      }),
    },
    '/auth/otp': {
      post: op(T.auth, 'Send a one-time code by SMS or email', {
        auth: false,
        description: [
          'Step 1 of sign-up and login. Send `phone` (international format, e.g. `+919876543210`) for an SMS code, or `email` for an email code.',
          'Codes have 6 digits, last 5 minutes and allow 5 wrong tries. Another code for the same address and purpose can be sent after 30 seconds; at most 5 codes per address per hour.',
          '`purpose: "register"` fails with 409 `phone_taken`/`email_taken` if the address already has an account; `purpose: "login"` fails with 404 `not_registered` if it has none.',
        ].join('\n\n'),
        body: jsonBody(obj({
          purpose: { type: 'string', enum: ['register', 'login'] },
          phone: { type: 'string' },
          email: { type: 'string', format: 'email' },
        }, ['purpose']), { purpose: 'register', phone: '+919876543210' }),
        responses: { 200: ok(ref('OtpSent')), ...errors(400, 404, 409, 429, 502) },
      }),
    },
    '/auth/register': {
      post: op(T.auth, 'Create an account (verified by OTP)', {
        auth: false,
        description: [
          '**Individual**: `displayName`, `phone` and `phoneOtp` (the `requestId` from `POST /auth/otp` and the code received by SMS).',
          '**Business**: `accountType: "business"`, the business name as `displayName`, `phone` + `phoneOtp`, `email` + `emailOtp` (both are required and verified) and `business` with at least a `category` (any other `Business` fields are optional).',
          'Every code is checked before any is used up, so a typo in one code does not cost the other. A username is made from the name unless you send `username`.',
        ].join('\n\n'),
        body: jsonBody(obj({
          accountType: { type: 'string', enum: ['individual', 'business'], default: 'individual' },
          displayName: { type: 'string', maxLength: 40 },
          username: { type: 'string', pattern: '^[a-z0-9_.]{3,20}$', description: 'optional' },
          phone: { type: 'string' },
          phoneOtp: ref('OtpProof'),
          email: { type: 'string', format: 'email', description: 'business only (required)' },
          emailOtp: ref('OtpProof'),
          business: ref('Business'),
        }, ['displayName', 'phone', 'phoneOtp']), {
          accountType: 'business',
          displayName: 'Pizza Palace',
          phone: '+919876543210',
          phoneOtp: { requestId: 'otp_6f1c…', code: '482913' },
          email: 'hello@pizza.example',
          emailOtp: { requestId: 'otp_a93e…', code: '105577' },
          business: { category: 'Restaurant', timezone: 'Asia/Kolkata' },
        }),
        responses: { 201: ok(ref('Session'), 'Account created; `token` is a login session'), ...errors(400, 409, 429) },
      }),
    },
    '/auth/login': {
      post: op(T.auth, 'Log in with a one-time code', {
        auth: false,
        description: 'Send the `phone` (or a business account\'s `email`) with the `requestId` from `POST /auth/otp` (`purpose: "login"`) and the `code`. Returns a session token; sessions end when the server restarts, so use an API key for long-running integrations. Accounts created before mobile login can still send `{ "username", "password" }`.',
        body: jsonBody(obj({
          phone: { type: 'string' },
          email: { type: 'string', format: 'email' },
          requestId: { type: 'string' },
          code: { type: 'string', pattern: '^\\d{6}$' },
          username: { type: 'string', description: 'older accounts only, with password' },
          password: { type: 'string', description: 'older accounts only' },
        }), { phone: '+919876543210', requestId: 'otp_6f1c…', code: '482913' }),
        responses: { 200: ok(ref('Session')), ...errors(400, 401, 404, 429) },
      }),
    },
    '/auth/logout': { post: op(T.auth, 'End this session', { responses: { 204: noContent, ...errors(401) } }) },

    '/me': {
      get: op(T.me, 'My profile', {
        responses: {
          200: ok(obj({
            user: ref('User'),
            blocked: arrayOf({ type: 'string' }),
            iceServers: arrayOf({ type: 'object' }),
            defaultDisappear: { type: ['integer', 'null'], description: 'timer (seconds) for chats you start' },
            business: { oneOf: [ref('Business'), { type: 'null' }] },
            contact: ref('Contact'),
            privacy: obj({ profileViews: { type: 'boolean' } }),
          })),
          ...errors(401),
        },
      }),
      patch: op(T.me, 'Update my profile', {
        body: jsonBody(obj({ displayName: { type: 'string' }, about: { type: 'string' } })),
        responses: { 200: ok(obj({ user: ref('User') })), ...errors(400, 401) },
      }),
    },

    '/channels': {
      get: op(T.chan, 'Discover public channels', {
        description: 'Search by name, handle, description or category; without `q` the most followed channels. Channels are public: anyone signed in can find, read and follow them.',
        params: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        responses: { 200: ok(obj({ channels: arrayOf(ref('Channel')), users: ref('Users') })), ...errors(401) },
      }),
      post: op(T.chan, 'Create a channel', {
        description: 'You become its owner and first follower. Up to 10 channels per person. The handle can\'t be changed later. **Channel posts are public and are not end-to-end encrypted.**',
        body: jsonBody(obj({ handle: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' } }, ['handle', 'name']), { handle: 'pune_food_news', name: 'Pune Food News', description: 'New openings and offers', category: 'Food' }),
        responses: { 201: ok(obj({ channel: ref('Channel') })), ...errors(400, 401, 409) },
      }),
    },
    '/me/channels': { get: op(T.chan, 'Channels I follow or own', { responses: { 200: ok(obj({ channels: arrayOf(ref('Channel')), users: ref('Users') })), ...errors(401) } }) },
    '/channels/{id}': {
      get: op(T.chan, 'A channel', { description: '`id` is the channel id or its handle.', params: [idParam('id')], responses: { 200: ok(obj({ channel: ref('Channel'), users: ref('Users') })), ...errors(401, 404) } }),
      patch: op(T.chan, 'Edit a channel (owner or admin)', {
        params: [idParam('id')],
        body: jsonBody(obj({ name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' } })),
        responses: { 200: ok(obj({ channel: ref('Channel') })), ...errors(400, 401, 403, 404) },
      }),
      delete: op(T.chan, 'Delete a channel and its posts (owner)', { params: [idParam('id')], responses: { 204: noContent, ...errors(401, 403, 404) } }),
    },
    '/channels/{id}/follow': {
      put: op(T.chan, 'Follow a channel', { params: [idParam('id')], responses: { 200: ok(obj({ channel: ref('Channel') })), ...errors(401, 404) } }),
      delete: op(T.chan, 'Unfollow a channel', { params: [idParam('id')], responses: { 200: ok(obj({ channel: ref('Channel') })), ...errors(401, 403, 404) } }),
    },
    '/channels/{id}/admins/{username}': {
      put: op(T.chan, 'Make someone an admin (owner)', { description: 'Admins can post, delete posts and edit the channel. Up to 5; they also follow the channel.', params: [idParam('id'), idParam('username')], responses: { 200: ok(obj({ channel: ref('Channel') })), ...errors(400, 401, 403, 404, 409) } }),
      delete: op(T.chan, 'Remove an admin (owner)', { params: [idParam('id'), idParam('username')], responses: { 200: ok(obj({ channel: ref('Channel') })), ...errors(401, 403, 404) } }),
    },
    '/channels/{id}/posts': {
      get: op(T.chan, 'Posts of a channel (oldest first)', {
        description: 'Public: no need to follow. Reading as a follower marks the channel read.',
        params: [idParam('id'), { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, { name: 'before', in: 'query', schema: { type: 'integer' }, description: 'only posts older than this timestamp; pass `nextBefore` to page back' }],
        responses: { 200: ok(obj({ posts: arrayOf(ref('ChannelPost')), hasMore: { type: 'boolean' }, nextBefore: { type: ['integer', 'null'] }, users: ref('Users') })), ...errors(401, 404) },
      }),
      post: op(T.chan, 'Publish a post (owner or admin)', {
        description: 'Followers receive it live (`channel:post`). 20 posts per minute.',
        params: [idParam('id')],
        body: jsonBody(obj({ text: { type: 'string', maxLength: 4000 } }, ['text']), { text: 'We open at 9 tomorrow! 🍕' }),
        responses: { 201: ok(obj({ post: ref('ChannelPost') })), ...errors(400, 401, 403, 404, 429) },
      }),
    },
    '/channels/{id}/posts/{postId}': { delete: op(T.chan, 'Delete a post (owner or admin)', { params: [idParam('id'), idParam('postId')], responses: { 204: noContent, ...errors(401, 403, 404) } }) },
    '/channels/{id}/read': { post: op(T.chan, 'Mark a channel read', { params: [idParam('id')], responses: { 204: noContent, ...errors(401, 404) } }) },
    '/channels/{id}/report': {
      post: op(T.chan, 'Report a channel', {
        description: 'One report per person per channel. Reports are kept for whoever runs the service to review (there is no admin screen yet).',
        params: [idParam('id')],
        body: jsonBody(obj({ reason: { type: 'string', maxLength: 200 } }, ['reason']), { reason: 'Spam' }),
        responses: { 204: noContent, ...errors(400, 401, 404) },
      }),
    },
    '/users/{username}/catalogue': {
      get: op(T.biz, 'A business\'s product catalogue', {
        description: 'Products with prices, for any business account (the profile\'s `business.productCount` says how many). Anyone signed in can look.',
        params: [idParam('username')],
        responses: { 200: ok(ref('Catalogue')), ...errors(401, 404) },
      }),
    },
    '/me/catalogue': { get: op(T.biz, 'My catalogue', { responses: { 200: ok(ref('Catalogue')), ...errors(401, 404) } }) },
    '/me/catalogue/currency': {
      put: op(T.biz, 'Currency for all prices', {
        body: jsonBody(obj({ currency: { type: 'string', pattern: '^[A-Za-z]{3}$' } }, ['currency']), { currency: 'USD' }),
        responses: { 200: ok(obj({ currency: { type: 'string' } })), ...errors(400, 401, 403) },
      }),
    },
    '/me/catalogue/products': {
      post: op(T.biz, 'Add a product', {
        description: 'Business accounts only; up to 100 products. `price: null` shows "price on request". Add a picture with `PUT /me/catalogue/products/{id}/image`.',
        body: jsonBody(obj({
          name: { type: 'string' }, description: { type: 'string' }, price: { type: ['number', 'null'] }, unit: { type: 'string' },
          category: { type: 'string' }, sku: { type: 'string' }, link: { type: 'string' }, available: { type: 'boolean', default: true },
        }, ['name']), { name: 'Margherita pizza', description: 'Wood-fired, 10 inch', price: 299, unit: 'each', category: 'Pizza' }),
        responses: { 201: ok(obj({ product: ref('Product') })), ...errors(400, 401, 403, 409) },
      }),
    },
    '/me/catalogue/products/{id}': {
      put: op(T.biz, 'Update a product', {
        description: 'Send only the fields to change; an empty string clears an optional text field.',
        params: [idParam('id')],
        body: jsonBody(obj({ name: { type: 'string' }, description: { type: 'string' }, price: { type: ['number', 'null'] }, unit: { type: 'string' }, category: { type: 'string' }, sku: { type: 'string' }, link: { type: 'string' }, available: { type: 'boolean' } }), { price: 349, available: false }),
        responses: { 200: ok(obj({ product: ref('Product') })), ...errors(400, 401, 403, 404) },
      }),
      delete: op(T.biz, 'Delete a product', { params: [idParam('id')], responses: { 204: noContent, ...errors(401, 403, 404) } }),
    },
    '/me/catalogue/products/{id}/image': {
      put: op(T.biz, 'Set a product picture', {
        description: 'Send the picture itself (`image/jpeg`, `image/png` or `image/webp`, max 1 MB). Replaces the old one.',
        params: [idParam('id')],
        body: { required: true, content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } },
        responses: { 200: ok(obj({ product: ref('Product') })), ...errors(401, 404, 413, 415) },
      }),
      delete: op(T.biz, 'Remove a product picture', { params: [idParam('id')], responses: { 200: ok(obj({ product: ref('Product') })), ...errors(401, 404) } }),
    },
    '/translate/languages': {
      get: op(T.i18n, 'Languages for translating received messages', {
        responses: { 200: ok(obj({ languages: arrayOf(obj({ code: { type: 'string' }, name: { type: 'string' }, native: { type: 'string' } })), available: { type: 'boolean' }, sandbox: { type: 'boolean' } })), ...errors(401) },
      }),
    },
    '/conversations/{id}/translation': {
      put: op(T.i18n, 'Choose the language received messages of a chat are shown in', {
        description: 'Per chat (so per contact in a one-to-one chat), private to you, synced across your devices. `lang: null` turns it off. The chat summary then has `translateTo`. Because messages are end-to-end encrypted, translating means your app sends the decrypted text of received messages to the translation service (not stored); the app asks you before turning it on.',
        params: [CONV_ID],
        body: jsonBody(obj({ lang: { type: ['string', 'null'] } }, ['lang']), { lang: 'hi' }),
        responses: { 200: ok(obj({ convId: { type: 'string' }, lang: { type: ['string', 'null'] } })), ...errors(400, 401, 404, 503) },
      }),
    },
    '/conversations/{id}/translate': {
      post: op(T.i18n, 'Translate texts into the chat\'s language', {
        description: 'Send up to 30 texts (4000 characters each) that your app has already decrypted; get them back translated, in the same order, with the detected source language. Only works for chats where translation is on (`400 translation_off`). Texts are passed to the translation service and not stored or logged. 120 texts per minute.',
        params: [CONV_ID],
        body: jsonBody(obj({ texts: arrayOf({ type: 'string' }) }, ['texts']), { texts: ['Good morning! Is the order ready?'] }),
        responses: { 200: ok(obj({ target: { type: 'string' }, translations: arrayOf(obj({ text: { type: 'string' }, detected: { type: ['string', 'null'] } })) })), ...errors(400, 401, 404, 423, 429, 502, 503) },
      }),
    },
    '/users/{username}/view': {
      post: op(T.users, 'Record that I viewed someone\'s profile', {
        description: 'Call this when your app opens a person\'s profile. They can then see you in **Who viewed my profile** with the date of your last view, whether or not you are in their contacts. Nothing is recorded when you or they have profile views turned off, when either of you has blocked the other, or when you view yourself. Only your latest view is kept.',
        params: [idParam('username')],
        responses: { 204: noContent, ...errors(401, 404) },
      }),
    },
    '/me/profile-views': {
      get: op(T.me, 'Who viewed my profile', {
        description: 'Everyone who viewed your profile in the last 90 days, newest first, each with `inContact` (you have a one-to-one chat with messages) and `lastViewedAt`. Empty with `enabled: false` when you turned profile views off.',
        responses: { 200: ok(obj({ enabled: { type: 'boolean' }, retentionDays: { type: 'integer' }, viewers: arrayOf(obj({ user: ref('User'), inContact: { type: 'boolean' }, lastViewedAt: { type: 'integer', description: 'ms since epoch' } }, ['user', 'inContact', 'lastViewedAt'])) }, ['enabled', 'viewers'])), ...errors(401) },
      }),
    },
    '/me/privacy': {
      put: op(T.me, 'Privacy settings', {
        description: '`profileViews: false` stops recording your own views of other people, hides who viewed you, and erases your current list. It is a trade: with it off you can\'t see viewers either.',
        body: jsonBody(obj({ profileViews: { type: 'boolean' } }, ['profileViews']), { profileViews: false }),
        responses: { 200: ok(obj({ privacy: obj({ profileViews: { type: 'boolean' } }) })), ...errors(400, 401) },
      }),
    },
    '/me/subscription': {
      get: op(T.me, 'Plan, limits and usage', {
        description: '**Free** accounts can lock up to 3 chats and hide 1 chat. **Premium** has no limits. Premium is bought in advance as a daily, monthly or yearly plan (no auto-renewal); buying while Premium extends it. When it ends, chats that are already locked or hidden stay protected, but no more can be added until Premium is renewed.',
        responses: { 200: ok(ref('Subscription')), ...errors(401) },
      }),
    },
    '/me/subscription/checkout': {
      post: op(T.me, 'Start paying for a plan', {
        description: 'Creates an order and returns the provider\'s `paymentUrl` (open it so the person can pay; card details never touch ChatApp). `paymentUrl` is null in the sandbox, where no real payment is taken. Then call `POST /me/subscription/confirm`.',
        body: jsonBody(obj({ plan: { type: 'string', enum: ['daily', 'monthly', 'yearly'] } }, ['plan']), { plan: 'monthly' }),
        responses: { 200: ok(obj({ orderId: { type: 'string' }, plan: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' }, paymentUrl: { type: ['string', 'null'] }, sandbox: { type: 'boolean' } }, ['orderId', 'plan', 'amount', 'currency'])), ...errors(400, 401, 429, 502, 503) },
      }),
    },
    '/me/subscription/confirm': {
      post: op(T.me, 'Confirm payment and switch Premium on', {
        description: 'The server asks the payment provider whether the order was paid (nothing from the client is trusted). `402 payment_pending` means not paid yet: try again after paying. Each order can be used once.',
        body: jsonBody(obj({ orderId: { type: 'string' } }, ['orderId']), { orderId: 'ord_…' }),
        responses: { 200: ok(ref('Subscription')), ...errors(401, 402, 404, 502, 503) },
      }),
    },
    '/me/verification': {
      get: op(T.me, 'Verified-badge status', {
        description: 'Whether the account is verified, whether verification is available on this server, and the ID types accepted (personal accounts and business accounts accept different ones).',
        responses: { 200: ok(obj({ verified: { type: 'boolean' }, available: { type: 'boolean' }, sandbox: { type: 'boolean', description: 'development stand-in: verifies anyone' }, types: arrayOf(obj({ id: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' } })) })), ...errors(401) },
      }),
      post: op(T.me, 'Finish verification with the code', {
        description: 'Send the `requestId` from `POST /me/verification/otp` and the code the person received. On success the account gets the **Verified** badge (`user.verified: true`, visible to everyone). **No KYC information is stored**: only the fact that it is verified. Changing the display name removes the badge until the person verifies again.',
        body: jsonBody(obj({ requestId: { type: 'string' }, otp: { type: 'string' } }, ['requestId', 'otp']), { requestId: 'kyc_…', otp: '482913' }),
        responses: { 200: ok(obj({ verified: { type: 'boolean' }, user: ref('User') })), ...errors(400, 401, 502, 503) },
      }),
    },
    '/me/verification/otp': {
      post: op(T.me, 'Start identity verification (KYC)', {
        description: 'Send the ID `type` (e.g. `aadhaar`, `pan`, `passport`; business accounts: `gstin`, `cin`, `pan`) and `idNumber`. The number is checked for format and passed to the verification gateway, which sends a one-time code to the mobile number linked to the ID; it is **never stored or logged** by ChatApp. 3 attempts per hour. Finish with `POST /me/verification`.',
        body: jsonBody(obj({ type: { type: 'string' }, idNumber: { type: 'string' } }, ['type', 'idNumber']), { type: 'pan', idNumber: 'ABCDE1234F' }),
        responses: { 200: ok(obj({ requestId: { type: 'string' }, expiresIn: { type: 'integer' }, sentTo: { type: 'string' }, devCode: { type: 'string', description: 'sandbox with OTP_DEV_CODES=1 only' } }, ['requestId', 'expiresIn'])), ...errors(400, 401, 409, 429, 502, 503) },
      }),
    },
    '/me/contact/otp': {
      post: op(T.me, 'Send a code to add or change my mobile number or email', {
        description: 'Send `phone` or `email`. Then confirm with `PUT /me/contact`. A business account needs both a verified mobile number and email.',
        body: jsonBody(obj({ phone: { type: 'string' }, email: { type: 'string', format: 'email' } }), { email: 'owner@pizza.example' }),
        responses: { 200: ok(ref('OtpSent')), ...errors(400, 401, 409, 429, 502) },
      }),
    },
    '/me/contact': {
      put: op(T.me, 'Save a verified mobile number or email', {
        description: 'The same `phone` or `email` as in `POST /me/contact/otp`, with its `requestId` and `code`. A business\'s contact email follows the verified email.',
        body: jsonBody(obj({ phone: { type: 'string' }, email: { type: 'string', format: 'email' }, requestId: { type: 'string' }, code: { type: 'string' } }, ['requestId', 'code']),
          { email: 'owner@pizza.example', requestId: 'otp_a93e…', code: '105577' }),
        responses: { 200: ok(obj({ contact: ref('Contact'), business: { oneOf: [ref('Business'), { type: 'null' }] } })), ...errors(400, 401, 409) },
      }),
    },
    '/me/default-disappearing': {
      put: op(T.me, 'Default message timer for chats you start', {
        description: 'Seconds from 60 (1 minute) to 31536000 (365 days); 0 or null turns it off. Applies to new chats you start; existing chats keep their timer.',
        body: jsonBody(obj({ seconds: { type: ['integer', 'null'] } }, ['seconds']), { seconds: 7 * 86400 }),
        responses: { 200: ok(obj({ defaultDisappear: { type: ['integer', 'null'] } })), ...errors(400, 401) },
      }),
    },
    '/me/business': {
      get: op(T.biz, 'My business profile', { responses: { 200: ok(obj({ business: { oneOf: [ref('Business'), { type: 'null' }] } })), ...errors(401) } }),
      put: op(T.biz, 'Become a business account, or update it', {
        description: 'Needs a verified mobile number and email on the account (400 `verification_required` otherwise; see `/me/contact`). The contact `email` is always the verified email. Everyone sees the business details and hours (with your profile). Greeting and away message texts stay private; they are sent automatically.',
        body: jsonBody(ref('Business'), {
          category: 'Restaurant',
          description: 'Wood-fired pizza since 1998',
          address: '12 Market St, Pune',
          email: 'hello@pizza.example',
          website: 'https://pizza.example',
          timezone: 'Asia/Kolkata',
          hours: { mon: { mode: 'hours', open: '11:00', close: '23:00' }, tue: { mode: 'closed' }, sat: { mode: 'open24' } },
          greeting: { enabled: true, text: 'Thanks for messaging us! How can we help?' },
          away: { enabled: true, text: "We're closed right now and will reply when we open." },
        }),
        responses: { 200: ok(obj({ business: ref('Business'), user: ref('User') })), ...errors(400, 401) },
      }),
      delete: op(T.biz, 'Switch back to a personal account', { responses: { 200: ok(obj({ business: { type: 'null' }, user: ref('User') })), ...errors(401) } }),
    },

    '/api-keys': {
      get: op(T.keys, 'List my API keys', { responses: { 200: ok(obj({ apiKeys: arrayOf(ref('ApiKey')) })), ...errors(401) } }),
      post: op(T.keys, 'Create an API key', {
        description: 'Needs a login session token. The returned `key` is shown only once; store it securely. Use it like a token: `Authorization: Bearer cak_…`.',
        body: jsonBody(obj({ name: { type: 'string', example: 'CRM integration' } })),
        responses: { 201: ok(obj({ key: { type: 'string' }, apiKey: ref('ApiKey') })), ...errors(401, 403, 409) },
      }),
    },
    '/api-keys/{id}': { delete: op(T.keys, 'Revoke an API key', { params: [idParam('id')], responses: { 204: noContent, ...errors(401, 404) } }) },

    '/webhooks': {
      get: op(T.hooks, 'List my webhooks', { responses: { 200: ok(obj({ webhooks: arrayOf(ref('Webhook')), events: arrayOf({ type: 'string' }) })), ...errors(401) } }),
      post: op(T.hooks, 'Create a webhook', {
        description: 'Events for you are POSTed to `url` (see the Webhooks section). `events` defaults to `["*"]` = everything except `typing` and `presence`. The `secret` (shown once) signs deliveries.',
        body: jsonBody(obj({ url: { type: 'string', format: 'uri' }, events: arrayOf({ type: 'string', enum: ['*', ...webhookEvents] }), description: { type: 'string' } }, ['url']),
          { url: 'https://example.com/chatapp/webhook', events: ['message:new', 'call:incoming'] }),
        responses: { 201: ok(obj({ secret: { type: 'string' }, webhook: ref('Webhook') })), ...errors(400, 401, 409) },
      }),
    },
    '/webhooks/{id}': {
      get: op(T.hooks, 'Get a webhook (with its last delivery)', { params: [idParam('id')], responses: { 200: ok(obj({ webhook: ref('Webhook') })), ...errors(401, 404) } }),
      patch: op(T.hooks, 'Turn a webhook on/off or change its events', {
        params: [idParam('id')],
        body: jsonBody(obj({ active: { type: 'boolean' }, events: arrayOf({ type: 'string' }) })),
        responses: { 200: ok(obj({ webhook: ref('Webhook') })), ...errors(400, 401, 404) },
      }),
      delete: op(T.hooks, 'Delete a webhook', { params: [idParam('id')], responses: { 204: noContent, ...errors(401, 404) } }),
    },
    '/webhooks/{id}/test': {
      post: op(T.hooks, 'Send a test `ping` event', {
        params: [idParam('id')],
        responses: { 200: ok(obj({ result: obj({ ok: { type: 'boolean' }, status: { type: ['integer', 'null'] }, error: { type: ['string', 'null'] } }) })), ...errors(401, 404) },
      }),
    },

    '/users': {
      get: op(T.users, 'Search people', {
        params: [{ name: 'q', in: 'query', schema: { type: 'string' }, description: 'matches username or display name' }],
        responses: { 200: ok(obj({ users: arrayOf(ref('User')) })), ...errors(401) },
      }),
    },
    '/users/{username}': { get: op(T.users, 'Get a user', { params: [idParam('username')], responses: { 200: ok(obj({ user: ref('User'), blocked: { type: 'boolean' } })), ...errors(401, 404) } }) },
    '/blocked': { get: op(T.users, 'People I have blocked', { responses: { 200: ok(obj({ blocked: arrayOf({ type: 'string' }) })), ...errors(401) } }) },
    '/blocked/{username}': {
      put: op(T.users, 'Block someone', { params: [idParam('username')], responses: { 200: ok(obj({ blocked: arrayOf({ type: 'string' }), user: ref('User') })), ...errors(401, 403, 404) } }),
      delete: op(T.users, 'Unblock someone', { params: [idParam('username')], responses: { 200: ok(obj({ blocked: arrayOf({ type: 'string' }), user: ref('User') })), ...errors(401, 404) } }),
    },

    '/conversations': {
      get: op(T.conv, 'My conversations (newest first)', { responses: { 200: ok(obj({ conversations: arrayOf(ref('Conversation')), users: ref('Users') })), ...errors(401) } }),
      post: op(T.conv, 'Open a direct chat or create a group', {
        description: 'Direct: `{ "type": "direct", "username": "bob" }` returns the existing chat if there is one. Group: `{ "type": "group", "name": "Team", "members": ["bob", "carol"] }`.',
        body: jsonBody({
          oneOf: [
            obj({ type: { const: 'direct' }, username: { type: 'string' } }, ['type', 'username']),
            obj({ type: { const: 'group' }, name: { type: 'string' }, members: arrayOf({ type: 'string' }) }, ['type', 'name', 'members']),
          ],
        }, { type: 'direct', username: 'bob' }),
        responses: { 201: ok(obj({ conversation: ref('Conversation') })), ...errors(400, 401, 404) },
      }),
    },
    '/conversations/{id}': { get: op(T.conv, 'Get a conversation', { params: [CONV_ID], responses: { 200: ok(obj({ conversation: ref('Conversation'), users: ref('Users') })), ...errors(401, 404) } }) },
    '/conversations/{id}/messages': {
      get: op(T.msg, 'Message history (oldest first)', {
        params: [
          CONV_ID,
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'before', in: 'query', schema: { type: 'integer' }, description: 'only messages older than this timestamp; pass `nextBefore` to page back' },
        ],
        responses: { 200: ok(obj({ messages: arrayOf(ref('Message')), hasMore: { type: 'boolean' }, nextBefore: { type: ['integer', 'null'] } })), ...errors(401, 404, 423) },
      }),
      post: op(T.msg, 'Send a text message', {
        description: 'Send `Idempotency-Key` (or `clientId` in the body) to make retries safe: the same key returns the original message instead of sending twice.\n\nPlain `text` sent through the API is **not** end-to-end encrypted (the server sees it, and it is shown to recipients as unencrypted). To send an end-to-end encrypted message, encrypt on your own device and send an `e2ee` envelope instead of `text` (see **Encryption**). A stale device list answers `409 keys_changed`: fetch `GET /conversations/{id}/keys` and encrypt again.',
        params: [CONV_ID, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 64 } }],
        body: jsonBody(obj({ text: { type: 'string', maxLength: 4000 }, masked: { type: 'boolean' }, clientId: { type: 'string' }, e2ee: ref('Envelope') }), { text: 'Hello from the API 👋' }),
        responses: { 201: ok(obj({ message: ref('Message') })), ...errors(400, 401, 403, 404, 409, 423, 429) },
      }),
    },
    '/conversations/{id}/voice': {
      post: op(T.msg, 'Send a voice message', {
        description: 'Body: the audio file itself (max 3 MB), with its Content-Type (e.g. `audio/ogg`, `audio/webm`, `audio/mp4`, `audio/mpeg`).',
        params: [
          CONV_ID,
          { name: 'duration', in: 'query', schema: { type: 'number' }, description: 'seconds' },
          { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
        ],
        body: { required: true, content: { 'audio/*': { schema: { type: 'string', format: 'binary' } } } },
        responses: { 201: ok(obj({ message: ref('Message') })), ...errors(400, 401, 404, 413, 415, 423) },
      }),
    },
    '/conversations/{id}/read': { post: op(T.msg, 'Mark everything in the chat as read', { params: [CONV_ID], responses: { 200: ok(obj({ updated: { type: 'integer' } })), ...errors(401, 404) } }) },
    '/conversations/{id}/typing': {
      post: op(T.msg, 'Show "typing…" / "recording audio…" to the others', {
        description: 'Clients hide the indicator after ~5 s, so repeat every few seconds while it applies.',
        params: [CONV_ID],
        body: jsonBody(obj({ isTyping: { type: 'boolean', default: true }, activity: { type: 'string', enum: ['typing', 'recording'] } })),
        responses: { 204: noContent, ...errors(401, 404) },
      }),
    },
    '/conversations/{id}/disappearing': {
      put: op(T.conv, 'Turn disappearing messages on/off for a chat', {
        description: 'New messages are deleted for everyone `seconds` after they are sent (60 … 31536000, i.e. 1 minute to 365 days; 0 or null = off). Any member can change it; everyone sees a notice.',
        params: [CONV_ID],
        body: jsonBody(obj({ seconds: { type: ['integer', 'null'] } }, ['seconds']), { seconds: 2 * 86400 + 4 * 3600 }),
        responses: { 200: ok(obj({ conversation: ref('Conversation') })), ...errors(400, 401, 404, 423) },
      }),
    },
    '/conversations/{id}/call': {
      get: op(T.conv, 'The call running in this chat, if any', {
        description: 'Placing and answering calls needs WebRTC in a client connected over Socket.IO (see README).',
        params: [CONV_ID],
        responses: { 200: ok(obj({ call: { oneOf: [ref('ActiveCall'), { type: 'null' }] } })), ...errors(401, 404) },
      }),
    },
    '/messages/{id}': { delete: op(T.msg, 'Delete my message for everyone', { params: [idParam('id')], responses: { 204: noContent, ...errors(401, 403, 404) } }) },
    '/messages/{id}/star': {
      put: op(T.msg, 'Star a message (private to you)', { params: [idParam('id')], responses: { 200: ok(obj({ message: ref('Message') })), ...errors(401, 403, 404) } }),
      delete: op(T.msg, 'Unstar a message', { params: [idParam('id')], responses: { 200: ok(obj({ message: ref('Message') })), ...errors(401, 404) } }),
    },
    '/starred': { get: op(T.msg, 'My starred messages (newest first)', { responses: { 200: ok(obj({ messages: arrayOf(ref('Message')) })), ...errors(401) } }) },
    '/media/{id}': {
      get: op(T.msg, 'Download voice-message audio or a status photo', {
        params: [idParam('id')],
        responses: { 200: { description: 'The file', content: { 'audio/*': {}, 'image/*': {} } }, ...errors(401, 404, 423) },
      }),
    },

    '/chat-lock': {
      get: op(T.lock, 'Chat lock settings', {
        description: [
          'Lock chats with a secret code. A locked chat\'s messages are withheld (`locked: true`, no content; `423 chat_locked` for history, sending and its voice notes) until it is unlocked **in that session**.',
          'For the REST API a session is the credential, optionally narrowed with an `X-App-Session` header; for the web app it is one page load. New logins start locked.',
          'Webhooks never receive the content of locked chats. 5 wrong codes lock out further tries, for 1 minute and then doubling up to an hour.',
        ].join('\n\n'),
        responses: { 200: ok(ref('ChatLock')), ...errors(401) },
      }),
    },
    '/chat-lock/code': {
      put: op(T.lock, 'Set or change the secret code', {
        body: jsonBody(obj({ code: { type: 'string', minLength: 4, maxLength: 32 }, currentCode: { type: 'string', description: 'required when changing an existing code' } }, ['code']), { code: '2468' }),
        responses: { 200: ok(ref('ChatLock')), ...errors(400, 401, 403, 429) },
      }),
    },
    '/chat-lock/reset/otp': {
      post: op(T.lock, 'Forgot the code: get an SMS code on my mobile number', {
        description: 'Then call `POST /chat-lock/reset` with the `requestId`, the `code` and a `newCode`.',
        responses: { 200: ok(ref('OtpSent')), ...errors(400, 401, 429, 502) },
      }),
    },
    '/chat-lock/reset': {
      post: op(T.lock, 'Forgot the code: set a new one', {
        description: 'Prove it is you with the SMS code from `POST /chat-lock/reset/otp` (`requestId` + `code`), or, for accounts created before mobile login, the account `password`.',
        body: jsonBody(obj({
          requestId: { type: 'string' },
          code: { type: 'string' },
          password: { type: 'string' },
          newCode: { type: 'string', minLength: 4, maxLength: 32 },
        }, ['newCode']), { requestId: 'otp_77d0…', code: '391024', newCode: '2468' }),
        responses: { 200: ok(ref('ChatLock')), ...errors(400, 401, 403, 429) },
      }),
    },
    '/chat-lock/relock': {
      post: op(T.lock, 'Lock again every chat unlocked in this session', { responses: { 200: ok(ref('ChatLock')), ...errors(401) } }),
    },
    '/conversations/{id}/lock': {
      put: op(T.lock, 'Lock a chat', {
        description: 'Needs a secret code to have been set. Takes effect immediately in every session. Free accounts can lock up to 3 chats (`402 premium_required` after that).',
        params: [CONV_ID],
        responses: { 200: ok(ref('ChatLock')), ...errors(400, 401, 402, 404) },
      }),
      delete: op(T.lock, 'Remove the lock from a chat', {
        params: [CONV_ID],
        description: 'Send the secret code or a fingerprint/face proof.',
        body: jsonBody(ref('Proof'), { code: '1234' }),
        responses: { 200: ok(ref('ChatLock')), ...errors(401, 403, 404, 429) },
      }),
    },
    '/conversations/{id}/unlock': {
      post: op(T.lock, 'Unlock a locked chat for this session', {
        params: [CONV_ID, { name: 'X-App-Session', in: 'header', schema: { type: 'string' }, description: 'optional: scope the unlock to one app session of this credential' }],
        description: 'Send the secret code or a fingerprint/face proof. For a hidden chat this reveals all hidden chats (like `POST /hidden-chats/reveal`).',
        body: jsonBody(ref('Proof'), { code: '1234' }),
        responses: { 200: ok(obj({ conversation: ref('Conversation') })), ...errors(401, 403, 404, 429) },
      }),
    },

    '/chat-lock/clear': {
      post: op(T.lock, 'Remove the lock from all locked chats', {
        description: 'Needs the secret code or a fingerprint/face proof. Returns how many chats were unlocked for good (`cleared`).',
        body: jsonBody(ref('Proof'), { code: '1234' }),
        responses: { 200: ok(obj({ cleared: { type: 'integer' }, hasCode: { type: 'boolean' }, lockedChats: arrayOf({ type: 'string' }), hiddenCount: { type: 'integer' } })), ...errors(400, 401, 403, 429) },
      }),
    },
    '/conversations/{id}/hide': {
      put: op(T.hide, 'Hide a chat', {
        description: 'Takes the chat out of the chat list. Free accounts can hide 1 chat (`402 premium_required` after that). Needs a secret code to have been set (400 `code_required`). A hidden chat sends nothing (messages, previews, typing, webhooks) to a session until it reveals hidden chats. Hiding replaces the chat\'s own lock. Takes effect in every session.',
        params: [CONV_ID],
        responses: { 200: ok(ref('ChatLock')), ...errors(400, 401, 402, 404) },
      }),
      delete: op(T.hide, 'Unhide a chat (put it back in the chat list)', {
        description: 'The session must have revealed hidden chats (423 `chat_locked` otherwise).',
        params: [CONV_ID],
        responses: { 200: ok(obj({ conversation: ref('Conversation') })), ...errors(401, 404, 423) },
      }),
    },
    '/e2ee/devices': {
      get: op(T.e2ee, 'My devices with encryption keys', { responses: { 200: ok(obj({ devices: arrayOf(ref('Device')) })), ...errors(401) } }),
      post: op(T.e2ee, 'Register a device public key', {
        description: 'Each device (browser, phone, bot) makes its own P-256 key pair and sends only the public key. Registering the same key again returns the same device. Up to 5 devices; a device can only read messages sent after it was registered.',
        body: jsonBody(obj({ name: { type: 'string', maxLength: 40 }, publicKey: { type: 'string', description: 'raw P-256 point (65 bytes), base64url' } }, ['publicKey']), { name: 'Laptop', publicKey: 'BAcS…' }),
        responses: { 201: ok(obj({ device: ref('Device'), devices: arrayOf(ref('Device')) })), ...errors(400, 401, 409) },
      }),
    },
    '/e2ee/devices/{id}': {
      delete: op(T.e2ee, 'Remove a device', { params: [idParam('id')], responses: { 200: ok(obj({ devices: arrayOf(ref('Device')) })), ...errors(401, 404) } }),
    },
    '/conversations/{id}/keys': {
      get: op(T.e2ee, 'Public keys of everyone in a chat', {
        description: 'The devices of every member (yours included): encrypt for all of them, and use them to check who sent a message. Anyone without a device has not set up encryption.',
        params: [CONV_ID],
        responses: { 200: ok(obj({ keys: { type: 'object', additionalProperties: arrayOf(ref('Device')) } })), ...errors(401, 404) },
      }),
    },
    '/hidden-contacts/{username}': {
      put: op(T.hide, 'Hide the chat with a specific contact', {
        description: 'Like `PUT /conversations/{id}/hide`, but by username, and it works before the contact has ever messaged you: their first message stays hidden too. Returns the settings and the `convId`. Needs a secret code (400 `code_required`).',
        params: [idParam('username')],
        responses: { 200: ok(ref('ChatLock')), ...errors(400, 401, 402, 404) },
      }),
    },
    '/hidden-chats': {
      get: op(T.hide, 'My hidden chats', {
        description: 'Only after `POST /hidden-chats/reveal` in this session (423 `chat_locked` otherwise).',
        responses: { 200: ok(obj({ conversations: arrayOf(ref('Conversation')), users: ref('Users') })), ...errors(401, 423) },
      }),
    },
    '/hidden-chats/reveal': {
      post: op(T.hide, 'Open hidden chats for this session', {
        description: 'Prove it is you with the secret code or a fingerprint/face proof. Lasts for this app session (`X-App-Session`, or the credential). Wrong tries share the chat-lock limit (5, then a growing wait).',
        params: [{ name: 'X-App-Session', in: 'header', schema: { type: 'string' }, description: 'optional: scope to one app session of this credential' }],
        body: jsonBody(ref('Proof'), { code: '1234' }),
        responses: { 200: ok(obj({ conversations: arrayOf(ref('Conversation')), users: ref('Users') })), ...errors(401, 403, 429) },
      }),
    },
    '/hidden-chats/close': {
      post: op(T.hide, 'Close hidden chats again in this session', { responses: { 200: ok(ref('ChatLock')), ...errors(401) } }),
    },
    '/hidden-chats/clear': {
      post: op(T.hide, 'Bring all hidden chats back to the chat list', {
        description: 'Needs the secret code or a fingerprint/face proof. Nothing is deleted; the chats simply stop being hidden. Returns how many (`cleared`).',
        body: jsonBody(ref('Proof'), { code: '1234' }),
        responses: { 200: ok(obj({ cleared: { type: 'integer' }, hasCode: { type: 'boolean' }, lockedChats: arrayOf({ type: 'string' }), hiddenCount: { type: 'integer' } })), ...errors(400, 401, 403, 429) },
      }),
    },
    '/biometric/challenge': {
      post: op(T.hide, 'Get a challenge for fingerprint/face lock', {
        description: 'WebAuthn: pass `challenge` to `navigator.credentials.create` (to set up a device) or `.get` (to prove it is you, with `credentials` as `allowCredentials`). One use, valid for 2 minutes. The rpId is the site\'s host name.',
        responses: { 200: ok(obj({ challenge: { type: 'string' }, userId: { type: 'string' }, credentials: arrayOf({ type: 'string' }) })), ...errors(401) },
      }),
    },
    '/biometric': {
      post: op(T.hide, 'Set up fingerprint/face lock on a device', {
        description: 'Confirm with the secret code, and send the result of `navigator.credentials.create` (platform authenticator, user verification required): `id`, `clientDataJSON`, `authenticatorData` (`response.getAuthenticatorData()`), `publicKey` (`response.getPublicKey()`) and `alg`, all base64url. Up to 5 devices.',
        body: jsonBody(obj({
          code: { type: 'string' },
          name: { type: 'string', description: 'device name, e.g. "My phone"' },
          credential: obj({ id: { type: 'string' }, clientDataJSON: { type: 'string' }, authenticatorData: { type: 'string' }, publicKey: { type: 'string' }, alg: { type: 'integer', enum: [-7, -257] } }, ['id', 'clientDataJSON', 'authenticatorData', 'publicKey', 'alg']),
        }, ['code', 'credential'])),
        responses: { 201: ok(ref('ChatLock')), ...errors(400, 401, 403, 429) },
      }),
    },
    '/biometric/{id}': {
      delete: op(T.hide, 'Remove fingerprint/face lock from a device', {
        params: [idParam('id', 'credential id')],
        body: jsonBody(ref('Proof'), { code: '1234' }),
        responses: { 200: ok(ref('ChatLock')), ...errors(400, 401, 403, 429) },
      }),
    },

    '/statuses': {
      get: op(T.status, 'Status updates I can see', {
        description: 'Live (not expired) updates from people you have a one-to-one chat with, plus your own (with `views`). Oldest first.',
        responses: { 200: ok(obj({ statuses: arrayOf(ref('Status')), users: ref('Users') })), ...errors(401) },
      }),
      post: op(T.status, 'Post a status update (visible for 24 hours)', {
        description: 'Text: JSON `{ "type": "text", "text": "…", "bg": "#0670DE" }`. Photo: send the image itself (`image/jpeg|png|webp|gif`, max 3 MB) with `?caption=`.',
        params: [{ name: 'caption', in: 'query', schema: { type: 'string' }, description: 'photo updates only' }],
        body: {
          required: true,
          content: {
            'application/json': { schema: obj({ type: { const: 'text' }, text: { type: 'string', maxLength: 700 }, bg: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, ['text']), example: { type: 'text', text: 'Hello world', bg: '#25a3e0' } },
            'image/*': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: { 201: ok(obj({ status: ref('Status') })), ...errors(400, 401, 413, 415) },
      }),
    },
    '/statuses/{id}': { delete: op(T.status, 'Delete my status update', { params: [idParam('id')], responses: { 204: noContent, ...errors(401, 404) } }) },
    '/statuses/{id}/view': { post: op(T.status, 'Mark a status update as seen', { params: [idParam('id')], responses: { 204: noContent, ...errors(401, 404) } }) },
    '/statuses/{id}/replies': {
      post: op(T.status, 'Reply to a status update', {
        description: 'Sent as a message in your one-to-one chat with its owner.',
        params: [idParam('id'), { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        body: jsonBody(obj({ text: { type: 'string' } }, ['text'])),
        responses: { 201: ok(obj({ message: ref('Message'), conversation: ref('Conversation') })), ...errors(400, 401, 404) },
      }),
    },
  };

  const webhooks = Object.fromEntries(webhookEvents.map((event) => [event, {
    post: {
      summary: `"${event}" event`,
      description: 'Headers: `X-ChatApp-Event`, `X-ChatApp-Delivery`, `X-ChatApp-Timestamp` and `X-ChatApp-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`. Reply 2xx within 5 s; failures are retried after 2 s, 10 s and 60 s.',
      requestBody: { content: { 'application/json': { schema: ref('WebhookEvent') } } },
      responses: { 200: { description: 'Received' } },
    },
  }]));

  // Stable names for generated clients (e.g. client.sendMessage(...)).
  const OPERATION_IDS = {
    'get /health': 'health',
    'get /config': 'getConfig',
    'post /auth/otp': 'requestOtp',
    'post /auth/register': 'register',
    'post /auth/login': 'login',
    'post /auth/logout': 'logout',
    'get /me': 'getMe',
    'patch /me': 'updateMe',
    'get /channels': 'searchChannels',
    'post /channels': 'createChannel',
    'get /me/channels': 'listMyChannels',
    'get /channels/{id}': 'getChannel',
    'patch /channels/{id}': 'updateChannel',
    'delete /channels/{id}': 'deleteChannel',
    'put /channels/{id}/follow': 'followChannel',
    'delete /channels/{id}/follow': 'unfollowChannel',
    'put /channels/{id}/admins/{username}': 'addChannelAdmin',
    'delete /channels/{id}/admins/{username}': 'removeChannelAdmin',
    'get /channels/{id}/posts': 'listChannelPosts',
    'post /channels/{id}/posts': 'publishChannelPost',
    'delete /channels/{id}/posts/{postId}': 'deleteChannelPost',
    'post /channels/{id}/read': 'markChannelRead',
    'post /channels/{id}/report': 'reportChannel',
    'get /users/{username}/catalogue': 'getCatalogue',
    'get /me/catalogue': 'getMyCatalogue',
    'put /me/catalogue/currency': 'setCatalogueCurrency',
    'post /me/catalogue/products': 'addProduct',
    'put /me/catalogue/products/{id}': 'updateProduct',
    'delete /me/catalogue/products/{id}': 'deleteProduct',
    'put /me/catalogue/products/{id}/image': 'setProductImage',
    'delete /me/catalogue/products/{id}/image': 'removeProductImage',
    'get /translate/languages': 'listTranslationLanguages',
    'put /conversations/{id}/translation': 'setChatTranslation',
    'post /conversations/{id}/translate': 'translateTexts',
    'post /users/{username}/view': 'viewProfile',
    'get /me/profile-views': 'getProfileViews',
    'put /me/privacy': 'updatePrivacy',
    'get /me/subscription': 'getSubscription',
    'post /me/subscription/checkout': 'startCheckout',
    'post /me/subscription/confirm': 'confirmSubscription',
    'get /me/verification': 'getVerification',
    'post /me/verification/otp': 'startVerification',
    'post /me/verification': 'finishVerification',
    'post /me/contact/otp': 'requestContactOtp',
    'put /me/contact': 'verifyContact',
    'put /me/default-disappearing': 'setDefaultDisappearing',
    'get /me/business': 'getBusiness',
    'put /me/business': 'setBusiness',
    'delete /me/business': 'removeBusiness',
    'put /conversations/{id}/disappearing': 'setDisappearing',
    'get /api-keys': 'listApiKeys',
    'post /api-keys': 'createApiKey',
    'delete /api-keys/{id}': 'revokeApiKey',
    'get /webhooks': 'listWebhooks',
    'post /webhooks': 'createWebhook',
    'get /webhooks/{id}': 'getWebhook',
    'patch /webhooks/{id}': 'updateWebhook',
    'delete /webhooks/{id}': 'deleteWebhook',
    'post /webhooks/{id}/test': 'testWebhook',
    'get /users': 'searchUsers',
    'get /users/{username}': 'getUser',
    'get /blocked': 'listBlocked',
    'put /blocked/{username}': 'blockUser',
    'delete /blocked/{username}': 'unblockUser',
    'get /conversations': 'listConversations',
    'post /conversations': 'createConversation',
    'get /conversations/{id}': 'getConversation',
    'get /conversations/{id}/messages': 'listMessages',
    'post /conversations/{id}/messages': 'sendMessage',
    'post /conversations/{id}/voice': 'sendVoiceMessage',
    'post /conversations/{id}/read': 'markConversationRead',
    'post /conversations/{id}/typing': 'sendTyping',
    'get /conversations/{id}/call': 'getActiveCall',
    'delete /messages/{id}': 'deleteMessage',
    'put /messages/{id}/star': 'starMessage',
    'delete /messages/{id}/star': 'unstarMessage',
    'get /starred': 'listStarredMessages',
    'get /media/{id}': 'downloadMedia',
    'get /chat-lock': 'getChatLock',
    'put /chat-lock/code': 'setChatLockCode',
    'post /chat-lock/reset/otp': 'requestChatLockResetOtp',
    'post /chat-lock/reset': 'resetChatLockCode',
    'post /chat-lock/relock': 'relockChats',
    'post /chat-lock/clear': 'clearChatLocks',
    'put /conversations/{id}/hide': 'hideChat',
    'delete /conversations/{id}/hide': 'unhideChat',
    'put /hidden-contacts/{username}': 'hideContactChat',
    'get /e2ee/devices': 'listDevices',
    'post /e2ee/devices': 'registerDevice',
    'delete /e2ee/devices/{id}': 'removeDevice',
    'get /conversations/{id}/keys': 'getConversationKeys',
    'get /hidden-chats': 'listHiddenChats',
    'post /hidden-chats/reveal': 'revealHiddenChats',
    'post /hidden-chats/close': 'closeHiddenChats',
    'post /hidden-chats/clear': 'clearHiddenChats',
    'post /biometric/challenge': 'biometricChallenge',
    'post /biometric': 'addBiometric',
    'delete /biometric/{id}': 'removeBiometric',
    'put /conversations/{id}/lock': 'lockChat',
    'delete /conversations/{id}/lock': 'removeChatLock',
    'post /conversations/{id}/unlock': 'unlockChat',
    'get /statuses': 'listStatuses',
    'post /statuses': 'postStatus',
    'delete /statuses/{id}': 'deleteStatus',
    'post /statuses/{id}/view': 'viewStatus',
    'post /statuses/{id}/replies': 'replyToStatus',
  };
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const id = OPERATION_IDS[`${method} ${path}`];
      if (!id) throw new Error(`openapi: no operationId for ${method} ${path}`);
      operation.operationId = id;
    }
  }
  for (const [event, item] of Object.entries(webhooks)) {
    item.post.operationId = 'on' + event.split(/[:-]/).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  }

  const TAG_DESCRIPTIONS = {
    [T.auth]: 'Sign up and log in with one-time codes: a mobile number for individuals; mobile number and email (both verified) for businesses',
    [T.me]: 'Your profile',
    [T.keys]: 'Long-lived credentials for servers and bots',
    [T.hooks]: 'Receive events at your own URL',
    [T.users]: 'Finding and blocking people',
    [T.conv]: 'One-to-one chats and groups',
    [T.msg]: 'Sending, reading, starring and deleting messages',
    [T.status]: 'Status updates that disappear after 24 hours',
    [T.lock]: 'Lock chats with a secret code, required again in every new session',
    [T.e2ee]: [
      'End-to-end encryption for messages typed in the ChatApp web app. Each device makes a key pair and registers the public key; senders encrypt each message on their device, once per recipient device, so the server stores only ciphertext.',
      '',
      '**Scheme (v1)**: a random 256-bit content key encrypts the message JSON (`{"t": "text"}`) with AES-256-GCM. The content key is wrapped for every recipient device with AES-256-GCM under a key from HKDF-SHA-256 over two ECDH (P-256) secrets: one-time key × recipient device key, and sender device key × recipient device key (which proves who sent it). Additional authenticated data is `convId|sender|senderDeviceId`. Voice messages encrypt the audio with the same content key (nonce `mi`).',
      '',
      'Not covered: messages sent by the REST API without an envelope, business auto replies, status updates, names, times and who talks to whom. Calls are encrypted peer to peer by WebRTC.',
    ].join('\n'),
    [T.chan]: 'Public one-to-many channels: owners and admins post, anyone can read and follow (not end-to-end encrypted)',
    [T.i18n]: 'Show received messages of a chat in the language you choose',
    [T.hide]: 'Hide chats from the chat list, opened with the secret code or fingerprint/face lock',
    [T.biz]: 'Business profile, hours, greeting and away messages',
    [T.meta]: 'Service health and this document',
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'ChatApp API',
      version: '1.0.0',
      description: [
        'REST API for integrating ChatApp with other platforms: send and read messages, manage chats, status updates and blocking, and receive events by webhook.',
        '',
        '**Authentication**: `Authorization: Bearer <token>` with a session token from `POST /auth/login` (after `POST /auth/otp`), or an API key (`cak_…`) from `POST /api-keys` (recommended for servers and bots: it survives restarts and can be revoked).',
        '',
        '**Real time**: subscribe to webhooks, or connect a Socket.IO client to the same server with `auth: { token }` (a session token or API key) to receive the same events live.',
        '',
        '**Limits**: 120 requests per minute per credential (`RateLimit-*` headers; `429` with `Retry-After` when exceeded).',
        '',
        '**Errors**: `{ "error": { "code", "message" } }`.',
      ].join('\n'),
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    tags: Object.values(T).map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    paths,
    webhooks,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Session token or API key (cak_…)' } },
      schemas,
      responses,
    },
  };
}

module.exports = { buildOpenApiSpec };
