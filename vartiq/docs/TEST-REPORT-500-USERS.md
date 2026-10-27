# VartiQ test report: 500 users

Date: 27 Oct 2026 · Test machine: 4 CPU, 16 GB · One Node process serving (file store, then PostgreSQL), load generator on the same machine · Harness: `loadtest/`.

## What was tested

500 real accounts through the real sign-up flow (SMS code, consent, date of birth), each with its own client IP; 500 live websocket connections; 1,500 direct chats; 40 groups of 12; one group with all 500 members; 10,000 messages with a delivery check for every recipient; 40 polls (everybody voting) and 40 events (everybody answering) with exact tally checks; 150 statuses; 60 profile photos; 100 chat locks; people search and profile views; blocking; idempotent retries; 500 people posting into the 500-member group at the same moment (250,000 deliveries); all 500 sockets dropped and reconnected; rate-limit abuse; admin dashboard; cross-user access attempts; server restart and hard kill; real browsers (up to 26 at once).

## Result

| Check | File store | PostgreSQL |
|---|---|---|
| Sign-up of 500 users (1,000 requests) | 0 errors, p95 46 ms | 0 errors, p95 71 ms |
| 500 websocket connections | 500/500, p95 88 ms | 500/500, p95 86 ms |
| 10,000 messages sent | 0 errors, p50 8 ms, p95 34 ms (first round) | 0 errors, p50 15 ms, p95 54 ms (first round) |
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

## Findings closed afterwards (second round, same test re-run)

| # | Finding | Fix | Result |
|---|---|---|---|
| 1 | A message acknowledged less than 0.2 s before a hard kill was lost (both stores) | The server now answers "done" only after the change is saved (`store.whenSaved()`, one shared save for everybody waiting; `DURABLE_ACK=0` restores the old behaviour; a failed save is reported as `503 storage_unavailable`) | `kill -9` right after the last acknowledgement: **0 lost** with the file store and with PostgreSQL (was 30 of 30). Cost: sending takes about 50 ms instead of 10 ms at p50 (p95 91 ms) |
| 2 | 500 people posting into a 500-member group at once took 18 s | Everybody except the sender now gets only their own entry in `deliveredTo` / `readBy` (the sender still sees all) | Same burst: **10.6 s** (file) and **11.7 s** (PostgreSQL); p95 per sender 12 s down to 4.5 to 5.6 s |
| 3 | 90 KB uncompressed chat list | Responses are compressed (`compression`, 1 KB threshold; `COMPRESSION=0` turns it off if nginx does it) | Covered by a test; `Content-Encoding: gzip` |
| 4 | File store rewrites the whole file on every change | The server warns at start in production when `DATABASE_URL` is not set; the guide already recommends PostgreSQL. With durable acknowledgement, saves are grouped (at most one every 25 ms) | Load run unchanged in length (54 s file, 61 s PostgreSQL) |
| 5 | Blocked sender is accepted silently | By design (the blocked person is not told); verified the blocker never receives it | none |
| 6 | No group size limit | New admin limit *Most members in a group* (default **256**, 3 to 1000, `400 group_too_large`) | The 500-member group is refused by default; the stress test raises the limit first |

Second-round figures: 500/500 sign-ups, sockets and reconnects; 0 missing deliveries out of about 22,900; polls and events exact; 0 defects in both runs; server memory 452 MB (file) / 465 MB (PostgreSQL); restart check 0 differences.

## Still true

* A hard power cut during the 25 ms group save is the only window left; PostgreSQL's own durability settings apply from there.
* A burst of 500 simultaneous posts into one 500-member group still takes about 10 s, because each of the 250,000 deliveries is a separate message to a separate person; ordinary chat (one message into that group: 76 ms) is not affected. The default group limit of 256 halves the worst case.

## Not covered

Real phones and networks, WebRTC calls (switched off), SMS gateway behaviour, Razorpay payments (covered by the separate fake-Razorpay tests), push delivery, more than about 26 real browsers at once, runs longer than a few minutes, and more than one server process.
