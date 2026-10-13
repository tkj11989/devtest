# ChatApp — a WhatsApp-like messenger

A real-time chat application inspired by WhatsApp, built with **Node.js**, **Express** and **Socket.IO**, with a dependency-free vanilla JS frontend.

## Features

- Sign up / log in (passwords hashed with scrypt)
- One-to-one chats and group chats
- Real-time messaging over WebSockets
- Message status ticks: ✓ sent, ✓✓ delivered, blue ✓✓ read
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

```bash
npm run dev        # restart automatically on file changes
npm test           # unit + realtime integration tests
```

## Project structure

```
whatsapp-clone/
├── server/
│   ├── index.js     # Express app, REST auth endpoints, Socket.IO events
│   └── store.js     # Users, sessions, conversations, messages (JSON file storage)
├── public/
│   ├── index.html   # UI markup
│   ├── styles.css   # WhatsApp-style theme (light/dark)
│   └── app.js       # Client logic
└── test/
    └── app.test.js
```

## Socket events

| Client → server     | Purpose                                  |
|---------------------|------------------------------------------|
| `conversations`     | List my chats with unread counts         |
| `users:search`      | Find people                              |
| `chat:direct`       | Open (or create) a 1:1 chat              |
| `group:create`      | Create a group                           |
| `messages:get`      | Load chat history                        |
| `message:send`      | Send a message                           |
| `messages:read`     | Mark a chat as read                      |
| `message:delete`    | Delete my message                        |
| `typing`            | Typing started/stopped                   |
| `profile:update`    | Change display name / about              |

Server → client: `message:new`, `message:status`, `message:deleted`, `conversation:new`, `presence`, `typing`, `user:updated`.

## Notes / next steps

Login sessions are held in memory, so users need to log in again after a server restart. For production you'd want a real database (e.g. PostgreSQL/MongoDB), persistent sessions/JWT, HTTPS, rate limiting, and features like media sharing, voice notes, push notifications and end-to-end encryption.
