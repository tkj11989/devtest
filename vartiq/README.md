# VartiQ — a real-time messenger

A real-time chat application built with **Node.js**, **Express** and **Socket.IO**, with a dependency-free vanilla JS frontend.

## Features

- **Sign up / log in with a one-time code (OTP)**: individuals use their mobile number; **business accounts verify both a mobile number and an email**
- One-to-one chats and group chats
- Real-time messaging over WebSockets
- **Voice and video calls**, 1:1 and **group calls** (up to 6 people, peer-to-peer WebRTC): ringing on all devices, accept/decline, mute, camera on/off, **hold**, call timer, join a group call that's already running, and call history in the chat (missed / declined / duration, tap to call back)
- **Status updates**: post text (on a coloured background) or photo updates that disappear after 24 hours; a Status panel with green rings for unseen updates, a full-screen viewer (tap left/right, hold to pause), "viewed by" lists on your own updates, and replies that land in your one-to-one chat
- **Voice messages**: tap the mic, record (up to 5 minutes), send; others see "recording audio…" while you record
- **Polls and events** in any chat: a poll (one question, 2 to 6 options, one choice, names visible) and an event (title, date and time, place, details, Going / Maybe / Can't go, a reminder before it starts). Premium adds multiple-choice, anonymous and self-closing polls (up to 12 options), and any reminder time and weekly or monthly repeating events. See "Polls and events" below.
- **Profile photos**: up to **2** for a free account and **5** with Premium; the first is your picture, shown in chat lists, headers, groups and calls (initials when there is none); you choose who sees them (everyone, my contacts, nobody); anyone can report a photo and administrators review reports
- **Parental control for under-18s**: date of birth at sign-up; 8 to 17 needs a parent or guardian (name, relationship, mobile number or email), who agrees through a private link before the account opens and can then switch calls, location sharing, being found by new people and public channels on or off, or disable or delete the account
- **Push notifications**: a notification on the device for a new message or an incoming call while the app is closed (Web Push; works in Chrome, Edge, Firefox and Safari, and on iPhone/iPad once VartiQ is added to the Home Screen). People choose what they get; notifications say who and what kind, never the message
- **Location sharing**: share where you are once, or live for 15 minutes, 1 hour or 8 hours (end-to-end encrypted like a message; stops by itself and the position is erased)
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

### Testing: Premium for everyone

Set `DISABLE_FEATURES=calls` (comma list of feature ids from Admin → Features, e.g. `calls,push`) to switch features off whatever the dashboard says; with `calls` off nobody can start or join voice and video calls and the call buttons are hidden. Remove it and restart to bring them back (if you saved settings in the dashboard meanwhile, check Features too).

Set `PREMIUM_FOR_ALL=1` to give every account Premium (unlimited chat locks and hidden chats, 5 profile photos, call recording, Premium personalisation and parental-control changes). It is for testing only: leave it unset in production. Premium is still bought and checked normally when it is off.

## Getting started

```bash
cd vartiq
npm install
npm start          # http://localhost:3000  (set PORT to change)
```

Open the app in two browser windows (or one normal + one private window), create two accounts and start chatting.

Sign-up and login codes are printed in the server console until you connect an SMS/email gateway (see [Login with OTP](#login-with-otp)). To also see them in the app while developing, start with `OTP_DEV_CODES=1 npm start`.

## Login with OTP

There are no passwords. You sign up and log in with a 6-digit code:

| Account | Sign up | Log in |
|---------|---------|--------|
| **Individual** | Name + **mobile number**, verified by an SMS code | Mobile number + SMS code |
| **Business** | Business name + category + **mobile number and email, both required and both verified** (an SMS code and an email code) | Mobile number + SMS code, or business email + email code |

- **A mobile number is mandatory** for every account. An individual's **email is optional**; if you type one at sign-up it is verified with an email code too (a business must give one).
- **Logging in on a browser needs a passcode from the phone.** The device you sign up on (or log in on with an SMS code) is your *primary phone*. While it is logged in, a browser (`clientType: "web"`) cannot use an SMS code: it gets `403 passcode_required` (and no SMS is sent). On the phone, **Profile → Link a browser → Make a passcode** shows a 6-digit passcode (valid **2 minutes**, one use, **5 wrong tries**, 5 per hour). The browser enters its mobile number and the passcode (`POST /auth/login { phone, linkCode, clientType: "web" }`). The phone lists the browsers and can sign them out; a browser can only sign itself out and cannot make passcodes (`403 primary_required`). When no primary phone is logged in (for example everything was logged out), an SMS code works on any device and that device becomes the primary. API: `POST /me/link-code`, `GET /me/linked-devices`, `DELETE /me/linked-devices/{id}`; socket `link:create`, `link:list`, `link:remove`. The web cannot read the SIM: "registered from the number in the phone" means the SMS code reached that number, and the passcode rule keeps other browsers out.
- Numbers are stored in international form (`+919876543210`). Pick the country code in the form, or type the number with its own `+` code.
- Codes last **5 minutes** and allow **5 wrong tries**. A new code for the same number/email and purpose can be sent after **30 seconds**, and at most **5 codes per number/email per hour**. Codes are single-use, kept only as an HMAC in memory, and the latest code replaces earlier ones.
- For a business, every code is checked before any is used, so a typo in the email code doesn't cost the SMS code.
- A username is made from your name (e.g. `anitarao`); friends can also find you by typing your **full mobile number** in New chat. Your number and email are never shown to other people (a business's email is shown as its contact email).
- **Profile → Mobile number / Email** changes either one, after verifying the new one with a code. A personal account that switches to a business account is asked to verify whichever is missing first.
- **Forgot your chat lock code?** A code by SMS to your number lets you set a new one.
- Accounts created before OTP login (username + password) can still log in over the API with `{ "username", "password" }`; add a mobile number in Profile to use OTP.

### Sending real SMS and email

Set `OTP_WEBHOOK_URL` and VartiQ POSTs every code to it as JSON, so you can plug in any provider (Twilio, MSG91, Gupshup, SendGrid, Amazon SES/SNS…) with a small relay:

```json
{ "channel": "sms", "to": "+919876543210", "code": "482913", "purpose": "login",
  "text": "482913 is your VartiQ verification code. It expires in 5 minutes. Never share it with anyone." }
```

`channel` is `sms` or `email`; `purpose` is `register`, `login`, `contact` or `chatlock-reset`. With `OTP_WEBHOOK_TOKEN` set, the request carries `Authorization: Bearer <token>`. Answer with any 2xx; anything else (or no answer in 10 seconds) tells the user the code couldn't be sent (`502 otp_delivery_failed`).

| Variable | Default | Meaning |
|----------|---------|---------|
| `OTP_WEBHOOK_URL` | (unset: codes are printed in the server console) | Your SMS/email relay |
| `OTP_WEBHOOK_TOKEN` | (unset) | Bearer token sent to the relay |
| `OTP_DEV_CODES` | (unset) | `1` returns codes in API responses (`devCode`) and shows them in the app. **Development only.** |

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


#### Recording a call (everyone must agree)

During a connected call, tap the **red record button**. **Nothing records until everyone in the call has agreed:**

1. You tap Record. Everyone else gets *"Alice wants to record this call. The recording is saved only on their device. Allow it?"* with **Allow / Don't allow**, and you see *"Waiting for Bob to allow recording…"*. The request expires after 30 seconds.
2. If **anyone declines**, nothing is recorded and the person who asked must wait 30 seconds before asking again.
3. When **everyone** has allowed it, recording starts and **every participant sees a "● Recording by Alice · 0:42" indicator** for as long as it runs.
4. **Anyone can stop it at any time** with the same button; that withdraws consent and ends it for everyone.

It also stops by itself if **someone new joins** the call (they haven't agreed; the group can ask again together) or the person recording **leaves**. A muted microphone is not recorded. Voice calls save audio; video calls save a video of the participants' tiles in a grid with everyone's audio mixed.

**Where it goes:** the recording is made **on the requester's own device** and saved there as a `.webm` file. **VartiQ's servers never receive or store it** (calls are peer to peer and encrypted), so it can't be listened to by anyone else. The server only keeps track of who has agreed, and the chat's call entry says **"Recorded"**. Everyone who agreed is trusting the person who asked to keep the file private: tell people that.

Administrators can switch **Call recording** off in the admin dashboard (Features → Messaging): the button disappears and requests are refused, while stopping always works. Socket events: `call:record-request`, `call:record-respond {accept}`, `call:record-stop`; server → client `call:record { state: pending|on|off, by, waiting, startedAt, reason }`.

## Disappearing messages

Turn it on from the chat menu (**⋮ → Disappearing messages**), the banner in the chat, or the contact info panel. Pick **Off**, **24 hours**, **7 days**, **90 days** or **Custom** (any number of days, hours and minutes, from 1 minute to 365 days).

- It applies to **new** messages in that chat, for everyone in it. Anyone in the chat can change it, and everyone sees a notice ("Alice turned on disappearing messages…").
- When a message's time is up it is deleted from the server (voice notes included) and disappears live from every open app, the chat list, starred messages and the API.
- **Default message timer** (Profile): new one-to-one chats and groups **you start** get your timer automatically. Existing chats keep theirs.
- Messages with a timer show a small ⏱ with the exact time they will disappear; chats with a timer show ⏱ in the chat list and header.

API: `PUT /conversations/{id}/disappearing` `{ "seconds": 187200 }` (0 = off), `PUT /me/default-disappearing`; messages carry `expiresAt`, and the `message:expired` event / webhook lists removed ids. Like any app, this can't stop someone copying a message before it disappears.

## Business profile

Sign up as a **Business** (mobile number and email both verified by OTP), or use **Profile → Switch to a business account** on a personal account (it first asks you to verify whichever of mobile number or email is missing):

- **Business details**: category (Restaurant, Retail, …), description, address (links to a map), email (always your verified email), website.
- **Business hours** per weekday (open/close times, open 24 hours, or closed; past-midnight hours like 6 PM–2 AM work) in the business's **time zone**. Customers see "Open now" / "Closed now", today's hours and the full week, in the business's local time.
- **Business badge** next to the name in the chat list, the chat header, search results and group member lists. People can search for businesses by category.
- **Contact info**: tap a chat's header to see the business card (or a contact's/group's info).
- **Greeting message**: sent automatically when someone messages you for the first time, or after 14 days without messages.
- **Away message**: sent automatically when someone messages you outside your business hours (at most once every 6 hours per chat).
- Automatic messages are marked "Automated", follow disappearing timers, and are never sent to or from blocked contacts. Their texts stay private until sent.

Switch back to a personal account at any time. API: `GET/PUT/DELETE /me/business`; business details appear as `user.business` everywhere users are returned. `public/business-hours.js` contains the opening-hours logic, shared by the server and the browser.

## Chat lock

Lock any chat (one-to-one or group) from the chat menu (**⋮ → Lock chat**). The first time, you create a **secret code** (4–32 characters).

- A locked chat shows a padlock in the chat list and the preview reads "Locked chat · tap to unlock". Opening it shows a lock screen until you enter the code.
- **Every new session asks again**: unlocking lasts for this page load only. Reloading, opening another tab or window, closing the app, or logging in again means the code is needed again. A dropped connection that reconnects on the same page stays unlocked.
- **Lock all chats now** (Profile → Chat lock) re-locks everything immediately; **Remove chat lock** (chat menu) needs the code.
- **Forgot the code?** Get a code by SMS on your mobile number and set a new one (older password accounts use the password). Your chats stay locked.
- 5 wrong codes (or passwords on a password reset) block further tries for 1 minute, then 2, 4, … up to an hour.

It is enforced by the server, not just hidden in the page. Until a chat is unlocked in a session, that session gets no message text, voice notes, call details or previews for it: history requests are refused with `423 chat_locked`, live `message:new` events arrive without content (`{ locked: true }`), starred messages from it are redacted, and its voice notes can't be downloaded. **Webhooks never receive the content of locked chats.** Locking applies only to you; the other people in the chat see it as usual. Codes are stored as scrypt hashes.

Over the REST API, the "session" is the credential (session token or API key), optionally narrowed with an `X-App-Session` header: `PUT /conversations/{id}/lock`, `POST /conversations/{id}/unlock` `{ "code": "…" }`, `DELETE /conversations/{id}/lock`, `GET /chat-lock`, `PUT /chat-lock/code`, `POST /chat-lock/reset/otp` + `POST /chat-lock/reset`, `POST /chat-lock/relock`.

## Admin dashboard

A separate dashboard at **`/admin`** (for example `http://localhost:3000/admin`) controls the whole platform: the web app and the mobile apps use the same server, so everything here applies to both at once.

**Getting in.** Administrators are not user accounts. Start the server with `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` (at least 10 characters), which sets that **super admin's** password each time the server starts. Sign in at `/admin`. Sessions last 8 hours and end when the server restarts; 5 wrong passwords lock further tries for 15 minutes. Without `ADMIN_PASSWORD` no administrator exists and the page says so.

| Role | Can do |
|------|--------|
| **Super admin** | Everything: feature switches, settings, Premium/Verified by hand, managing administrators |
| **Support** | Look at everything and moderate: suspend users, force log-out, delete channels, handle reports |

**Pages**
- **Overview:** users (total, online, new today / 7 days, Premium, Verified, Business, suspended), content (chats, messages, status updates, channels, posts, products, media size, API keys, webhooks, open reports), 14-day charts of new users and messages, which features are off, which services are connected (login codes, KYC, payments, translation: live / sandbox / off), and server uptime.
- **Users:** search by name, username, phone or email, filter (Premium, Verified, Business, Suspended). A user's detail panel offers **Suspend** (with a reason; ends their sessions, sockets and API keys, and blocks logging in), **Force log out**, and, for super admins, **Give/Remove Verified badge** and **Give/End Premium**. Administrators see contact details but **never messages** (they are end-to-end encrypted).
- **Channels & reports:** every channel with followers, posts and reports; **delete** a channel (its followers are told) or **dismiss** a report.
- **Features:** one switch per feature (below), **maintenance mode**, an **announcement** shown to everyone, and a **minimum app version**.
- **Settings:** free-account limits (locked chats, hidden chats, channels per owner, products per catalogue) and Premium prices. They apply at once.
- **Audit log:** who did what and when, for every administrator action (the last 2000).
- **Administrators:** add or remove administrators, change your own password.

**The developer API is restricted by default.** Out of the box the *Developer API* switch is **off**: the Developer screen (API keys and webhooks) is hidden in the web app and the mobile apps, creating keys and webhooks is refused (`403 feature_disabled`), API keys stop authenticating (REST and Socket.IO) and webhooks are not delivered. People still use the apps normally. A super admin enables it under **Admin → Features → Developer API** when needed; this also applies to existing installs that never set it.

**Feature switches** (each one is enforced **on the server for every client** and hidden in the apps; nothing is ever deleted):
New sign-ups · Group chats · Voice messages · Disappearing messages · Voice & video calls · Call recording · Status updates · Public channels · Who viewed my profile · Message translation · Chat lock · Hide chat · Business profiles · Product catalogue · Premium subscriptions · Identity verification · Developer API (API keys and webhooks; **off by default**).
A switch never traps people: with Chat lock off you can still unlock and remove locks; with Hide chat off you can still unhide; turning translation or timers *off* still works; Premium already bought keeps working; a payment already made can still be confirmed. A disabled feature answers `403 feature_disabled`.

**Maintenance mode** blocks every user call with `503 maintenance` and shows the message in every app (administrators and `/api/v1/config` keep working); apps come back by themselves when it is turned off.

**For mobile apps (and any client):** `GET /api/v1/config` (no sign-in) returns `{ features, maintenance, announcement, minClientVersion, limits }`. Read it when the app starts and again when the Socket.IO event `config:update` arrives (it is sent to every connected app the moment an administrator changes something). Hide controls whose feature is `false`, show `maintenance.message` while `maintenance.on`, show the `announcement`, and send `X-Client-Version` (REST) or `auth.clientVersion` (socket): apps older than `minClientVersion` get `426 update_required`. The web app does all of this itself.

**Security notes:** the dashboard is same-origin only (no CORS), sent with `no-store`, a strict Content-Security-Policy and no framing. Use HTTPS in production, and put `/admin` behind a VPN or IP allow-list if you can. There is no two-factor sign-in yet. Admin API: `/admin/api/*` (internal, not part of the public API docs).

## Public channels

A **channel** is a public one-to-many feed, like a broadcast or news channel: the owner and admins post, **anyone can find, read and follow it**, and followers can't post. Tap the megaphone in the chat list header.

- **Following / Discover:** *Following* lists the channels you follow or own, with unread counts (and a total on the megaphone). *Discover* is the public directory: search by name, handle, description or category; with no search it shows the most followed channels. Reading needs no follow.
- **Create** (＋): a name, a unique **handle** (3-30 letters/numbers/`_`, can't be changed), an optional description and category. You become the owner. Up to 10 channels each.
- **Posts:** text up to 4000 characters, links are clickable. Followers get them **live**; older posts load on demand. The owner and admins can **delete** posts; 20 posts per minute.
- **Admins:** the owner can appoint up to 5 admins (they can post, delete posts and edit the channel; they also follow it). Only the owner can delete the channel, which removes its posts for everyone.
- **Safety:** anyone can **report** a channel (one report each, with a reason). Reports are stored for whoever runs the service to review; there is no admin screen yet. The owner's Verified badge shows on the channel.
- **Not end-to-end encrypted:** channels are public, so the posts are visible to the server and to anyone. The app says so on every channel.

API: `GET/POST /channels`, `GET /me/channels`, `GET/PATCH/DELETE /channels/{id}` (`id` or handle), `PUT/DELETE /channels/{id}/follow`, `PUT/DELETE /channels/{id}/admins/{username}`, `GET/POST /channels/{id}/posts`, `DELETE /channels/{id}/posts/{postId}`, `POST /channels/{id}/read`, `POST /channels/{id}/report`. Socket: `channels:search`, `channels:mine`, `channel:get|create|update|delete|follow|unfollow|admin|posts|post|post-delete|read|report`; server → client `channel:post`, `channel:post-deleted`, `channel:updated`, `channel:deleted`.

## Product catalogue (business profiles)

Business accounts can list products with prices. **Profile → Business account → Product catalogue** (owner), and **View catalogue (n)** on any business's profile (customers).

- **Product:** name, price (up to 2 decimals) with an optional unit (*each, per kg, per hour*), description, category, item code, link, an **in stock / out of stock** switch and a **picture** (JPEG, PNG or WebP up to 1 MB). **Price on request** shows no price. One **currency** for the whole catalogue (default INR; 14 offered in the app, any 3-letter code over the API). Up to 100 products.
- **Customers** see a card per product (out-of-stock items are marked) and **Ask about this**, which opens the chat with the business and starts a message about the product ("Hi, I'm interested in "Margherita pizza" (₹299.00)."). It is an ordinary end-to-end encrypted message.
- Pictures are public to signed-in people (so any customer can see them); deleting or replacing a product deletes its old picture. Switching back to a personal account deletes the catalogue and its pictures.
- Prices are information only: VartiQ does not take orders or payments for products.

API: `GET /users/{username}/catalogue`, `GET /me/catalogue`, `POST /me/catalogue/products`, `PUT/DELETE /me/catalogue/products/{id}`, `PUT/DELETE /me/catalogue/products/{id}/image`, `PUT /me/catalogue/currency`; the profile's `business.productCount` says how many. Socket: `catalogue:get`, `catalogue:save`, `catalogue:delete`, `catalogue:image`, `catalogue:image-remove`, `catalogue:currency`.

## Translating a contact's messages

In any chat, ⋮ → **Translate messages** lets you pick a language (27 offered, including Hindi, Bengali, Tamil, Telugu, Marathi, Spanish, French, Arabic, Chinese, Japanese…). From then on, **messages you receive in that chat are shown in that language**, each with *"Translated from English · Show original"*. It is set **per chat, so per contact**, is private to you (the other person isn't told), syncs across your devices, and your own messages are never translated. Messages already in your language are left alone. Turn it off from the same menu or the banner's *Change* link.

**Privacy:** messages are end-to-end encrypted, so the server cannot translate them. When translation is on for a chat, your app decrypts each received message and sends its text to the translation service, which returns it; **texts are not stored or logged** by VartiQ. The dialog says this before you turn it on. Chats where it is off never send anything.

Connect a translation service (Google Cloud Translation, DeepL, Azure Translator, AWS Translate, LibreTranslate…) behind a small relay with `TRANSLATE_WEBHOOK_URL` (and `TRANSLATE_WEBHOOK_TOKEN`):

```
{ "action": "translate", "target": "hi", "texts": ["Good morning!", "Is the order ready?"] }
  ->  { "translations": [{ "text": "सुप्रभात!", "detected": "en" }, { "text": "…", "detected": "en" }] }
```

Without it translation is unavailable; `TRANSLATE_SANDBOX=1` fakes it for development (it prefixes `[hi]`). Limits: 30 texts of 4000 characters per request, 120 texts per minute per person. Not translated: voice messages, masked messages until revealed, and chat-list previews. The interface text itself is English only for now.

API: `GET /translate/languages`, `PUT /conversations/{id}/translation {lang}`, `POST /conversations/{id}/translate {texts}`. Socket: `translate:languages`, `translate:set`, `translate:text`; server → client `translate:update`.

## Who viewed my profile

**Profile → Who viewed my profile** lists everyone who looked at your profile, **whether or not they are in your contacts**, each with the **date and time of their last view** and a tag: *In contacts* (you have a one-to-one chat with messages) or *Not in contacts*. Newest first.

- **What counts as a view:** opening someone's Contact info, opening their profile from a group's member list, or tapping their picture in New chat. Looking at your own profile doesn't count.
- **What is kept:** one row per viewer with only the **last view time**: no counts, no history, nothing about what they looked at. Entries older than **90 days** are deleted, and at most 500 are kept.
- **It's mutual and visible:** Contact info and profiles say *"They can see that you viewed their profile"*. A person who **turns profile views off** is not recorded when they look at others, can't see who viewed them, and their list is erased. You can't have one without the other.
- Nothing is recorded if either person has blocked the other. Webhooks never receive profile views.

API: `POST /users/{username}/view` (call when your app opens a profile), `GET /me/profile-views`, `PUT /me/privacy {"profileViews": false}`. Socket: `profile:view`, `profile:views`, `profile:views-set`, `user:get`; server → client `profile:viewed`.

## Free and Premium accounts

| | Free | Premium |
|---|---|---|
| Locked chats (Chat lock) | up to **3** | unlimited |
| Hidden chats (Hide chat) | up to **1** | unlimited |
| Badge | none | gold ★ next to the name |
| Profile photos | up to **2** | up to **5** |
| Polls | one choice, up to 6 options, names visible | several choices, anonymous, closes by itself, up to 12 options |
| Events | answers + a reminder 1 hour before | any reminder time, weekly/monthly repeat |
| Parental controls (under-18 accounts): the parent or guardian changes calls, location sharing, being found by new people, public channels | safe defaults, cannot be changed | changeable at any time |

Past a free limit, locking or hiding shows *"Premium required"* with the plans (API: `402 premium_required`). Everything else is the same on both. Profile → **Premium** shows the plan, how much of the free allowance you use, and **Upgrade / Extend**.

**Plans: Daily, Monthly, 3 months, 6 months and Yearly** (calendar months), paid in advance. They do not renew by themselves; buying again while Premium **extends** it from the current end. Default prices (INR): 9 / 99 / 279 / 529 / 999; longer plans show what they save compared with paying monthly. Administrators set prices and switch plans on or off in Admin → Settings → *Premium plans and prices* (at least one stays on); `PLAN_PRICES='{"daily":19,"monthly":149,"quarterly":399,"halfyearly":749,"yearly":1499}'` and `PLAN_CURRENCY` set the starting values. No card, UPI or bank details are ever handled by VartiQ.

### Payments with Razorpay ("payment received")

Set three variables from your Razorpay account and VartiQ takes payments with **Razorpay Payment Links** (a payment page hosted by Razorpay: UPI, cards, netbanking, wallets); no relay is needed:

```
RAZORPAY_KEY_ID=rzp_live_…            # Dashboard → Account & Settings → API keys (rzp_test_… for test mode)
RAZORPAY_KEY_SECRET=…
RAZORPAY_WEBHOOK_SECRET=…              # a secret you choose when you add the webhook below
PUBLIC_URL=https://vartiq.prayuktech.com
```

1. In the Razorpay Dashboard add a **webhook**: URL `https://vartiq.prayuktech.com/webhooks/razorpay`, the secret above, and events **`payment_link.paid`** and **`refund.processed`** (optionally `payment.failed`, which is ignored).
2. A purchase creates an order (saved with the person's account, kept 7 days) and a payment link whose `reference_id` is the order id (it starts with the username). The person pays on Razorpay's page and returns to `/premium/return/razorpay`.
3. **Premium switches on only when Razorpay says the payment was received**, by any of: the signed webhook (works even if the app was closed), the signed return address (we also ask Razorpay's API before trusting it), or the *I have paid* button (the server asks Razorpay). The app shows **"Payment received"** at once (Socket.IO `payment:received`; the waiting dialog closes by itself) and the person's other devices update.
4. **Every payment counts once**, however many of those arrive (it is recorded by Razorpay's payment id), and the amount and currency must match the order exactly (otherwise nothing is switched on and the mismatch is logged). A signature that does not verify is refused (`400`).
5. **Refunds**: a *full* refund processed in Razorpay takes back exactly the period that payment bought (never below today; the app is told); a partial refund is recorded and keeps Premium.
6. **Receipts and records**: Profile → Premium → *Payments* lists the person's payments (date, plan, amount, Razorpay payment id). Admin → **Payments** lists everything received with totals (last 30 days, all time; refunds deducted). The payment record (amount, date, plan, payment id) is kept for accounting even after an account is deleted, without name or contact details, and is included in *Download my data*.
7. Test first with `rzp_test_…` keys (Razorpay's test mode takes test UPI and cards). Overview shows *razorpay (test mode)*. Live mode needs your Razorpay account activated (KYC) and Payment Links enabled.

### Changing the payment vendor later

Razorpay is one **payment provider** plugged into a small interface (`server/payment-providers.js`); the rest of the app (plans, orders, receipts, the admin Payments page, the "Payment received" message) never mentions a vendor. To move to another vendor:

1. Write one file like `server/razorpay.js` that returns an object with `id`, `label`, `testMode`, `webhookConfigured` and five functions: `createCheckout` (make the payment page), `status` (ask the vendor whether an order was paid), `verifyWebhook` (check its signature), `parseWebhook` (turn its notification into `paid` / `refund` / `ignored`), `verifyReturn` (check the address the person comes back to). Amounts come back in the smallest unit (`amountMinor`, paise for INR).
2. Add one line for it to `registry` in `selectProvider`, and set `PAYMENT_PROVIDER=<its id>` (without it the first configured provider is used: Razorpay, then the generic relay, then the sandbox).
3. Point the vendor's webhook at `https://…/webhooks/<id>` and let it send people back to `/premium/return/<id>` (both addresses are derived from the provider's `id`).
4. Change **Admin → Settings → Legal → Payment provider named in the Privacy Notice** (or `LEGAL_PAYMENT_PROVIDER`) so the notice names the new vendor.

Orders and receipts already store which vendor took each payment (`provider`), so old Razorpay receipts stay valid after a switch. `test/payment-provider.test.js` runs the whole flow against a made-up second vendor to prove nothing else needs to change.

Without any provider configured the older generic relay (below) is used, or subscriptions are unavailable. Prices are taken as GST-inclusive; add invoicing separately if you need GST invoices.


**When Premium ends**, the ★ goes away and no *more* chats can be locked or hidden beyond the free limits. Chats that are already locked or hidden **stay protected** (they are never silently exposed); removing locks or unhiding is always allowed, and renewing Premium restores adding more.

**Other providers** (Stripe, PayU, Cashfree…) can be used through a small relay when Razorpay is not configured. Set `PAYMENT_WEBHOOK_URL` (and `PAYMENT_WEBHOOK_TOKEN`) and VartiQ POSTs JSON to it:

```
{ "action": "create", "reference": "ord_…", "plan": "monthly", "amount": 99, "currency": "INR", "user": "alice" }  ->  { "paymentUrl": "https://…" }
{ "action": "status", "reference": "ord_…" }                                                                         ->  { "paid": true }
```

The person pays on the provider's page; then the **server** asks the provider whether the order was paid before switching Premium on (nothing the browser says is trusted, and each order works once). Without `PAYMENT_WEBHOOK_URL`, subscriptions are **unavailable**. For development, `PAYMENTS_SANDBOX=1` marks every order paid: **never use it in production, it gives Premium away.**

API: `GET /me/subscription`, `POST /me/subscription/checkout`, `POST /me/subscription/confirm`, `GET /me/payments` (receipts); `POST /webhooks/razorpay` (Razorpay only); server → client `payment:received`, `payment:refunded`; `user.premium` appears wherever users are returned. Socket: `subscription:status`, `subscription:checkout`, `subscription:confirm`; server → client `subscription:update`.

## Premium personalisation and call recording

Premium accounts also get:

- **Colour themes**: 13 Premium themes (Emerald, Teal, Sky, Indigo, Midnight, Violet, Magenta, Rose, Crimson, Sunset, Amber, Coffee, Graphite); Ocean, the PrayukTech blue, is free. Every theme is generated so text and backgrounds meet WCAG AA contrast in both light and dark (checked by the tests).
- **App icons**: Spark, Heart, Bolt, Leaf, Star, Plane and Smile replace the logo in the app and the browser tab icon (Classic is free).
- **Picture shapes**: rounded or square avatars (circle is free).
- **Call recording** (see "Recording a call"): asking to record needs Premium; everyone else on the call only has to agree.

Light, dark and automatic mode are free. Open **Profile → Appearance**. Choices are saved on the account and follow you to every device (`appearance:update`). When Premium ends, the free look is shown again; the saved choices come back if Premium is renewed. Free users who tap a Premium option are offered the plans.

API: `GET /api/v1/appearance` (public catalogue with the colour values, so mobile apps can apply them), `GET /api/v1/me/appearance`, `PUT /api/v1/me/appearance` (`{ mode, theme, appIcon, avatarShape }`; a Premium option without Premium is `402 premium_required`). Socket events: `appearance:get`, `appearance:set`. Administrators can switch the feature off (`appearance`) and the call recording feature (`callRecording`) in the dashboard.

## Verified badge (KYC)

Everyone has a badge next to their name: a **blue Verified seal** once they have verified their identity, or a **grey outlined "Not verified" seal** otherwise (business accounts also keep their briefcase badge). It shows in the chat list, chat header, contact info, search results and group members, and updates live.

**Profile → Verified badge → Verify**: pick any ID (personal accounts: Aadhaar, PAN, passport, driving licence, voter ID; business accounts: GSTIN, CIN, business PAN), enter its number, then enter the **one-time code** sent to the mobile number linked to that ID. That is all: the badge turns blue.

**No KYC information is stored, anywhere.** The ID number goes from the form to the verification gateway and is dropped: it is not saved on the server, not kept in the app (the field is cleared from the page when the dialog closes), and not logged. The only thing kept on the account is a "verified" yes/no with the time (`verifiedAt`). Not the ID type, number, name or gateway reply. Changing your display name removes the badge until you verify again, because a verified identity belongs to a name.

VartiQ doesn't do KYC itself; it needs a verification service (DigiLocker, Aadhaar eKYC, Signzy, IDfy, Onfido…) behind a small relay. Set `KYC_WEBHOOK_URL` and VartiQ POSTs JSON to it (with `Authorization: Bearer $KYC_WEBHOOK_TOKEN` if set):

```
{ "action": "start",  "type": "pan", "idNumber": "ABCDE1234F" }  ->  { "requestId": "…" }   (the service sends the code)
{ "action": "verify", "requestId": "…", "otp": "482913" }        ->  { "verified": true }
```

Rules: the number's format is checked first (bad numbers never reach the service); 3 attempts per hour; 5 wrong codes end an attempt; the code expires after 10 minutes. Without `KYC_WEBHOOK_URL` verification is **unavailable** (nobody gets a badge). For development, `KYC_SANDBOX=1` accepts any well-formed ID and sends the code to the account's own mobile number (shown in the app with `OTP_DEV_CODES=1`). **Never use the sandbox in production: it verifies anyone.**

API: `GET /me/verification`, `POST /me/verification/otp`, `POST /me/verification`; `user.verified` appears wherever users are returned. Socket: `kyc:status`, `kyc:start`, `kyc:verify`.

## End-to-end encryption

Messages typed in the web app are **end-to-end encrypted**: they are encrypted on the sender's device and can only be decrypted on the devices of people in that chat. The server stores and relays ciphertext and **cannot read message text or voice recordings** (verified in the tests: the database dump, the API history and previews contain no plaintext).

- **Nothing to turn on.** Each browser/phone makes its own key pair the first time you sign in (the private key stays in that browser's IndexedDB and is never sent anywhere) and registers the public key. Chats show *"Messages in this chat are end-to-end encrypted"*.
- **Covered:** text and voice messages in one-to-one chats and groups, previews, starred messages, replies to status updates. Calls are encrypted directly between devices by WebRTC.
- **Multiple devices:** every device has its own key. Senders encrypt for all of a person's devices, so each can read new messages. A device added later **cannot read older messages** (they show "can't be read on this device"); history is not copied between devices. **Profile → Encryption & linked devices** lists devices (up to 5) and removes ones you no longer use. Clearing a browser's site data discards its key, and it re-registers as a new device.
- **Verify a contact:** Contact info → **Encryption → Verify** shows a 60-digit security code; it is the same on both phones unless someone interfered with the key directory. It changes when either person adds or removes a device.
- **Not end-to-end encrypted** (and marked with an open padlock in encrypted chats): messages sent through the REST API as plain text (the server sees them), business greeting/away replies (the server writes them), and messages from before encryption existed. Status updates, display names, who talks to whom, and message times are also visible to the server. Webhooks receive ciphertext for encrypted messages.
- Browsers need HTTPS or `localhost` (Web Crypto). Without it the app says encryption is unavailable and sends plain messages.

**How it works** (`public/e2ee.js`, `server/service.js`): a random 256-bit content key encrypts the message with AES-256-GCM. The key is wrapped per recipient device with AES-256-GCM under a key from HKDF-SHA-256 over two P-256 ECDH secrets: a one-time key (fresh for every message) and the sender device's key (so the server can't forge a sender). Authenticated data is `convId|sender|senderDevice`, so a ciphertext can't be moved to another chat or attributed to someone else. The server checks each envelope names exactly the devices of the chat's members (a stale list is `409 keys_changed`; the app re-fetches keys and retries), but never holds a private key.

Known limits (be honest with users): this is not the Signal protocol. There is no ratcheting, so keys don't heal after a device is compromised and an attacker who steals a device's private key can read past messages sent to it. The key directory is trusted unless contacts compare security codes. Group membership is whatever the server says.

API integrations: `GET/POST /e2ee/devices`, `DELETE /e2ee/devices/{id}`, `GET /conversations/{id}/keys`, and `POST /conversations/{id}/messages` with an `e2ee` envelope instead of `text` (documented in `/api/docs`, tag *Encryption*). Socket events: `e2ee:register`, `e2ee:devices`, `e2ee:remove`, `e2ee:keys`; server → client `e2ee:update`.

## Hide chat

**Hide chat** (chat menu **⋮ → Hide chat**) takes a chat off your dashboard completely. Hidden chats are opened with your **secret code** or, once set up, your phone's **fingerprint / face lock**.

- A hidden chat is not in the chat list, search, or unread badges, and nothing about it (new messages, previews, typing, delivery ticks) reaches the app until you open it. Webhooks never hear about it either.
- **Profile → Hidden chats** asks for the code (or fingerprint / face) and shows the hidden chats. They **close again** when you leave that screen, tap *Lock all chats now*, close VartiQ or log in again; their messages are removed from the page.
- **Unhide chat** (chat menu, while the chats are open) puts a chat back in the list. Hiding replaces that chat's own lock; a chat is either locked or hidden.
- **Hide any specific contact**, not everything: from the chat menu, from **Contact info → Hide chat**, or with the eye icon next to a person in **New chat** (even if you have never chatted). A contact you hid stays hidden *always*: their first and every later message stays out of your chat list. Other chats are unaffected.
- Hiding needs a secret code (you're asked to create one the first time). Wrong tries share the chat lock's limit (5, then a growing wait).

**Settings** (Profile):

| Option | What it does |
|--------|--------------|
| **Fingerprint / face lock** | Set up this phone or laptop (it asks for your code, then your fingerprint/face). Hidden chats, locked chats and the options below can then be opened with it instead of typing the code. Turn off any time. |
| **Clear all chats from Hide chat** | Every hidden chat goes back to the chat list (nothing is deleted). Needs the code or fingerprint/face. |
| **Remove all chats from Chat lock** | Removes the lock from every locked chat at once. Needs the code or fingerprint/face. |

Fingerprint / face uses WebAuthn platform authenticators (Touch ID, Face ID, Windows Hello, Android biometrics), so it needs HTTPS or `localhost`. The server verifies each check itself: a one-time challenge, the site it was made for, the user-verified flag and the device's signature (`server/webauthn.js`), so it can't be faked from the page. Only the public key is stored.

REST: `PUT/DELETE /conversations/{id}/hide`, `PUT /hidden-contacts/{username}`, `POST /hidden-chats/reveal`, `GET /hidden-chats`, `POST /hidden-chats/close`, `POST /hidden-chats/clear`, `POST /chat-lock/clear`, `POST /biometric/challenge`, `POST /biometric`, `DELETE /biometric/{id}`. Wherever a code is asked, send `{ "code" }` or `{ "biometric": { id, clientDataJSON, authenticatorData, signature } }`. `GET /conversations` never lists hidden chats (it returns `hiddenCount`).

## Reliability and scale

- **Acknowledged means saved.** A message, vote or any change is confirmed to the sender only after it is on disk (file store) or in PostgreSQL; requests that arrive together share one save. A crash or `kill -9` right after the confirmation loses nothing. `DURABLE_ACK=0` turns this off (faster, but the last ~0.2 s can be lost in a crash). A save that fails is answered with `503 storage_unavailable` and retried by the client.
- **Group size**: at most 256 members by default (Admin → Settings → *Most members in a group*, 3 to 1000; `400 group_too_large`). Groups are fixed at creation.
- **Receipts**: only the sender sees who received and read a message; everybody else gets just their own entry. Delivery and read ticks go only to the sender.
- **Compression**: JSON and text responses are compressed (`COMPRESSION=0` if nginx already does it).
- **Load test**: `loadtest/` runs 500 users against a real server; results in [docs/TEST-REPORT-500-USERS.md](docs/TEST-REPORT-500-USERS.md). Use PostgreSQL in production: the file store rewrites the whole file on every change.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for what is protected and the open risks. Settings that matter in production:

- `NODE_ENV=production`: the server refuses to start if a testing switch (`OTP_DEV_CODES`, `*_SANDBOX`, `WEBHOOKS_ALLOW_PRIVATE`, `PREMIUM_FOR_ALL`) is on.
- `OTP_DAILY_SMS_LIMIT` (for example `2000`) and `OTP_ALLOWED_PREFIXES` (for example `+91`) protect against SMS bills.
- `ADMIN_REQUIRE_2FA=1` makes authenticator-app sign-in mandatory for administrators (they set it up on first login: Administrators → Two-step sign-in).
- `CORS_ORIGINS` (comma list); without it, and with `PUBLIC_URL` set, only your own address may call the API from a browser.
- **Login PIN** (users): Profile → Devices, browsers and PIN. Asked at every login. Support can remove a forgotten one (Admin → Users).
- **Sessions** end after 30 days without use; the user can see and sign out devices, or log out everywhere (`GET`/`DELETE /me/sessions`, `PUT /me/login-pin`). Other open devices get a *New login* notice (`security:login`).
- Signing up with a registered number, or logging in with an unknown one, gives the same answer as any request and sends nothing, so numbers cannot be probed.

## Privacy review

[docs/PRIVACY-COMPLIANCE.md](docs/PRIVACY-COMPLIANCE.md) lists every piece of data the app captures against the Privacy Notice, the download and the deletion, the answers for Google Play *Data safety* and Apple *App Privacy*, a check against DPDP, GDPR and COPPA, and what you must do before launch. Public pages: `/legal/privacy`, `/legal/terms`, `/legal/delete-account`.

## Terms of Use, Privacy Notice and consent

Everything people agree to, and their rights over their data, is built in. **The texts are written from what the app actually does, but they are not legal advice: have a lawyer review them (and the company details and retention periods) before go-live.**

- **Pages:** `/legal/privacy` and `/legal/terms` (public, light and dark). The same text as data: `GET /api/v1/legal` (versions, exact consent wording, company and Grievance Officer) and `GET /api/v1/legal/{privacy|terms}`. The Privacy Notice lists each kind of data collected and why, who it is shared with, what is and is not end-to-end encrypted, retention periods, rights and how to use them, security, hosting, cookies/device storage and the Grievance Officer. Written with India's DPDP Act, 2023 in mind.
- **Languages:** the notice, terms, deletion page and sign-up wording are available in English and all 22 Eighth-Schedule languages (`?lang=hi` on the pages and `GET /api/v1/legal`; a picker on sign-up and the accept screen). The language each person read is stored with their acceptance. Translations are AI-prepared: a "not yet checked" note shows until a certified translator has reviewed a language and you list its code in *Reviewed languages* (Admin → Settings → Legal, or `LEGAL_REVIEWED_LANGUAGES`). Workflow: `scripts/legal-i18n.js` (`source`, `build`, `missing`).
- **Company details:** shown in both texts. Set them in **Admin → Settings → Legal** (company, address, contact, Grievance Officer, city for courts, where the servers are, days in backups, days to answer a request) or with `LEGAL_COMPANY`, `LEGAL_ADDRESS`, `LEGAL_CONTACT_EMAIL`, `LEGAL_GRIEVANCE_NAME`, `LEGAL_GRIEVANCE_EMAIL`, `LEGAL_GRIEVANCE_PHONE`, `LEGAL_CITY`, `LEGAL_HOSTING`. Until they are filled in the pages show `[placeholders]` and the admin Overview warns you.
- **At sign-up** (individual and business) the person must tick one unticked box: agreement to the Terms of Use and Privacy Notice (with a short plain-language summary shown above it). Nothing is sent to their phone before that, and the server refuses to create an account without `consent: { terms: true, version }` (`400 consent_required`; an old version `409 consent_outdated`). What was accepted, which version and when is stored on the account.
- **Optional consents, asked when needed:** *message translation* (the text of received messages is sent to a translation service) and *identity verification* (the ID number is sent once to a verification service). The feature answers `403 consent_translation` / `consent_kyc` until the person agrees; they can withdraw in Profile → Privacy and consent (`PUT /me/consent/{id}`), which switches translation off everywhere. Call recording still needs everyone's agreement in each call.
- **When the texts change** raise `VERSION` in `server/legal.js`: everybody is blocked (REST, sockets and calls) behind an "Accept and continue" screen until they accept again. Accounts made before consent existed are not blocked unless you switch on *Ask older accounts to accept too*.
- **Rights, in Profile → Privacy and consent:** see what you agreed to; **Download my data** (`GET /me/export`: profile, settings, consent history, chats and messages, statuses, channels, developer keys; encrypted messages stay encrypted); **Delete my account**.
- **Deleting an account** (`POST /me/delete/code`, then `DELETE /me` with `{ requestId, code, confirmed: true }`): a popup explains what happens and needs a tick ("I understand that my account will be permanently disabled and my chats, media and personal data deleted…"), then a code sent by SMS. The account is **marked permanently disabled at once**: login stops, all sessions, API keys and webhooks are revoked, connections are closed, other people see "Deleted account", and the mobile number and email are released. **Chats, media and personal data are erased within 24 hours**: a sweeper runs every minute and does it about an hour after the request (`ACCOUNT_ERASE_DELAY_MS`, never more than 24 hours; the admin Overview warns if one is overdue). Erased: the messages and voice notes the person sent, status photos and product pictures, profile, name, number, email, keys and devices, statuses, channels and posts, products, developer keys and settings; they leave their groups (a group left with one person is deleted). **Kept, in an archive:** the account moves out of the live users into the `archivedUsers` table as a basic record marked `permanently_disabled`: username, registration date, when it was disabled and archived, the record of what they accepted, and any subscription or verification record. The archived username stays **reserved**, so a new account can never get it and never inherits the old chats, and other people's chats keep showing "Deleted account". Nothing in the live users table is left to clash with. **Registering again is allowed at once** with the same number: it creates a brand-new account (new username if the old one is taken, new registration date, none of the old data). Backups keep erased data for up to the days set in Settings → Legal.
- **Admin:** the user view shows which version each person accepted and when; the user list can show deleted accounts.
- **Not built, decide with your lawyer:** there is no age confirmation at sign-up (if ExamSuit students can be under 18, ask what the law requires, for example parental consent), a consent manager, data-breach reporting procedure, and the refund and liability wording in the Terms (shown as bracketed placeholders).

## Profile photos

Profile → **Profile photos** (or tap your big picture): add, remove, choose which is your picture, and who sees them.

- **Limits**: **2** photos for a free account, **5** with Premium (Admin → Settings → Free account limits: *Profile photos (free account)* and *(Premium)*). A free account that is full gets *Premium required* (`402 premium_required`); at the Premium maximum it is `409 limit_reached`. If Premium ends, the photos stay and nothing more can be added until the number is below the free limit.
- **Cropping and size**: the app crops each photo to a square (drag and zoom) and shrinks it on the device: a 512 px picture and a 128 px thumbnail, both JPEG. The server never trusts that: it reads the real type and size from the bytes (JPEG, PNG or WebP only; the picture at most 1024 px and 400 KB, the thumbnail at most 256 px and 48 KB) and refuses anything else (`415`, `413`, `400`).
- **Who sees them**: *everyone*, *my contacts* (people I chat with, in a chat or a group; **the default**) or *nobody*. A blocked person never sees them. **Under 18**: the photo is only ever shown to people the child chats with (`everyone` is applied as `contacts`), never in search, and not at all while the account waits for its parent or guardian. Photos are downloaded from `GET /media/{id}` with the login token, and the same rule applies to the file as to the profile.
- **Reporting**: anyone who can see a photo can report it (*nudity or sexual content, puts a child at risk, harassment or hate, violence, pretends to be someone else, something else*, with optional details). One report per person per photo and at most 20 a day. **Three different people, or one "puts a child at risk" report, hide the photo from everyone but its owner** until an administrator decides: Admin → *Channels & reports* → *Reported profile photos* shows the picture (only to administrators), who reported it and why, and offers *Looks fine* (restores it and clears the reports) or *Remove photo* (deletes the files and the reports; recorded in the audit log).
- **Change picture every 7 days (Premium)**: with a full set of photos (5 by default), switch on *Change my picture every 7 days* and the next photo becomes your picture a week later, then every 7 days (the old one goes to the back). Needs Premium (`402 premium_required`) and a full set (`409 not_enough_photos`); it pauses while Premium has ended. `PUT /me/photo-rotation { on }`, socket `photo:rotate`; `rotation` is in the photos view.
- **Admin switch**: *Profile photos* in Features. Off: photos are hidden everywhere and cannot be added; removing always works.
- **Data**: photos are stored as media files (backed up with the rest of `media/`), erased with the account, and included in *Download my data*. They are not end-to-end encrypted.
- **API**: `GET /me/photos`, `POST /me/photos` (`image` and `thumb` as base64), `PUT /me/photos/{id}/main`, `DELETE /me/photos/{id}`, `PUT /me/photo-privacy`, `GET /users/{username}/photos`, `POST /users/{username}/photos/{id}/report`; `user.photo` (`id`, `thumb`, `count`) appears wherever users are returned, only if you may see it. Socket: `photos:get`, `photo:upload`, `photo:main`, `photo:delete`, `photo:privacy`, `photos:user`, `photo:report`; server → client `photos:update`.

## Polls and events

Two buttons in the chat composer (📊 and 📅). Both are cards in the chat that update live for everyone.

| | Free | Premium |
|---|---|---|
| Poll options | 2 to **6** | up to **12** |
| Choices per voter | one | one or several |
| Voting | names visible | can be **anonymous** |
| Closing | the maker closes it | also **closes by itself** (1 minute to 30 days) |
| Event answers | Going / Maybe / Can't go, names listed | same |
| Event reminder | 1 hour before | 0, 15, 30, 60, 120 or 1440 minutes before |
| Repeating events | no | **weekly or monthly** (after it is over the card moves to the next date and answers start again) |

- A poll's maker can close it; an event's maker can edit it (moving the start moves the end) or cancel it (the card stays, marked canceled). Only members of the chat can see or answer; votes and answers of someone who deletes their account are removed.
- **Reminders** go to the maker and to everyone who answered Going or Maybe: a *Reminder* on screen and, when the app is closed, a push notification (text shown only if "preview" is on and the chat is not locked or hidden).
- **Privacy**: polls and events are **readable by the server** (it counts, closes and reminds), so they are not end-to-end encrypted even in an encrypted chat; the card shows the open-lock mark and the Privacy Notice says so. Locked and hidden chats withhold them like any message.
- **Admin**: switches *Polls* and *Events* in Features (off: no new ones or answers; closing and cancelling still work) and the limits *Poll options (free)* / *(Premium)* in Settings.
- **API**: `POST /conversations/{id}/polls`, `PUT /polls/{id}/vote`, `POST /polls/{id}/close`, `POST /conversations/{id}/events`, `PUT /events/{id}/rsvp`, `PATCH /events/{id}`, `POST /events/{id}/cancel`. Messages have `type: "poll"` (`poll`) or `"event"` (`event`). Socket: `poll:send`, `poll:vote`, `poll:close`, `event:send`, `event:rsvp`, `event:edit`, `event:cancel`; server → client `poll:update`, `event:update`, `event:reminder`.

## Parental control (under 18)

- **Sign-up**: everyone gives a date of birth. Below the minimum age (**8**, an administrator setting: Admin → Settings → Free account limits, range 5 to 17) there is no account (`403 too_young`). **8 to 17**: a parent or guardian is mandatory: name, relationship (mother, father, legal guardian, other) and a **mobile number and/or an email** (at least one; not the child's own). 18 and over: nothing extra. A business account must be opened by an adult.
- **Verifiable consent**: the account is created, but is closed (`403 guardian_required` on everything except `me`, the legal and consent calls, data export/delete and `/me/guardian*`) until the parent or guardian opens the **private link** sent to their mobile number and/or email and agrees. The child's app shows a waiting screen (resend the link, fix a wrong number, download or delete, log out) and moves on by itself when they agree. The link is a random token (only its hash is stored); a new link replaces the old one; messages to one number or address are rate-limited (one per 30 s, five per hour), so nobody can be flooded.
- **Controls** (the same link opens the parent's page, `/guardian/<token>`, with no account needed): *Voice and video calls* (default on), *Sharing location* (default **off**), *Being found by new people* (default **off**: not in search, and strangers cannot start a chat or a group with them; the child can still reach out, and people they already chat with are unaffected), *Public channels* (default on). They can also **disable** the account (the child is signed out everywhere and cannot log in until it is enabled again; an administrator's own suspension is never lifted by it) or **delete** it. Changes reach the child's open apps at once. Parents never see messages (they are end-to-end encrypted) and the page never shows the child's number.
- **At 18** the controls end automatically (checked hourly): the parent's contact details and link are erased, and only that they agreed (and when) is kept. If the account is deleted, the archive keeps only that proof of consent.
- **Admin**: user list filters *Under 18* and *Waiting for a parent or guardian*, age and guardian details on each user, and counters on the overview.
- **Premium**: *changing* the controls is a **Premium** feature of the child's account (bought in the child's app; an administrator can also grant it). Without Premium the safe defaults apply (no location sharing, not findable by new people, calls and channels on) and the parent's page shows the switches locked (`402 premium_required`). **Always free**: the parent agreeing (the legal safeguard: nobody under 18 can use VartiQ without it), disabling or enabling the account, and deleting it. If Premium ends, controls already set stay in force; only changing them stops.
- **Setup**: set **`PUBLIC_URL`** (for example `https://vartiq.prayuktech.com`): guardian links are built on it. Without it only `localhost` addresses are used, and a child cannot register on a public server (`503`): a link must never point to an address taken from a request. Messages are sent through the same SMS/email gateway as login codes (`OTP_WEBHOOK_URL`; the gateway receives `{ channel, to, purpose: "guardian", text }` and should send `text`).
- **API**: `birthDate` and `guardian` on `POST /auth/register`; `GET /me/guardian`, `PUT /me/guardian`, `POST /me/guardian/resend`; the guardian's calls `GET /guardian/{token}`, `POST …/consent`, `PUT …/controls`, `POST …/disable`, `POST …/enable`, `POST …/delete`; socket events `guardian:status`, `guardian:resend`, `guardian:contact` and the server event `guardian:update`.
- Accounts created before ages were asked have no date of birth and are treated as adults.

## Push notifications

Turn them on in **Profile → Notifications** (nothing is asked on page load: the browser's permission question appears only when you tap *Turn on*). Choose what you get: new messages, calls, and whether the sender's name is shown. Each browser/device is subscribed separately (up to 8 per account) and is removed when you turn it off, log out, or delete the account.

- **What is sent**: a small encrypted wake-up through the browser maker's push service (Google, Mozilla, Apple, Microsoft): who and what kind (`Asha: New message`, `Voice message`, `Incoming video call`, `Missed voice call`), never message text. Chats that are locked or hidden only ever say `New message`. A burst of messages from one chat is one notification.
- **When**: only to people who are not connected at that moment. If the app is open but in a hidden tab, the app shows the notification itself. A direct call to someone who is offline but has notifications on *rings*: the notification wakes them and the call is still ringing when they open the app (30 seconds).
- **Server**: keys are VAPID. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (make them with `npx web-push generate-vapid-keys`), or leave them out: a pair is created on first start and kept in `vapid.json` next to the data (back it up: if it is lost every device must turn notifications on again). `PUSH_SUBJECT` (a `mailto:` or `https:` address) identifies you to push services; by default the contact email from Admin → Settings → Legal is used. The server only sends to the known push services (`*.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`; add more with `PUSH_ALLOWED_HOSTS`), never to an address a user made up.
- **Admin**: the **Push notifications** feature switch. Off: nothing is sent and nobody can turn it on (turning off always works).
- **API**: `GET /push`, `PUT /push/subscription`, `POST /push/unsubscribe`, `PATCH /push/settings`, `POST /push/test`; socket events `push:config`, `push:subscribe`, `push:unsubscribe`, `push:settings`, `push:test`. The service worker is `/sw.js` (served uncached).
- Needs HTTPS (or `localhost`).

## Location sharing

The 📍 button in a chat opens *Share location*: **my current location (once)** or **live location for 15 minutes, 1 hour or 8 hours**. The browser asks for permission only then. Positions are sent like messages, **end-to-end encrypted** for everyone in the chat (inside the envelope as `{"t":"Location","loc":{"lat":…,"lon":…,"acc":…}}`); only API apps send plain coordinates.

- **No map is loaded in the app.** A shared position shows its coordinates and an *Open in map* link (OpenStreetMap), so nothing about where people are is sent to a map service until someone taps it.
- **Live**: the sender's browser sends a new position when they move about 15 m (or once a minute), never faster than every 5 seconds, **only while VartiQ is open** (browsers do not let a web page track you in the background; the app says so). A banner shows the running share with a *Stop sharing* button. One live share per chat; a new one ends the earlier one. The share ends at the chosen time or on *Stop*, and **the position is then erased from the server** (the message stays as "Live location ended"). No trail is kept: each update replaces the last one. Locked chats get no updates until unlocked.
- **Safety**: the privacy notice and terms cover it (and forbid using it to follow anyone). The device never uploads your location unless you tap Share.
- **Admin**: the **Location sharing** switch (off: buttons hidden, new shares and updates refused; stopping always works).
- **API**: `POST /conversations/{id}/location`, `PUT /live-locations/{id}`, `DELETE /live-locations/{id}`; socket events `location:send`, `location:update` (client → server and the event the other members get), `location:stop`; webhook event `location:update`.

## Chats saved on the device

The web app keeps a copy of each chat in the browser (IndexedDB, one database per account) so a chat opens instantly and only the newest messages are fetched again:

- Opening a chat shows the saved messages first, then asks the server for the latest page (50 messages). That page refreshes delivery ticks and removes anything deleted or expired since. If more than a page of new messages arrived, older pages are fetched until they meet the saved copy.
- **Load earlier messages** at the top of a chat shows older saved messages, then older ones from the server. Up to 1,000 messages per chat are kept.
- End-to-end encrypted messages are saved as the encrypted envelope only; the readable text is not stored and is decrypted again with this device's key.
- Never saved: chats that are locked, hidden or have disappearing messages (their saved copy is deleted when the setting is turned on), voice-note audio, and messages not yet sent.
- Profile → **Chats on this device** switches saving off or clears it. Logging out deletes it.
- The server stays the master copy, so a new device or browser still shows the full history after login. This is a cache, not a backup, and it does not make the app work offline.

**Deploying for real (a shared server that already runs another app, nginx, Cloudflare, calls through your own TURN server, backups): see [docs/DEPLOYMENT-KVM4.md](docs/DEPLOYMENT-KVM4.md).** Production settings worth knowing: `HOST=127.0.0.1` (listen only for the local web server), `TRUST_PROXY=loopback` (use the real visitor address behind nginx/Cloudflare), `TURN_URLS` + `TURN_SECRET` (short-lived call-relay credentials for your own coturn server). Login sessions are saved in the database (only a hash of each token) and last 90 days, so a restart does not log anyone out.

## PostgreSQL storage (for production)

By default VartiQ keeps its data in `data/db.json`. For real use set `DATABASE_URL` and the data lives in PostgreSQL instead:

```bash
createdb vartiq
export DATABASE_URL=postgres://user:password@localhost/vartiq
export MEDIA_DIR=/var/lib/vartiq/media        # voice notes and product pictures stay as files here (back this folder up too)
node server/index.js                           # prints "Data: PostgreSQL"
```

The tables (`docs`, `lists`) are created automatically. To switch an existing install, stop the app and run
`DATABASE_URL=... node tools/migrate-json-to-pg.js data/db.json` once (it refuses to write into a database that already has users; keep `db.json` as a backup).

How it works: the app still works on its in-memory data (fast), and saves **only what changed** to PostgreSQL about 150 ms after each change, instead of rewriting a whole file. A message is one row, so the database can grow to many millions of messages without slowing the app down. On a clean shutdown (`SIGTERM`/`SIGINT`) everything is flushed first; after a crash at most the last ~150 ms of changes are lost. If the database is unreachable the changes stay in memory and are retried.

Measured on a 4 CPU / 16 GB machine (the same size as a Hostinger KVM 4), 10,000 users connected at once with 300,000 messages already stored, each user sending a message every 25 s (`tools/load-test/`):

| | JSON file | PostgreSQL |
| --- | --- | --- |
| Users connected | 10,000 | 10,000 |
| Messages delivered | 40,000 of 40,000 | 40,000 of 40,000 |
| Message round trip, typical / 95% / 99% | 1 / 3 / 14 ms | 1 / 5 / 40 ms |
| Server memory | about 720 MB | about 970 MB |
| Data file rewrite per change | the whole file (50 MB and growing) | only the changed rows |

What this does **not** change yet: all data is still held in memory (about 0.3 KB per message), so memory grows with history; login sessions are held in memory (everyone signs in again after a restart); and it is still one Node.js process. Moving past roughly 10,000 to 20,000 people online at once needs more than one process (Redis for Socket.IO and sessions), and a very large history needs old messages loaded from the database on demand.

Tests: `npm test` runs everything against memory only. `npm run test:pg-shadow` re-runs the whole suite and checks after every store call that PostgreSQL saving noticed each change (no database needed). `TEST_DATABASE_URL=postgres://user:pass@localhost/vartiq_test npm run test:pg` also runs the PostgreSQL tests and checks that what is saved is read back identical.

## API for other platforms

Everything the app does (except placing calls, which needs WebRTC in a client) is available over a REST API, so CRMs, help desks, bots, mobile apps or back-office systems can integrate with VartiQ.

- **Docs**: open **`/api/docs`** (interactive, with "Try it out") or fetch **`/api/v1/openapi.json`** (OpenAPI 3.1; generate a client with any OpenAPI generator).
- **Availability**: the developer API (API keys, webhooks, API-key access) is **off by default** and must be switched on by an administrator (see *Admin dashboard*). Until then these calls answer `403 feature_disabled`.
- **Auth**: `Authorization: Bearer <token>` with either a session token (`POST /api/v1/auth/otp`, then `POST /api/v1/auth/login`) or an **API key** (`cak_…`). API keys are for servers and bots: they survive restarts, show when they were last used, and can be revoked. Create them in the app under **Profile → Developer**, or with `POST /api/v1/api-keys` while logged in.
- **Real-time events**: register a **webhook** (Developer panel or `POST /api/v1/webhooks`), or connect a Socket.IO client with `auth: { token: "<session token or API key>" }` to get the same events live (see Socket events below).
- **Same behaviour as the app**: messages sent over the API appear instantly in open apps, are delivered to webhooks, and follow the same rules (blocking, membership, limits).

### Quick start

```bash
BASE=http://localhost:3000/api/v1
# Log in: ask for a code by SMS, then send it back
REQ=$(curl -s -X POST $BASE/auth/otp -H 'Content-Type: application/json' \
  -d '{"purpose":"login","phone":"+919876543210"}' | jq -r .requestId)
read -p 'Code: ' CODE
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d "{\"phone\":\"+919876543210\",\"requestId\":\"$REQ\",\"code\":\"$CODE\"}" | jq -r .token)

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
  -d '{"url":"https://example.com/vartiq","events":["message:new","call:incoming"]}'
```

Conversation ids for direct chats contain colons (`dm:alice:bob`): URL-encode them in paths.

Main endpoints (all under `/api/v1`; full details in `/api/docs`):

| Area | Endpoints |
|------|-----------|
| Auth & account | `POST /auth/otp`, `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET/PATCH /me`, `POST /me/contact/otp` + `PUT /me/contact` |
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

**Verify every delivery**: `X-VartiQ-Signature` is `sha256=` + the hex HMAC-SHA256 of `"<X-VartiQ-Timestamp>.<raw body>"` using the webhook's secret (shown once when you create it). Reject old timestamps to stop replays.

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${req.headers['x-vartiq-timestamp']}.${rawBody}`).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(req.headers['x-vartiq-signature']), Buffer.from(expected));
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
| `API_RATE_LIMIT` | `120` | Requests per minute per credential (`RateLimit-*` headers; `429` + `Retry-After` when exceeded). Login/register/OTP: 20 per minute per IP (plus the per-number OTP limits above). |
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
vartiq/
├── server/
│   ├── index.js     # Express app and Socket.IO wiring
│   ├── service.js   # Every user action, shared by Socket.IO and the REST API
│   ├── api.js       # REST API v1 (auth, rate limits, CORS, errors)
│   ├── openapi.js   # OpenAPI 3.1 spec (served at /api/v1/openapi.json)
│   ├── auth.js      # Sign-up and login with one-time codes
│   ├── otp.js       # OTP codes: send, verify, limits, SMS/email delivery
│   ├── translate.js # Translating received messages per chat (gateway)
│   ├── photos.js    # Profile photos: what is accepted (real type and size), report reasons
│   ├── guardian.js  # Age rules, parent or guardian: sign-up checks, private link, controls, their page
│   ├── push.js      # Push notifications (Web Push, VAPID, allowed push services)
│   ├── admin.js     # Admin dashboard API (/admin/api)
│   ├── features.js  # Feature switches and platform settings
│   ├── payments.js  # Premium subscriptions: plans, checkout, payment confirmation
│   ├── kyc.js       # Verified badge: ID check through a KYC gateway (nothing stored)
│   ├── webauthn.js  # Fingerprint / face lock: challenges and signature checks
│   ├── webhooks.js  # Signed webhook delivery with retries
│   ├── calls.js     # 1:1 and group call signalling (ring, join, relay, hold, end, call log)
│   └── store.js     # Users, sessions, conversations, messages (JSON file storage)
├── public/
│   ├── icons/       # Message status icons
│   ├── index.html   # UI markup
│   ├── styles.css   # PrayukTech theme (light/dark)
│   ├── app.js       # Client logic
│   ├── call.js      # WebRTC call controller and call screen
│   ├── e2ee.js      # End-to-end encryption (Web Crypto; also used by the tests)
│   ├── admin/       # Admin dashboard (index.html, admin.js, admin.css)
│   ├── channels.js  # Public channels: list, discover and channel screen
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
    ├── auth.test.js
    ├── hidden.test.js
    ├── e2ee.test.js
    ├── kyc.test.js
    ├── premium.test.js
    ├── profileviews.test.js
    ├── translate.test.js
    ├── catalogue.test.js
    ├── channels.test.js
    ├── admin.test.js
    ├── calls.test.js
    ├── callrecording.test.js
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
| `link:create` / `link:list` / `link:remove` | Log-in passcode for a browser, browsers logged in, sign one out |
| `photos:get` / `photo:upload` / `photo:main` / `photo:delete` / `photo:privacy` / `photos:user` / `photo:report` | Profile photos: mine, someone's, report |
| `guardian:status` / `guardian:resend` / `guardian:contact` | A child's view of their parent or guardian: state, send the link again, fix their details |
| `location:send` / `location:update` / `location:stop` | Share a location (once or live), move a live share, stop it |
| `push:config` / `push:subscribe` / `push:unsubscribe` / `push:settings` / `push:test` | Notification settings and this device's subscription |
| `message:star`      | Star / unstar a message                  |
| `messages:starred`  | List my starred messages                 |
| `user:block`        | Block / unblock a contact                |
| `statuses`          | Status updates I can see (my own include who viewed them) |
| `status:post`       | Post a text or photo status update       |
| `status:view`       | Mark an update as seen                   |
| `status:delete`     | Delete one of my updates                 |
| `status:reply`      | Reply to an update (sent as a chat message) |
| `chat:disappearing` | Set a chat's timer (`seconds`, 0 = off) |
| `chat:continue` | After a mobile number change: show the earlier messages of this chat again |
| `settings:default-disappear` | My default timer for new chats |
| `business:get` / `business:set` / `business:remove` | My business profile |
| `chatlock:settings` | Whether a secret code is set, and my locked chats |
| `chatlock:set-code` / `chatlock:reset-code` | Create/change the secret code, or reset it (SMS code from `chatlock:reset-sms`, or the password) |
| `chatlock:reset-sms` | Send a reset code by SMS to my mobile number |
| `chatlock:clear`    | Remove the lock from all locked chats (code or biometric) |
| `hidden:hide` / `hidden:unhide` | Hide a chat / put it back in the chat list |
| `hidden:reveal` / `hidden:list` / `hidden:close` | Open hidden chats for this session (code or biometric), list them, close them again |
| `hidden:clear`      | Bring all hidden chats back to the chat list |
| `biometric:challenge` / `biometric:add` / `biometric:remove` | Fingerprint / face lock devices |
| `chatlock:lock` / `chatlock:remove` | Lock a chat / remove its lock (needs the code) |
| `chatlock:unlock`   | Unlock a chat for this app session (`auth.appSession` = one page load) |
| `chatlock:relock`   | Lock every chat unlocked in this session again |
| `messages:read`     | Mark a chat as read                      |
| `message:delete`    | Delete my message                        |
| `typing`            | Typing or recording started/stopped (`activity`) |
| `profile:update`    | Change display name / about              |
| `me:contact-code` / `me:contact-verify` | Send a code to a new mobile number/email, then save it |
| `call:start`        | Start a call (or join the group call already running in that chat) |
| `call:accept` / `call:reject` | Answer or decline an incoming call |
| `call:signal`       | WebRTC offer/answer/ICE candidate relay to one participant |
| `call:hold`         | Put the call on hold / resume            |
| `call:end`          | Leave / hang up                          |

Server → client: `message:new`, `message:status`, `message:deleted`, `conversation:new`, `hidden:update`, `presence`, `typing`, `user:updated`, `message:starred`, `blocked:update`, `call:incoming`, `call:joined`, `call:left`, `call:signal`, `call:hold`, `call:ended`, `call:state`, `status:new`, `status:viewed`, `status:deleted`, `location:update` (a live position moved or ended), `guardian:update` (a parent or guardian agreed or changed what is allowed), `photos:update` (my photos changed on another device, or one was hidden).

Voice-message audio and status photos are downloaded from `GET /media/:id` with an `Authorization: Bearer <token>` header; only members of the chat can fetch it.

## Notes / next steps

Login sessions are held in memory, so users need to log in again after a server restart. For production you'd want a real database (e.g. PostgreSQL/MongoDB), persistent sessions/JWT, HTTPS, rate limiting, a TURN server (and an SFU for bigger group calls), and features like photo/file sharing, push notifications and end-to-end encryption of messages.
