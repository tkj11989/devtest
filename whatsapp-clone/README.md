# ChatApp — a WhatsApp-like messenger

A real-time chat application inspired by WhatsApp, built with **Node.js**, **Express** and **Socket.IO**, with a dependency-free vanilla JS frontend.

## Features

- Sign up / log in (passwords hashed with scrypt)
- One-to-one chats and group chats
- Real-time messaging over WebSockets
- **Voice and video calls** (1:1, peer-to-peer WebRTC): ringing on all of the callee's devices, accept/decline, mute, camera on/off, call timer, and call history in the chat (missed / declined / duration, tap to call back)
- Message status icons (see below): not delivered, delivered, read, failed (tap to retry; auto-resent on reconnect), deleted, masked
- Masked messages: toggle the eye button before sending; recipients see a cover until they tap to reveal, and the text never shows in chat-list previews
- Typing indicators ("typing…") in the chat list and chat header
- Online status and "last seen"
- Unread message badges, chat search, people search
- Delete your own messages ("This message was deleted")
- Editable profile (display name and about)
- Emoji picker, day separators, responsive layout (mobile + desktop), dark mode
- Data persisted to `data/db.json`

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
- Group calls are not supported yet (1:1 chats only).

### Message status icons

| Icon | File | Shown when |
|------|------|------------|
| Non delivered (hourglass) | `public/icons/pending.png` | Your message is sending, or is on the server but not yet delivered to every recipient (e.g. they're offline) |
| Delivered (blue) | `public/icons/delivered.png` | Delivered to every recipient's device |
| Read (green) | `public/icons/read.png` | Read by every recipient |
| Failed (red) | `public/icons/failed.png` | Could not be sent — tap "Not sent. Tap to retry", or ✕ to discard |
| Deleted (trash) | `public/icons/deleted.png` | "This message was deleted" in the chat and the chat list |
| Masked (blindfolded eye) | `public/icons/masked.png` | A masked message: the composer toggle, the cover recipients tap to reveal, and the chat-list preview |

The PNGs are cut from `design/status-icons-sheet.png` with `python3 tools/extract-status-icons.py design/status-icons-sheet.png` (needs Pillow + NumPy). Re-run it if the sheet changes.

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
│   ├── calls.js     # Voice/video call signalling (ring, accept, relay, end, call log)
│   └── store.js     # Users, sessions, conversations, messages (JSON file storage)
├── public/
│   ├── icons/       # Message status icons
│   ├── index.html   # UI markup
│   ├── styles.css   # WhatsApp-style theme (light/dark)
│   ├── app.js       # Client logic
│   └── call.js      # WebRTC call controller and call screen
├── design/          # Source design sheet for the status icons
├── tools/
│   └── extract-status-icons.py
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
| `messages:read`     | Mark a chat as read                      |
| `message:delete`    | Delete my message                        |
| `typing`            | Typing started/stopped                   |
| `profile:update`    | Change display name / about              |
| `call:start`        | Start a voice/video call                 |
| `call:accept` / `call:reject` | Answer or decline an incoming call |
| `call:signal`       | WebRTC offer/answer/ICE candidate relay  |
| `call:end`          | Hang up                                  |

Server → client: `message:new`, `message:status`, `message:deleted`, `conversation:new`, `presence`, `typing`, `user:updated`, `call:incoming`, `call:accepted`, `call:signal`, `call:ended`.

## Notes / next steps

Login sessions are held in memory, so users need to log in again after a server restart. For production you'd want a real database (e.g. PostgreSQL/MongoDB), persistent sessions/JWT, HTTPS, rate limiting, a TURN server for calls, and features like group calls, media sharing, voice notes, push notifications and end-to-end encryption of messages.
