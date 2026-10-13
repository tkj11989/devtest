# ChatApp — a WhatsApp-like messenger

A real-time chat application inspired by WhatsApp, built with **Node.js**, **Express** and **Socket.IO**, with a dependency-free vanilla JS frontend.

## Features

- Sign up / log in (passwords hashed with scrypt)
- One-to-one chats and group chats
- Real-time messaging over WebSockets
- **Voice and video calls**, 1:1 and **group calls** (up to 6 people, peer-to-peer WebRTC): ringing on all devices, accept/decline, mute, camera on/off, **hold**, call timer, join a group call that's already running, and call history in the chat (missed / declined / duration, tap to call back)
- **Status updates**: post text (on a coloured background) or photo updates that disappear after 24 hours; a Status panel with green rings for unseen updates, a full-screen viewer (tap left/right, hold to pause), "viewed by" lists on your own updates, and replies that land in your one-to-one chat
- **Voice messages**: tap the mic, record (up to 5 minutes), send; others see "recording audio…" while you record
- **Starred messages**: star any message, find them all in the starred list (stars are private to you)
- **Disappearing messages**: per chat, with presets (24 hours, 7 days, 90 days) or any custom time from 1 minute to 365 days (days + hours + minutes); a default timer for new chats you start
- **Business profiles**: business category, description, address, email, website and opening hours (with time zone and "Open now"), a business badge, a contact-info panel, and automatic **greeting** and **away** messages
- **Chat lock**: lock specific chats with a secret code; the code is required again in every new session (each time the app is opened or you log in), and the server withholds the chat's content until then
- **Block contacts**: blocked contacts can't message or call you and don't see your online status or last seen
- Offline banner while the connection is down; unsent messages go out automatically when you're back
- Message status icons (see below): not delivered, delivered, read, failed (tap to retry; auto-resent on reconnect), deleted, masked
- Masked messages: toggle the eye button before sending; recipients see a cover until they tap to reveal, and the text never shows in chat-list previews
- Typing indicators ("typing…") in the chat list and chat header
- Online status and "last seen"
- Unread message badges, chat search, people search
- Delete your own messages ("This message was deleted")
- Editable profile (display name and about)
- Emoji picker, day separators, responsive layout (mobile + desktop), dark mode
- **Public API for other platforms**: REST API (`/api/v1`) with API keys, signed webhooks, an OpenAPI 3.1 spec and interactive docs at `/api/docs`, plus a Developer panel in the app (Profile → Developer)
- Data persisted to `data/db.json` (voice-message audio and status photos in `data/media/`)

## Look and feel

The app uses the **PrayukTech** colour palette, taken from the logo, on desktop and mobile in light and dark mode:

| Colour | Hex | Used for |
|--------|-----|----------|
| Navy | `#061639` | Panel headers, login backdrop, call screen, mobile browser bar |
| Royal blue | `#0670DE` (logo `#0475EB`/`#006FCE`) | Buttons, links, your message bubbles (light tint), accents |
| Deep blue | `#003D82` | Hover/pressed states, header gradient |
| Orange | `#FE730F` / `#FF9A15` | Unread badges, header accent line, notices, keyboard focus ring |

All colours are CSS variables at the top of `public/styles.css`; text and background pairs meet WCAG AA contrast in both themes. On phones the browser bar takes the navy colour, and the app can be installed to the home screen (`public/manifest.webmanifest`, icons in `public/app-icons/`).

## Getting started

```bash
cd whatsapp-clone
npm install
npm start          # http://localhost:3000  (set PORT to change)
```

Open the app in two browser windows (or one normal + one private window), create two accounts and start chatting.

### Voice & video calls

Calls use WebRTC, so audio/video goes directly between the two browsers; the server only relays the call setup ("signalling").

- Browsers only allow camera/microphone on **`https://` or `http://localhost`**. To call between different devices on your network, run with a certificate:
  ```bash
  SSL_KEY=key.pem SSL_CERT=cert.pem npm start   # serves https://<your-ip>:3000
  ```
  (For local testing, a self-signed certificate works, e.g. one made with `mkcert`.)
- By default the app uses Google's public STUN servers, which is enough on the same network and for most home connections. Users behind strict corporate/mobile NATs need a **TURN** relay server (e.g. coturn). Configure it with:
  ```bash
  ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]' npm start
  ```
- Group calls connect every participant to every other one (a "mesh"), so they're limited to 6 people; larger calls would need a media server (SFU).
- Hold stops sending your audio/video and mutes theirs until you resume.

