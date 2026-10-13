# ChatApp — a WhatsApp-like messenger

A real-time chat application inspired by WhatsApp, built with **Node.js**, **Express** and **Socket.IO**, with a dependency-free vanilla JS frontend.

## Features

- Sign up / log in (passwords hashed with scrypt)
- One-to-one chats and group chats
- Real-time messaging over WebSockets
- **Voice and video calls**, 1:1 and **group calls** (up to 6 people, peer-to-peer WebRTC): ringing on all devices, accept/decline, mute, camera on/off, **hold**, call timer, join a group call that's already running, and call history in the chat (missed / declined / duration, tap to call back)
- **Voice messages**: tap the mic, record (up to 5 minutes), send; others see "recording audio…" while you record
- **Starred messages**: star any message, find them all in the starred list (stars are private to you)
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
- Data persisted to `data/db.json` (voice-message audio in `data/media/`)

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
│   ├── index.js     # Express app, REST auth endpoints, Socket.IO events
│   ├── calls.js     # 1:1 and group call signalling (ring, join, relay, hold, end, call log)
│   └── store.js     # Users, sessions, conversations, messages (JSON file storage)
├── public/
│   ├── icons/       # Message status icons
│   ├── index.html   # UI markup
│   ├── styles.css   # WhatsApp-style theme (light/dark)
│   ├── app.js       # Client logic
│   └── call.js      # WebRTC call controller and call screen
├── design/          # Source design sheets for the icons
├── tools/
│   └── extract-icons.py
└── test/
    ├── app.test.js
    └── calls.test.js
```

## Socket events

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
| `messages:read`     | Mark a chat as read                      |
| `message:delete`    | Delete my message                        |
| `typing`            | Typing or recording started/stopped (`activity`) |
| `profile:update`    | Change display name / about              |
| `call:start`        | Start a call (or join the group call already running in that chat) |
| `call:accept` / `call:reject` | Answer or decline an incoming call |
| `call:signal`       | WebRTC offer/answer/ICE candidate relay to one participant |
| `call:hold`         | Put the call on hold / resume            |
| `call:end`          | Leave / hang up                          |

Server → client: `message:new`, `message:status`, `message:deleted`, `conversation:new`, `presence`, `typing`, `user:updated`, `message:starred`, `blocked:update`, `call:incoming`, `call:joined`, `call:left`, `call:signal`, `call:hold`, `call:ended`, `call:state`.

Voice-message audio is downloaded from `GET /media/:id` with an `Authorization: Bearer <token>` header; only members of the chat can fetch it.

## Notes / next steps

Login sessions are held in memory, so users need to log in again after a server restart. For production you'd want a real database (e.g. PostgreSQL/MongoDB), persistent sessions/JWT, HTTPS, rate limiting, a TURN server (and an SFU for bigger group calls), and features like photo/file sharing, push notifications and end-to-end encryption of messages.
