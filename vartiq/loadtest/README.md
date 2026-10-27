# 500-user load and functional test

Runs against a real server process (not in-process), with production-like settings: real rate limits, a different client IP per user (`X-Forwarded-For`, `TRUST_PROXY=loopback`), SMS codes shown with `OTP_DEV_CODES=1` (test only).

```
cd vartiq
# 1. server (file store; add DATABASE_URL=postgres://… LOAD_SCHEMA=load1 for PostgreSQL)
OTP_DEV_CODES=1 LOAD_DIR=/tmp/vq-load node loadtest/server.js &
# 2. the test: sign-up, sockets, chats, messages, polls/events, statuses, photos, locks, spike, reconnect storm, abuse, admin
SERVER_PID=$! USERS=500 OUT=report.json STATE=state.json node loadtest/run.js
# 3. extra checks
STATE=state.json node loadtest/authz.js        # cross-user access attempts (must all be refused)
node loadtest/crash.js; kill -9 <server>       # durability window after a hard kill
# restart the server, then:
STATE=state.json node loadtest/persist.js      # sessions, chats and message counts survived a restart
```

Results of the October 2026 run are in `docs/TEST-REPORT-500-USERS.md`.