## Disappearing messages

Turn it on from the chat menu (**⋮ → Disappearing messages**), the banner in the chat, or the contact info panel. Pick **Off**, **24 hours**, **7 days**, **90 days** or **Custom** (any number of days, hours and minutes, from 1 minute to 365 days).

- It applies to **new** messages in that chat, for everyone in it. Anyone in the chat can change it, and everyone sees a notice ("Alice turned on disappearing messages…").
- When a message's time is up it is deleted from the server (voice notes included) and disappears live from every open app, the chat list, starred messages and the API.
- **Default message timer** (Profile): new one-to-one chats and groups **you start** get your timer automatically. Existing chats keep theirs.
- Messages with a timer show a small ⏱ with the exact time they will disappear; chats with a timer show ⏱ in the chat list and header.

API: `PUT /conversations/{id}/disappearing` `{ "seconds": 187200 }` (0 = off), `PUT /me/default-disappearing`; messages carry `expiresAt`, and the `message:expired` event / webhook lists removed ids. Like any app, this can't stop someone copying a message before it disappears.

## Business profile

**Profile → Switch to a business account** turns any account into a business account:

- **Business details**: category (Restaurant, Retail, …), description, address (links to a map), email, website.
- **Business hours** per weekday (open/close times, open 24 hours, or closed; past-midnight hours like 6 PM–2 AM work) in the business's **time zone**. Customers see "Open now" / "Closed now", today's hours and the full week, in the business's local time.
- **Business badge** next to the name in the chat list, the chat header, search results and group member lists. People can search for businesses by category.
- **Contact info**: tap a chat's header to see the business card (or a contact's/group's info).
- **Greeting message**: sent automatically when someone messages you for the first time, or after 14 days without messages.
- **Away message**: sent automatically when someone messages you outside your business hours (at most once every 6 hours per chat).
- Automatic messages are marked "Automated", follow disappearing timers, and are never sent to or from blocked contacts. Their texts stay private until sent.

Switch back to a personal account at any time. API: `GET/PUT/DELETE /me/business`; business details appear as `user.business` everywhere users are returned. `public/business-hours.js` contains the opening-hours logic, shared by the server and the browser.

## Chat lock

Lock any chat (one-to-one or group) from the chat menu (**⋮ → Lock chat**). The first time, you create a **secret code** (4–32 characters, separate from your password).

- A locked chat shows a padlock in the chat list and the preview reads "Locked chat · tap to unlock". Opening it shows a lock screen until you enter the code.
- **Every new session asks again**: unlocking lasts for this page load only. Reloading, opening another tab or window, closing the app, or logging in again means the code is needed again. A dropped connection that reconnects on the same page stays unlocked.
- **Lock all chats now** (Profile → Chat lock) re-locks everything immediately; **Remove chat lock** (chat menu) needs the code.
- **Forgot the code?** Set a new one with your account password. Your chats stay locked.
- 5 wrong codes (or passwords on the reset) block further tries for 1 minute, then 2, 4, … up to an hour.

It is enforced by the server, not just hidden in the page. Until a chat is unlocked in a session, that session gets no message text, voice notes, call details or previews for it: history requests are refused with `423 chat_locked`, live `message:new` events arrive without content (`{ locked: true }`), starred messages from it are redacted, and its voice notes can't be downloaded. **Webhooks never receive the content of locked chats.** Locking applies only to you; the other people in the chat see it as usual. Codes are stored as scrypt hashes.

Over the REST API, the "session" is the credential (session token or API key), optionally narrowed with an `X-App-Session` header: `PUT /conversations/{id}/lock`, `POST /conversations/{id}/unlock` `{ "code": "…" }`, `DELETE /conversations/{id}/lock`, `GET /chat-lock`, `PUT /chat-lock/code`, `POST /chat-lock/reset`, `POST /chat-lock/relock`.

## API for other platforms

Everything the app does (except placing calls, which needs WebRTC in a client) is available over a REST API, so CRMs, help desks, bots, mobile apps or back-office systems can integrate with ChatApp.

