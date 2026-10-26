# VartiQ security: what is protected, what is left

Last reviewed after the security pass of October 2026 (code review plus `npm audit`; not a penetration test).

## What the server does

| Area | Protection |
|---|---|
| Browser | Strict Content-Security-Policy (own scripts only, no framing, no plugins), `nosniff`, HSTS over https, `Referrer-Policy`; the guardian page allows only its one script by hash; media files are served sandboxed |
| Login | SMS code (hashed, 5 tries, 5 a day per number); optional **login PIN** (hashed, escalating lock kept with the account); browsers need a **passcode from the primary phone**; a new login is shown on the other open devices |
| Sessions | 30 days without use, then gone; token stored only as a hash; Profile → Devices and login lists them, signs one out, or logs out everywhere; ending a session also closes its live connection |
| Enumeration | Asking to sign up with a registered number, or to log in with an unknown one, looks like any other request (same answer, same limits, nothing sent) |
| SMS cost | `OTP_DAILY_SMS_LIMIT` (all SMS a day), `OTP_ALLOWED_PREFIXES` (e.g. `+91`), per-number and per-IP limits |
| Admin | Separate accounts, lockout, audit log, **two-step sign-in (authenticator app)**, `ADMIN_REQUIRE_2FA=1` makes it mandatory, sign out all sessions, reset a colleague's 2-step |
| Webhooks | Private, loopback and link-local addresses refused **at connection time** (DNS-rebinding safe), no redirects, signed deliveries |
| Chat lock | Wrong-code count and wait kept with the account (survive restarts) |
| Dependencies | `npm audit` clean at the time of review; run it before every release |
| Production guard | `NODE_ENV=production` refuses to start with `OTP_DEV_CODES`, `*_SANDBOX`, `WEBHOOKS_ALLOW_PRIVATE` or `PREMIUM_FOR_ALL` set |
| CORS | Only `CORS_ORIGINS`, or your own `PUBLIC_URL`, may call the API from a website |

## Still open (accepted or needs your action)

1. **SMS is the weakest link.** A SIM swap or intercepted SMS can still take over an account that has no login PIN. Mitigation: encourage the login PIN (Profile → Devices and login), watch the "New login" alerts. A stronger option for the future is passkeys at login.
2. **`clientType` is declared by the client.** The "browsers need a passcode" rule stops honest browsers; a client that says `app` skips it. The PIN and the new-login alert are the real protection against someone who holds the SMS code.
3. **"Registered from the number in the phone" cannot be proven by a web app.** The SMS code proves the number is reachable, not that the SIM is in the device used.
4. **Data at rest is not encrypted by the app.** Use full-disk encryption on the server and encrypted, access-limited backups (see the deployment guide). Message text is end-to-end encrypted; who talks to whom, when, is metadata the server knows.
5. **Under-18 consent is not identity proof.** The private link proves access to a number or email, not parenthood. The date of birth is self-declared. The Terms say so.
6. **Timing information still leaks a little:** on a browser, a number whose account has a signed-in phone is told to use a passcode.
7. **State kept in memory** (OTP codes, passcodes, rate limits, admin sessions) is lost on restart; the wrong-PIN and chat-lock counters are not. Run one server process, or add a shared store before scaling out.
8. **A forgotten login PIN needs support** (Admin → Users → Remove login PIN). Have a way to check who is asking before you do it.
9. **Chat lock codes may be 4 characters.** The lock-out makes guessing slow, but a longer code is better.
10. **Operations are on you:** firewall, SSH keys, patching, certificates, secret files with mode 600, monitoring and alerting on SMS spend, offsite backup tests.
