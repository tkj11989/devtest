# Load test

Connects many fake users over WebSocket and has each send a message every ~25 s.

```bash
ulimit -n 65535
N=10000 node tools/load-test/server.js          # makes N users, starts a server on :3160
node tools/load-test/client.js 0 5000 25 120 A  # users 0-4999, 1 msg/25 s, run 120 s
node tools/load-test/client.js 5000 10000 25 120 B
```
Each client prints connected/failed counts and the message round-trip time (p50/p95/p99). The server appends CPU, memory, event-loop delay and data-file size every 5 s to `$TMPDIR/vartiq-load-stats.log`. Run clients on a separate machine for honest numbers; here they share the CPU with the server.
