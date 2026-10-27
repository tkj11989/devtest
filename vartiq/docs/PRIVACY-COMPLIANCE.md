# Privacy and data capture: review against platform and legal standards

Reviewed 28 Oct 2026 against the code (what is really stored), the Privacy Notice and Terms texts (`server/legal.js`, version `2026-10-28`), and these standards: India's **DPDP Act 2023**, **Google Play** (Data safety, User Data, Account deletion), **Apple App Store** (App Privacy labels, account deletion, user-generated content), **GDPR/UK GDPR**, and **COPPA** (US children). This is an engineering review, not legal advice: a lawyer must approve the texts before launch.

## 1. What the app captures (checked against the code)

| Data | Why | Where kept | In the Privacy Notice | In "Download my data" | Erased on account deletion |
|---|---|---|---|---|---|
| Mobile number (mandatory), email (optional; mandatory for business) | Login, codes, contact | user record | yes | yes | yes |
| Name, username, about | Profile | user record | yes | yes | yes (name replaced by "Deleted account") |
| Date of birth | Age rules, parent controls | user record | yes | yes | yes |
| Parent or guardian name, relationship, phone/email, consent time, controls | Under-18 rules | user record | yes | yes | yes (contact details also erased at 18) |
| Login PIN (salted hash), wrong-guess counters | Optional 2nd step | user record | yes (added) | flag only, never the hash | yes |
| Devices logged in (name, times), device encryption public keys, passkeys (public key) | Security, E2EE | sessions / user record | yes (added) | yes (added) | yes |
| Messages (E2EE ciphertext for the web app; readable text for API messages), voice notes | Delivery | messages | yes | yes | content erased within 24 h |
| Polls and events with votes and answers | Counting, reminders | messages | yes | yes (own view) | votes removed; created ones erased |
| Statuses and who viewed them | 24-hour updates | statuses | yes (viewers added) | yes (viewers added) | yes |
| Profile photos | Picture | media | yes | yes (file included) | yes |
| Shared location (once / live latest point only) | Sharing | messages | yes | yes | yes |
| Push subscription (browser endpoint, keys, browser name) and preferences | Notifications | user record | yes | yes | yes |
| Premium plan, payments (amount, date, plan, payment number), orders | Receipts, accounting | user record | yes (provider receives username/plan/reference: added) | yes (orders added) | kept without name or contact details, as accounting law requires |
| Verification flag and date (never the ID number) | Verified badge | user record | yes | yes | kept as part of the basic record |
| Business profile, catalogue | Public business page | user record | yes | yes | yes |
| Channels, posts, reports | Public content, moderation | channels, reports | yes | yes (photo reports added) | yes |
| Developer API keys (hash), webhooks, delivery log | Developer API | keys / webhooks | yes (added) | yes | yes |
| Consent record (version, items, time) | Proof of consent | user record | yes | yes | kept (basic record) |
| IP address | Rate limiting, security | memory only (not written to the database); web server logs hold it | yes ("technical data") | n/a | per server log rotation |

**Test result:** an automated check created a rich account, deleted it, and searched the whole database for the person's name, number, email, message text, status, device name, push agent, business text and poll question: nothing was left; only the other person's copy of a direct chat remains, with the content erased and the sender shown as "Deleted account" (as the notice says). No sessions remain.

**Not captured (good, and stated in the notice):** phone contact book, background location, advertising identifiers, analytics or crash-reporting SDKs, third-party scripts (the page's Content-Security-Policy only allows its own scripts), card/UPI/bank details (Razorpay's page handles them), ID numbers.

**Minimisation check:** every mandatory field is needed: mobile number (account key), name, date of birth (age rules). Email is optional for individuals. No other field is required.

## 2. Gaps found and fixed in this review

1. Notice and Terms told people to look in *Profile → Privacy and consent*; the screen moved to **Settings**. Fixed (3 places).
2. Not disclosed: status viewers, developer data (API keys, webhooks, delivery log), logged-in devices, login PIN, and that the payment provider receives the **username, plan and order reference**. Added to the data table, the sharing section and the retention table.
3. Retention table lacked polls/events, devices, PIN, developer data. Added.
4. No section for **GDPR / UK GDPR** users (legal bases, restriction, portability, objection, complaint to the authority, transfers). Added as section 12.
5. **Account-deletion web page** (required by Google Play for apps that let people create accounts; Apple also wants in-app deletion, which exists): new public page `/legal/delete-account` (also `GET /api/v1/legal/delete-account`) covering the in-app way, the way without the app or the number, what is erased and kept.
6. "Download my data" did not include logged-in devices, PIN flag, payment orders, status viewers or photo reports. Added.
7. Administrators opening a person's account details was not recorded. Now every view is written to the audit log (`view-user`).
8. Texts version raised to `2026-10-28`: everyone is asked to accept again.

## 3. Store declarations (answers to give)

**Google Play → Data safety**