- **Docs**: open **`/api/docs`** (interactive, with "Try it out") or fetch **`/api/v1/openapi.json`** (OpenAPI 3.1; generate a client with any OpenAPI generator).
- **Auth**: `Authorization: Bearer <token>` with either a session token (`POST /api/v1/auth/login`) or an **API key** (`cak_…`). API keys are for servers and bots: they survive restarts, show when they were last used, and can be revoked. Create them in the app under **Profile → Developer**, or with `POST /api/v1/api-keys` while logged in.
- **Real-time events**: register a **webhook** (Developer panel or `POST /api/v1/webhooks`), or connect a Socket.IO client with `auth: { token: "<session token or API key>" }` to get the same events live (see Socket events below).
- **Same behaviour as the app**: messages sent over the API appear instantly in open apps, are delivered to webhooks, and follow the same rules (blocking, membership, limits).

### Quick start

```bash
BASE=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}' | jq -r .token)

# A long-lived API key for your integration (shown once)
KEY=$(curl -s -X POST $BASE/api-keys -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"CRM"}' | jq -r .key)

# Open a chat with bob and send a message (Idempotency-Key makes retries safe)
CONV=$(curl -s -X POST $BASE/conversations -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"type":"direct","username":"bob"}' | jq -r '.conversation.id | @uri')
curl -s -X POST "$BASE/conversations/$CONV/messages" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: order-1042' -d '{"text":"Your order has shipped 📦"}'

# Read history (oldest first; page back with ?before=<nextBefore>)
curl -s "$BASE/conversations/$CONV/messages?limit=20" -H "Authorization: Bearer $KEY"

# Get events at your URL
curl -s -X POST $BASE/webhooks -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/chatapp","events":["message:new","call:incoming"]}'
```

Conversation ids for direct chats contain colons (`dm:alice:bob`): URL-encode them in paths.

Main endpoints (all under `/api/v1`; full details in `/api/docs`):

| Area | Endpoints |
|------|-----------|
| Auth & account | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET/PATCH /me` |
| API keys | `GET/POST /api-keys`, `DELETE /api-keys/{id}` |
| Webhooks | `GET/POST /webhooks`, `GET/PATCH/DELETE /webhooks/{id}`, `POST /webhooks/{id}/test` |
| People | `GET /users?q=`, `GET /users/{username}`, `GET /blocked`, `PUT/DELETE /blocked/{username}` |
| Chats | `GET/POST /conversations`, `GET /conversations/{id}`, `GET /conversations/{id}/call` |
| Messages | `GET/POST /conversations/{id}/messages`, `POST /conversations/{id}/voice` (raw audio body), `POST /conversations/{id}/read`, `POST /conversations/{id}/typing`, `DELETE /messages/{id}`, `PUT/DELETE /messages/{id}/star`, `GET /starred`, `GET /media/{id}` |
| Disappearing | `PUT /conversations/{id}/disappearing`, `PUT /me/default-disappearing` |
| Business | `GET/PUT/DELETE /me/business` |
| Chat lock | `GET /chat-lock`, `PUT /chat-lock/code`, `POST /chat-lock/reset`, `POST /chat-lock/relock`, `PUT/DELETE /conversations/{id}/lock`, `POST /conversations/{id}/unlock` |
| Status | `GET/POST /statuses` (JSON text, or a raw image body with `?caption=`), `DELETE /statuses/{id}`, `POST /statuses/{id}/view`, `POST /statuses/{id}/replies` |

Errors are `{ "error": { "code": "not_found", "message": "…" } }` with the matching HTTP status (400, 401, 403, 404, 409, 413, 415, 423, 429).

### Webhooks

Each event is POSTed to your URL as JSON:

```json
{ "id": "evt_9b8a7c6d5e4f3a2b", "event": "message:new", "createdAt": 1760000000000,
  "user": "alice", "data": { "message": { "id": "…", "convId": "dm:alice:bob", "from": "bob", "text": "Hi" } } }
