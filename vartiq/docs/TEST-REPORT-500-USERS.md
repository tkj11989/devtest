# VartiQ test report: 500 users

Date: 27 Oct 2026 · Test machine: 4 CPU, 16 GB · One Node process serving (file store, then PostgreSQL), load generator on the same machine · Harness: `loadtest/`.

## What was tested

500 real accounts through the real sign-up flow (SMS code, consent, date of birth), each with its own client IP; 500 live websocket connections; 1,500 direct chats; 40 groups of 12; one group with all 500 members; 10,000 messages with a delivery check for every recipient; 40 polls (everybody voting) and 40 events (everybody answering) with exact tally checks; 150 statuses; 60 profile photos; 100 chat locks; people search and profile views; blocking; idempotent retries; 500 people posting into the 500-member group at the same moment (250,000 deliveries); all 500 sockets dropped and reconnected; rate-limit abuse; admin dashboard; cross-user access attempts; server restart and hard kill; real browsers (up to 26 at once).

## Result

| Check | File store | PostgreSQL |
|---|---|---|
| Sign-up of 500 users (1,000 requests) | 0 errors, p95 46 ms | 0 errors, p95 71 ms |
| 500 websocket connections | 500/500, p95 88 ms | 500/500, p95 86 ms |
| 10,000 messages sent | 0 errors, p50 8 ms, p95 34 ms | 0 errors, p50 15 ms, p95 54 ms |
| Deliveries over the socket | 22,810/22,810 | 22,800/22,800 |
| Delivery delay (send to receiver) | p95 about 35 ms | p95 about 55 ms |
| Poll and event tallies (80 checks) | all exact | all exact |
| History integrity (600 reads) | no duplicates or disorder | same |
| Locked chats opened without the code | 0 | 0 |
| Cross-user access attempts (1,686) | 0 succeeded | (same code) |
| 500 simultaneous posts into the 500-member group | all 250,000 delivered, 18 s to finish | all delivered, 18 s |
| Reconnect storm (500 sockets) | all back in 6.6 s | all back in 6.0 s |
| 5,000 reads of `/me` and `/conversations` | p50 103 ms, p95 195 ms | p50 193 ms, p95 337 ms |
| Server memory at peak | 341 MB | 415 MB |
| Server CPU at peak | 81 % of one core | 81 % |
| Rate limits | one IP hammering login: refused after 20; one user: refused after about 120 a minute | same |
| Restart: sessions, chats, message counts | 500/500 sessions valid, 0 differences | same |
| Server stays up and idle afterwards | yes (0 % CPU) | yes |

## Defects found and fixed in this round

1. **Opening a big group could stall the server (high).** When someone read a group chat, the server sent the delivery/read status of *every* message to *every* member. A first read of a 1,000-message, 500-member group created hundreds of thousands of events, 1.6 GB of memory and an unresponsive server for over a minute (reproduced with 26 browsers). Now only the sender of a message is told. Regression test: `test/receipts.test.js`.
2. **Every connection cost members × groups × members (high with PostgreSQL).** Telling a person's contacts that they came online built each contact's full profile view, including the picture-visibility check, which scans group member lists. With 500 people online this stalled reads for up to 55 seconds and made a reconnect storm take 33 seconds. Presence now computes only online / last seen, and the picture check is skipped for people without photos. Reconnect storm: 33 s to 6 s; reads at p99: 16 s to 0.4 s; whole run: 157 s to 62 s.
3. Browser console warning "Unrecognized feature: bluetooth" from the Permissions-Policy header removed.

## Open findings (not fixed)

| # | Severity | Finding | Advice |
|---|---|---|---|
| 1 | Medium | **A message can be lost if the server is killed within about 0.2 s of acknowledging it** (changes are saved in the background after 150 to 200 ms). A normal stop (`systemctl stop`) flushes first and lost nothing; a crash or power cut can lose the last fraction of a second, in both the file store and PostgreSQL. | Accept, or make message sends wait for the save (costs latency). Use UPS/clean shutdowns. |
| 2 | Medium | **Very large simultaneous bursts are slow:** 500 people all posting into a 500-member group at the same instant took 18 s to deliver (250,000 deliveries, about 13,000 a second); a single message into that group takes 35 ms. Each message carries its growing delivered/read lists. | Fine for normal chat. For groups beyond a few hundred members, cap group size, or send counts instead of name lists. |
| 3 | Medium | **The chat list is large for people in a big group:** `GET /conversations` is about 90 KB for a member of a 500-member group and is not compressed. | Turn on gzip in nginx for `application/json`; consider a group size limit. |
| 4 | Low | **One server process, file store:** the whole database file (5.5 MB here) is rewritten on every change; PostgreSQL mode keeps the data safer and uses more memory (415 MB vs 341 MB). | Use PostgreSQL in production (already in the guide). |
| 5 | Info | A user blocked by someone can still "send": the message is accepted and silently never delivered (by design; verified the blocker never receives it). | none |
| 6 | Info | No group size limit: a group with all 500 users was created. | Decide a maximum (for example 256) if you want one. |

## Not covered

Real phones and networks, WebRTC calls (switched off), SMS gateway behaviour, Razorpay payments (covered by the separate fake-Razorpay tests), push delivery, more than about 26 real browsers at once, runs longer than a few minutes, and more than one server process.
