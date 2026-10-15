const { io } = require('socket.io-client');
const fs = require('fs');
const [from, to, perMsgSec, runSec, tag] = process.argv.slice(2);
const { tokens, convs } = JSON.parse(fs.readFileSync(require('os').tmpdir() + '/vartiq-load-tokens.json'));
const lat = []; let sent = 0, acked = 0, errs = 0, connected = 0, failed = 0;
const sockets = [];
const start = Date.now();
(async () => {
  for (let i = Number(from); i < Number(to); i++) {
    const s = io('http://localhost:3160', { auth: { token: tokens[i], appSession: `s${i}`, clientVersion: '1.0.0' }, transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => { connected++; });
    s.on('connect_error', () => { failed++; });
    s.on('disconnect', () => { connected--; });
    s.i = i; sockets.push(s);
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 8000)); console.log(tag, 'ramped', Date.now() - start, 'ms, connected', connected, 'failed', failed);
  const timers = sockets.map((s) => setInterval(() => {
    if (!s.connected) return; const conv = convs[Math.floor(s.i / 2)]; const t0 = process.hrtime.bigint(); sent++;
    s.timeout(20000).emit('message:send', { convId: conv, text: `hello ${sent}`, clientId: `${s.i}-${sent}` }, (err, res) => { if (err || !res?.ok) errs++; else { acked++; lat.push(Number(process.hrtime.bigint() - t0) / 1e6); } });
  }, Number(perMsgSec) * 1000 + Math.random() * 2000));
  await new Promise((r) => setTimeout(r, Number(runSec) * 1000));
  timers.forEach(clearInterval);
  lat.sort((a, b) => a - b); const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]?.toFixed(0);
  console.log(JSON.stringify({ tag, connected, failed, sent, acked, errs, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lat[lat.length - 1]?.toFixed(0) }));
  sockets.forEach((s) => s.close()); process.exit(0);
})();