```

`data` is the same payload as the Socket.IO event of that name. Events: `message:new`, `message:status`, `message:deleted`, `message:starred`, `conversation:new`, `typing`, `presence`, `user:updated`, `blocked:update`, `call:incoming`, `call:ended`, `call:state`, `status:new`, `status:viewed`, `status:deleted`, `chatlock:update`, `conversation:updated`, `message:expired`, `ping`. Messages from chats you've locked arrive redacted (`{ "locked": true }`, no content). Subscribing to `*` (the default) means everything except the chatty `typing` and `presence`.

**Verify every delivery**: `X-ChatApp-Signature` is `sha256=` + the hex HMAC-SHA256 of `"<X-ChatApp-Timestamp>.<raw body>"` using the webhook's secret (shown once when you create it). Reject old timestamps to stop replays.

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${req.headers['x-chatapp-timestamp']}.${rawBody}`).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(req.headers['x-chatapp-signature']), Buffer.from(expected));
```

Reply with any 2xx within 5 seconds. Failed deliveries are retried after 2 s, 10 s and 60 s; after 20 failures in a row the webhook is switched off (turn it back on in the Developer panel or with `PATCH /webhooks/{id}` `{"active": true}`). The last delivery result is shown in the panel and in `GET /webhooks/{id}`.

For safety the server refuses to call private, loopback or link-local addresses. For local development, start it with `WEBHOOKS_ALLOW_PRIVATE=1`.

### Example: echo bot

`examples/echo-bot.js` is a complete integration in ~100 lines with no dependencies. It signs in with an API key, registers a webhook, verifies signatures, and replies to every message:

```bash
WEBHOOKS_ALLOW_PRIVATE=1 npm start
CHATAPP_API_KEY=cak_... node examples/echo-bot.js   # then message that account from the app
```

### API settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `API_RATE_LIMIT` | `120` | Requests per minute per credential (`RateLimit-*` headers; `429` + `Retry-After` when exceeded). Login/register: 20 per minute per IP. |
| `CORS_ORIGINS` | `*` | Comma-separated origins allowed to call the API from a browser. |
| `WEBHOOKS_ALLOW_PRIVATE` | off | Allow webhooks to private/localhost addresses (development only). |

Sessions and rate-limit counters are kept in memory (one server process). API keys, webhooks and data are saved in `data/db.json`.

### Status updates

- Your updates are shared with everyone you have a **one-to-one chat** with (there is no separate contact list), except people blocked either way. Group members don't see them unless you also chat one-to-one.
- Updates expire after 24 hours; the server removes them (and their photos) automatically.
- Only you can see who viewed your updates.
- Photos are resized in the browser (longest side 1600px, JPEG) before upload, and only people who can see the update can download them.

### Icons

All icons live in `public/icons/` and are cut from the design sheets in `design/` with
`python3 tools/extract-icons.py` (needs Pillow + NumPy; it finds the icons on each sheet automatically).
Re-run it if a sheet changes.

**Messages**

| Icon | File | Shown when |
|------|------|------------|
| Sending (paper plane) | `sending.png` | Your message is on its way to the server |
| Non delivered (hourglass) | `pending.png` | On the server but not yet delivered to every recipient (e.g. they're offline, or have blocked you) |
| Delivered (blue) | `delivered.png` | Delivered to every recipient's device |
| Read (green) | `read.png` | Read by every recipient |
| Failed (red) | `failed.png` | Could not be sent — tap "Not sent. Tap to retry", or ✕ to discard |
| Deleted (trash) | `deleted.png` | "This message was deleted" in the chat and the chat list |
| Masked (blindfolded eye) | `masked.png` | A masked message: the composer toggle, the cover recipients tap to reveal, and the chat-list preview |
| Typing (dots) | `typing.png` | Someone is typing (chat header and chat list) |
| Recording (mic) | `recording.png` | The record button, the recorder, and "recording audio…" for others |
| Starred | `starred.png` | Star button on messages, starred messages in the chat, the starred list |
| Blocked | `blocked.png` | Block/unblock in the chat menu, the "You blocked …" banner, blocked contacts in the chat list |
| Offline | `offline.png` | "You're offline" banner, and a contact's last-seen status |

**Calls**

| Icon | File | Shown when |
|------|------|------------|
| Call (green) | `call.png` | Voice-call button, accept button, answered calls in the history |
| Calling (yellow) | `calling.png` | Call screen while ringing; "Ongoing call · Join" banner and chat-list preview for a running group call |
| End (dark red) | `call-end.png` | Hang-up button; missed / unanswered calls in the history; the call-ended screen |
| Declined (red) | `call-declined.png` | Decline button; declined calls in the history |
| Group call (blue) | `group-call.png` | Group-call button in group chats, group call screen, group calls in the history |
| On hold (purple) | `on-hold.png` | Hold button; shown to others (and on the person's tile) while a participant has the call on hold |

Masking is a privacy cover in the UI (against shoulder-surfing and previews), not encryption: the text is still sent to and stored on the server.

```bash
npm run dev        # restart automatically on file changes
npm test           # unit + realtime integration tests
```

## Project structure

```
whatsapp-clone/
├── server/
│   ├── index.js     # Express app and Socket.IO wiring
│   ├── service.js   # Every user action, shared by Socket.IO and the REST API
│   ├── api.js       # REST API v1 (auth, rate limits, CORS, errors)
│   ├── openapi.js   # OpenAPI 3.1 spec (served at /api/v1/openapi.json)
│   ├── webhooks.js  # Signed webhook delivery with retries
│   ├── calls.js     # 1:1 and group call signalling (ring, join, relay, hold, end, call log)
│   └── store.js     # Users, sessions, conversations, messages (JSON file storage)
├── public/
│   ├── icons/       # Message status icons
│   ├── index.html   # UI markup
│   ├── styles.css   # WhatsApp-style theme (light/dark)
│   ├── app.js       # Client logic
│   ├── call.js      # WebRTC call controller and call screen
│   ├── status.js    # Status updates: list, composer and viewer
│   ├── business-hours.js # Opening hours / "open now" (shared with the server)
│   └── api-docs.html # Interactive API docs (/api/docs)
├── examples/
│   └── echo-bot.js  # Example integration: API key + webhooks + REST
├── design/          # Source design sheets for the icons
├── tools/
│   └── extract-icons.py
└── test/
    ├── app.test.js
    ├── calls.test.js
    ├── status.test.js
    ├── api.test.js
    ├── chatlock.test.js
    ├── disappearing.test.js
    └── business.test.js