| Section | Answer |
|---|---|
| Data collected | **Personal info**: name, email address (optional), phone number, user IDs, date of birth ("other info"). **Messages**: other in-app messages (end-to-end encrypted in transit and at rest on the server for the web app). **Photos and videos**: photos (profile and status). **Audio**: voice messages. **Location**: precise location, only when the user shares it. **Financial info**: purchase history (card/UPI details are never collected). **App info and performance**: none. **Device or other IDs**: push notification addresses and device encryption keys. |
| Collected for | App functionality, account management, security and fraud prevention, communications. **Not** advertising or marketing, **not** analytics. |
| Shared with third parties | Payment provider (Razorpay: username, plan, order reference), SMS/email provider (mobile number, code text), push services of browser makers (no message text), hosting providers. These are service providers acting on your behalf; declare payment and SMS processors if Play's wording requires. |
| Data encrypted in transit | Yes (HTTPS) |
| Users can request deletion | Yes: in the app and at the web URL `https://<your domain>/legal/delete-account` |
| Data is optional | Email, photos, location, statuses are optional; mobile number, name and date of birth are required |
| Families policy / children | App is for ages 8+; with parental consent under 18; no ads, no tracking of children |
| Privacy policy URL | `https://<your domain>/legal/privacy` |

**Apple → App Privacy ("nutrition labels")**: *Data linked to you*: Contact Info (name, email, phone number), User Content (messages, photos, audio), Identifiers (user ID, device ID), Purchases (purchase history), Location (precise, only when shared), Other Data (date of birth). *Data used to track you*: **none** (no tracking, no ad networks). Purpose for all: App Functionality; Contact Info also Account Management and Security. Required: Privacy Policy URL, in-app account deletion (exists: Settings → Privacy and consent → Delete my account), and support URL.

## 4. Standard-by-standard check

| Standard | Requirement | Status |
|---|---|---|
| DPDP Act | Itemised notice of data and purpose before consent | Yes (sign-up shows the facts; links to both documents; consent must be ticked) |
| | Consent recorded with version and time; withdrawal as easy as giving | Yes (Settings → Privacy and consent; optional consents can be withdrawn) |
| | Rights: access, correction, erasure, grievance, nomination | Yes (download, edit, delete, Grievance Officer, nomination clause) |
| | Grievance officer contact | Yes, once filled in (Admin → Settings → Legal) |
| | Verifiable parental consent for children, no tracking, no behavioural monitoring, no targeted ads to children | Yes: guardian link, controls; no ads or tracking anywhere. Link proves access to the guardian's number or email, not parenthood (stated in the Terms) |
| | Data erased when purpose ends; retention stated | Yes (24 h after deletion; table of periods; backups {backupDays} days) |
| | Breach notification to the Board and people | Stated in the notice; **you need a written incident procedure** |
| | Notice available in English and Eighth-Schedule languages | **Met, pending review**: all 22 Eighth-Schedule languages (`server/legal-i18n/`, picker on sign-up and the gate, `?lang=` on the pages and API). The translations are AI-prepared and show a "not yet checked" note until a certified translator signs them off and the code is added to *Reviewed languages*. Review first: brx, doi, ks, kok, mai, mni, sat, sd, sa |
| | Significant Data Fiduciary duties (DPO, audits) | Only if the government designates you; not assessed |
| Google Play | Privacy policy link; Data safety form; in-app and web deletion; sensitive permissions explained | Yes (see section 3); notifications and location are asked only when the person turns them on |
| Apple | Privacy labels; account deletion in-app; **user-generated content**: report mechanism, blocking, published contact, filtering | Deletion yes; blocking yes; contact yes; reporting exists for channels and profile photos but **not for individual messages** (they are end-to-end encrypted); Apple may ask for it |
| GDPR / UK GDPR | Legal bases, rights, transfers, complaint to authority, DPA with processors | Notice updated (section 12); **you need data-processing agreements with the SMS, hosting, TURN, payment and push providers, and an EU/UK representative if you target those countries** |
| COPPA (US) | Verifiable parental consent for under 13, direct notice to parents | **Not met for the US**: consent by link is not an FTC-approved method. Either do not offer the app to under-13s in the US, or add an approved method (card check, signed form, video call) |

## 5. Actions for you before launch

1. Fill in **Admin → Settings → Legal**: company name, address, contact email, Grievance Officer name, email and phone, hosting location, providers. Until then the pages show `[placeholders]` and the admin overview says so.
2. Have a lawyer read the Privacy Notice, Terms and deletion page (they are written from the code, not from a template).
3. Sign data-processing agreements with every provider named in the notice.
4. Have certified translators check each language in `server/legal-i18n/`, then list the checked codes in Admin → Settings → Legal → Reviewed languages (or `LEGAL_REVIEWED_LANGUAGES`). Raise the version when you change English text; run `node scripts/legal-i18n.js missing <code>` to see what needs translating.
5. Write an incident-response and breach-notification procedure; decide who answers rights requests within the stated {responseDays} days.
6. If you will serve the US, EU or UK: COPPA method, EU/UK representative, transfer clauses.
7. Fill in the store forms using section 3 and publish the three URLs: `/legal/privacy`, `/legal/terms`, `/legal/delete-account`.
8. Keep `NODE_ENV=production`, HTTPS, and rotate web server logs (they hold IP addresses).
