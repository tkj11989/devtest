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
    }, ['category', 'timezone']),
    AutoReply: obj({ enabled: { type: 'boolean' }, text: { type: 'string', maxLength: 1000 } }),
    Business: {
      allOf: [ref('BusinessPublic'), obj({
        greeting: { ...ref('AutoReply'), description: 'Sent to customers who message you for the first time, or after 14 days without messages' },
        away: { ...ref('AutoReply'), description: 'Sent outside your business hours (at most once every 6 hours per chat)' },
      })],
    },
    Users: { type: 'object', additionalProperties: ref('User'), description: 'Users keyed by username' },
    Message: obj({
      id: { type: 'string' },
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
      activeCall: { oneOf: [ref('ActiveCall'), { type: 'null' }] },
      disappearAfter: { type: 'integer', description: 'disappearing messages timer in seconds (absent = off)' },
      disappearSetBy: { type: 'string' },
      locked: { type: 'boolean', description: 'you locked this chat with your secret code' },
      unlocked: { type: 'boolean', description: 'locked chats only: unlocked in this session' },
    }, ['id', 'type', 'members']),
    ChatLock: obj({
      hasCode: { type: 'boolean', description: 'a secret code has been set' },
      lockedChats: arrayOf({ type: 'string' }),
    }, ['hasCode', 'lockedChats']),
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
    E502: errorResponse('The SMS/email gateway could not send the code (`otp_delivery_failed`)'),
  };

  const T = { auth: 'Auth', me: 'Account', keys: 'API keys', hooks: 'Webhooks', users: 'Users', conv: 'Conversations', msg: 'Messages', status: 'Status', lock: 'Chat lock', biz: 'Business', meta: 'Meta' };

  const paths = {
    '/health': { get: op(T.meta, 'Health check', { auth: false, responses: { 200: ok(obj({ ok: { type: 'boolean' } })) } }) },

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
          })),
          ...errors(401),
        },
      }),
      patch: op(T.me, 'Update my profile', {
        body: jsonBody(obj({ displayName: { type: 'string' }, about: { type: 'string' } })),
        responses: { 200: ok(obj({ user: ref('User') })), ...errors(400, 401) },
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
        description: 'Send `Idempotency-Key` (or `clientId` in the body) to make retries safe: the same key returns the original message instead of sending twice.',
        params: [CONV_ID, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 64 } }],
        body: jsonBody(obj({ text: { type: 'string', maxLength: 4000 }, masked: { type: 'boolean' }, clientId: { type: 'string' } }, ['text']), { text: 'Hello from the API 👋' }),
        responses: { 201: ok(obj({ message: ref('Message') })), ...errors(400, 401, 403, 404, 423, 429) },
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
        description: 'Needs a secret code to have been set. Takes effect immediately in every session.',
        params: [CONV_ID],
        responses: { 200: ok(ref('ChatLock')), ...errors(400, 401, 404) },
      }),
      delete: op(T.lock, 'Remove the lock from a chat', {
        params: [CONV_ID],
        body: jsonBody(obj({ code: { type: 'string' } }, ['code'])),
        responses: { 200: ok(ref('ChatLock')), ...errors(401, 403, 404, 429) },
      }),
    },
    '/conversations/{id}/unlock': {
      post: op(T.lock, 'Unlock a locked chat for this session', {
        params: [CONV_ID, { name: 'X-App-Session', in: 'header', schema: { type: 'string' }, description: 'optional: scope the unlock to one app session of this credential' }],
        body: jsonBody(obj({ code: { type: 'string' } }, ['code'])),
        responses: { 200: ok(obj({ conversation: ref('Conversation') })), ...errors(401, 403, 404, 429) },
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
    'post /auth/otp': 'requestOtp',
    'post /auth/register': 'register',
    'post /auth/login': 'login',
    'post /auth/logout': 'logout',
    'get /me': 'getMe',
    'patch /me': 'updateMe',
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