```

## Socket events

The web app uses these over Socket.IO (connect with `auth: { token }`, a session token or API key). Requests take an acknowledgement callback that receives `{ ok: true, ... }` or `{ ok: false, error }`.

| Client → server     | Purpose                                  |
|---------------------|------------------------------------------|
| `conversations`     | List my chats with unread counts         |
| `users:search`      | Find people                              |
| `chat:direct`       | Open (or create) a 1:1 chat              |
| `group:create`      | Create a group                           |
| `messages:get`      | Load chat history                        |
| `message:send`      | Send a message (`masked`, `clientId` for safe retries) |
| `voice:send`        | Send a voice message (binary audio)      |
| `message:star`      | Star / unstar a message                  |
| `messages:starred`  | List my starred messages                 |
| `user:block`        | Block / unblock a contact                |
| `statuses`          | Status updates I can see (my own include who viewed them) |
| `status:post`       | Post a text or photo status update       |
| `status:view`       | Mark an update as seen                   |
| `status:delete`     | Delete one of my updates                 |
| `status:reply`      | Reply to an update (sent as a chat message) |
| `chat:disappearing` | Set a chat's timer (`seconds`, 0 = off) |
| `settings:default-disappear` | My default timer for new chats |
| `business:get` / `business:set` / `business:remove` | My business profile |
| `chatlock:settings` | Whether a secret code is set, and my locked chats |
| `chatlock:set-code` / `chatlock:reset-code` | Create/change the secret code, or reset it with the password |
| `chatlock:lock` / `chatlock:remove` | Lock a chat / remove its lock (needs the code) |
| `chatlock:unlock`   | Unlock a chat for this app session (`auth.appSession` = one page load) |
| `chatlock:relock`   | Lock every chat unlocked in this session again |
| `messages:read`     | Mark a chat as read                      |
| `message:delete`    | Delete my message                        |
| `typing`            | Typing or recording started/stopped (`activity`) |
| `profile:update`    | Change display name / about              |
| `call:start`        | Start a call (or join the group call already running in that chat) |
| `call:accept` / `call:reject` | Answer or decline an incoming call |
| `call:signal`       | WebRTC offer/answer/ICE candidate relay to one participant |
| `call:hold`         | Put the call on hold / resume            |
| `call:end`          | Leave / hang up                          |

Server → client: `message:new`, `message:status`, `message:deleted`, `conversation:new`, `presence`, `typing`, `user:updated`, `message:starred`, `blocked:update`, `call:incoming`, `call:joined`, `call:left`, `call:signal`, `call:hold`, `call:ended`, `call:state`, `status:new`, `status:viewed`, `status:deleted`.

Voice-message audio and status photos are downloaded from `GET /media/:id` with an `Authorization: Bearer <token>` header; only members of the chat can fetch it.

## Notes / next steps

Login sessions are held in memory, so users need to log in again after a server restart. For production you'd want a real database (e.g. PostgreSQL/MongoDB), persistent sessions/JWT, HTTPS, rate limiting, a TURN server (and an SFU for bigger group calls), and features like photo/file sharing, push notifications and end-to-end encryption of messages.
