'use strict';

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
    }, ['username', 'displayName']),
    Users: { type: 'object', additionalProperties: ref('User'), description: 'Users keyed by username' },
    Message: obj({
      id: { type: 'string' },
      convId: { type: 'string' },
      from: { type: 'string', description: 'username of the sender' },
      type: { type: 'string', enum: ['text', 'voice', 'call'], description: 'absent for text messages' },
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
      bg: { type: 'string', example: '#00a884' },
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
    E429: errorResponse('Rate limited; see Retry-After'),
  };

  const T = { auth: 'Auth', me: 'Account', keys: 'API keys', hooks: 'Webhooks', users: 'Users', conv: 'Conversations', msg: 'Messages', status: 'Status', lock: 'Chat lock', meta: 'Meta' };

  const paths = {
    '/health': { get: op(T.meta, 'Health check', { auth: false, responses: { 200: ok(obj({ ok: { type: 'boolean' } })) } }) },

    '/auth/register': {
      post: op(T.auth, 'Create an account', {
        auth: false,
        body: jsonBody(obj({ username: { type: 'string', pattern: '^[a-z0-9_.]{3,20}$' }, password: { type: 'string', minLength: 4 }, displayName: { type: 'string' } }, ['username', 'password']),
          { username: 'alice', password: 'secret123', displayName: 'Alice Smith' }),
        responses: { 201: ok(ref('Session'), 'Account created; `token` is a login session'), ...errors(400, 409, 429) },
      }),
    },
    '/auth/login': {
      post: op(T.auth, 'Log in', {
        auth: false,
        description: 'Returns a session token. Sessions end when the server restarts; use an API key for long-running integrations.',
        body: jsonBody(obj({ username: { type: 'string' }, password: { type: 'string' } }, ['username', 'password']), { username: 'alice', password: 'secret123' }),
        responses: { 200: ok(ref('Session')), ...errors(401, 429) },
      }),
    },
    '/auth/logout': { post: op(T.auth, 'End this session', { responses: { 204: noContent, ...errors(401) } }) },

    '/me': {
      get: op(T.me, 'My profile', { responses: { 200: ok(obj({ user: ref('User'), blocked: arrayOf({ type: 'string' }), iceServers: arrayOf({ type: 'object' }) })), ...errors(401) } }),
      patch: op(T.me, 'Update my profile', {
        body: jsonBody(obj({ displayName: { type: 'string' }, about: { type: 'string' } })),
        responses: { 200: ok(obj({ user: ref('User') })), ...errors(400, 401) },
      }),
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
    '/chat-lock/reset': {
      post: op(T.lock, 'Forgot the code: set a new one with your account password', {
        body: jsonBody(obj({ password: { type: 'string' }, newCode: { type: 'string', minLength: 4, maxLength: 32 } }, ['password', 'newCode'])),
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
        description: 'Text: JSON `{ "type": "text", "text": "…", "bg": "#00a884" }`. Photo: send the image itself (`image/jpeg|png|webp|gif`, max 3 MB) with `?caption=`.',
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
    'post /auth/register': 'register',
    'post /auth/login': 'login',
    'post /auth/logout': 'logout',
    'get /me': 'getMe',
    'patch /me': 'updateMe',
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
    [T.auth]: 'Accounts and login sessions',
    [T.me]: 'Your profile',
    [T.keys]: 'Long-lived credentials for servers and bots',
    [T.hooks]: 'Receive events at your own URL',
    [T.users]: 'Finding and blocking people',
    [T.conv]: 'One-to-one chats and groups',
    [T.msg]: 'Sending, reading, starring and deleting messages',
    [T.status]: 'Status updates that disappear after 24 hours',
    [T.lock]: 'Lock chats with a secret code, required again in every new session',
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
        '**Authentication**: `Authorization: Bearer <token>` with a session token from `POST /auth/login`, or an API key (`cak_…`) from `POST /api-keys` (recommended for servers and bots: it survives restarts and can be revoked).',
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
