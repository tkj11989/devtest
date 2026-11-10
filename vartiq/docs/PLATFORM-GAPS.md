# VartiQ compared with the main messengers: what is missing

*Written 10 Nov 2026. What VartiQ has comes from this repository (checked by searching the code). What the other apps have comes from general knowledge up to mid-2026 and from how they are usually described: check it before using it outside the company. "Partial" means it exists in a smaller form.*

Compared with: **WhatsApp** (and WhatsApp Business), **Telegram**, **Signal**, and **Arattai** (Zoho's Indian messenger).

## 1. Side by side

| | VartiQ | WhatsApp | Telegram | Signal | Arattai |
|---|---|---|---|---|---|
| Text, voice notes | Yes | Yes | Yes | Yes | Yes |
| **Photos, videos, documents in chats** | **No** | Yes | Yes (up to 2 GB+) | Yes | Yes |
| Voice and video calls | Yes (group calls are small, direct between phones) | Yes (up to 32) | Yes (large group voice chats) | Yes | Yes |
| Screen sharing | No | Yes | Yes | Yes | Partial |
| **Native Android and iPhone apps** | **No (installable web app)** | Yes | Yes | Yes | Yes |
| Desktop apps | No (browser) | Yes | Yes | Yes | Yes |
| End-to-end encryption | Yes for 1:1 and groups in the web app; off in chats with a business assistant | Yes, by default | Only in "secret chats" | Yes, by default | Partial |
| Several devices | Partial (link a browser by code) | Yes (history syncs) | Yes (cloud) | Yes | Yes |
| Chat backup and restore | **No** | Yes | Cloud | Partial | Partial |
| Find people from the phone's contacts | **No** (search by username or full number) | Yes | Yes | Yes | Yes |
| Reply to a message, reactions, forward, edit, pin | Reply, reactions and forward added; **no edit or pin yet** | Yes | Yes | Yes | Yes |
| Search inside chats | **Yes** (server-readable messages, plus encrypted chats on the device) | Yes | Yes | Yes | Yes |
| Stickers, GIFs, link previews | **No** | Yes | Yes | Partial | Yes |
| Disappearing messages | Yes | Yes | Yes | Yes | Partial |
| Status / stories | Yes | Yes | Yes (stories) | Yes | Yes |
| Public channels | Yes | Yes | Yes (very large) | No | Yes |
| Groups and communities | Groups up to 256, no communities | Groups 1024, communities | 200,000, topics | 1000 | Groups |
| Polls, events | Yes | Polls yes, events yes | Polls yes | Polls yes | Polls yes |
| Live location | Yes | Yes | Yes | No | Partial |
| Chat lock, hidden chats | Yes | Yes (lock) | Passcode | Screen lock | Partial |
| Passcode and passkey login, login PIN | Yes | Partial | Yes (two-step) | PIN | Partial |
| **Parent or guardian controls for under 18** | **Yes** | No | No | No | No |
| **Translation per contact** | **Yes** | Partial (some phones) | Premium | No | Partial |
| Business profile, catalogue | Yes | Yes | No | No | Partial |
| **Bulk messages with Sent, Delivered, Read, Failed report** | **Yes** (opt-out, limits, retry, CSV) | Yes, but only through the paid Business API with approved templates | Channels only | No | No |
| **Business assistant (rules, menu, hand-over)** | **Yes** | Yes (quick replies, away, bots through the API) | Bots | No | Partial |
| Official business API and approved templates | Partial (developer API and webhooks, no templates) | **Yes** | Bot API | No | Partial |
| Payments inside the chat | No (Razorpay only for Premium) | UPI in India | Partial | No | Partial |
| Admin dashboard for the operator | **Yes** | n/a | n/a | n/a | n/a |
| Legal text in the 22 Eighth Schedule languages | **Yes** (AI-prepared, needs checking) | Partial | Partial | No | Partial |
| App screens in Indian languages | **No (English)** | Yes | Yes | Yes | Yes |

## 2. The gaps, most serious first

### A. People will not switch without these
1. **~~Photos, videos and documents cannot be sent in a chat.~~ Done on 10 Nov 2026** (kept here for the record). Still to do: sending from a camera, a gallery and image editing, and a media store with a content delivery network for scale. Original note: **Photos, videos and documents cannot be sent in a chat.** The chat sends text, voice notes, location, polls and events. Pictures exist only as profile photos, status photos and product pictures. For most people this alone rules out daily use. Work needed: upload and storage for large files (object storage, not the database), thumbnails, compression, end-to-end encryption of files, size limits, a virus and abuse check, and a gallery. *Large piece of work.*
2. **No Android or iPhone app.** The installable web app cannot ring for a call when the app is closed, is limited on iPhone, and is not in the Play Store or App Store (which is where business customers look). Wrapping the web app with Capacitor is the quickest route. *Medium.*
3. **No finding people from the phone's contacts.** Without it a new user sees an empty app. Needs the contacts permission and a privacy-safe way to match numbers (hashed matching), plus the Digital Personal Data Protection rules for this. *Medium.*
4. **Everyday message features still missing:** edit with a time limit, pin, mentions in groups, link previews, stickers and GIFs (reply, reactions, forward and search were added on 10 Nov 2026). Each is small, together they decide how the app feels. *Medium in total.*
5. **No backup, and a new phone starts with no history.** Chats are encrypted per device, so changing phones loses the history. Needs an encrypted backup (a key the user keeps) and history sync to linked devices. *Large.*
6. **App screens are in English only.** Only the legal text and per-contact translation are multilingual. Most of the target market expects Hindi and other Indian languages in the menus. *Medium: collect all screen text into one file, then translate.*

### B. Businesses will want these (to compete with WhatsApp Business)
7. **No approved message templates or an official business API.** There is a developer API and webhooks, but no template approval, no business verification flow with a provider, no QR code or "click to chat" link, and no multi-agent shared inbox.
8. **Missing business tools:** labels on chats, saved quick replies, order and cart flow, payments in the chat (UPI), and reports beyond campaigns (response time, busiest hours).
9. **Assistant limits:** it reads only typed text, cannot take an order, and turns off encryption for its chats. Replies to images and voice are not possible.

### C. Scale and reliability (the product is built for hundreds, not millions)
10. **One server, one process.** A single outage takes down VartiQ and ExamSuit. There is no second server, no off-server backup yet, and no monitoring or alerts. It was tested with 500 simulated users, not thousands.
11. **Calls go directly between phones** (a mesh), so group calls are limited to a few people and use a lot of each phone's data. A media server (SFU) is needed for bigger calls and for screen sharing.
12. **Groups are limited to 256 members**, no communities, no large broadcast groups.
13. **Messages and files are kept in the database.** Fine for text; media needs a proper store with a content delivery network.

### D. Trust, safety and the law
14. **No business is registered yet**, so the notice names a person, Razorpay live payments and the Play Store cannot be used, and no Grievance Officer is appointed.
15. **The legal texts and the 22 translations need review** by a lawyer and certified translators.
16. **Safety tools are thin:** channels, profile photos and accounts can be reported, but messages cannot be reported from the chat, there is no spam detection, and no tools to review reports at scale. Bulk messages and the assistant make this more important.
17. **Real SMS for sign-up is not connected** (codes appear in the server log), and the Indian rules for sender registration (DLT) need several days.
18. **Security hardening still open:** SSH key-only login, uptime alerts, and the open items listed in `docs/SECURITY.md`.

## 3. Where VartiQ is ahead

Parent and guardian controls for under-18 accounts, written around India's Digital Personal Data Protection Act (consent, deletion within 24 hours, data export, legal text in 22 languages); translation per contact; bulk messages with a per-person delivery report and opt-out for ordinary users and businesses alike; a business assistant that needs no code; polls, events and live location in every chat; an admin dashboard with feature switches and limits; and a developer API with webhooks.

## 4. Suggested order

1. **Photos, videos and documents in chats** (gap 1) together with **reply, reactions, forward, search** (gap 4). This is the minimum for daily use.
2. **Android app** with the Capacitor wrapper (gap 2), then iPhone.
3. **Contact finding** (gap 3) and **screens in Hindi plus two or three more languages** (gap 6).
4. **Backup and new-phone history** (gap 5).
5. In parallel, the non-code work that blocks a public launch: register the business, lawyer review, SMS provider and DLT, off-server backups, monitoring (gaps 10, 14, 15, 17).
6. After launch: business API and templates, labels, quick replies (gaps 7, 8); media server for bigger calls (gap 11).
