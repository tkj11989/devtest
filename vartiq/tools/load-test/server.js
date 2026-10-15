const path = require('path'), fs = require('fs');
const R = path.join(__dirname, '..', '..');
const { createApp } = require(R + '/server/index.js');
const { Store } = require(R + '/server/store.js');
const { monitorEventLoopDelay } = require('perf_hooks');
const N = Number(process.env.N || 10000), PORT = 3160;
const dir = path.join(require('os').tmpdir(), 'vartiq-load-data'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const store = new Store({ file: path.join(dir, 'db.json') });
const tokens = [];
for (let i = 0; i < N; i++) {
  const u = store.registerVerified({ displayName: `User ${i}`, username: `u${String(i).padStart(5, '0')}`, phone: `+9190${String(i).padStart(8, '0')}` });
  tokens.push(u.token || store.createSession(`u${String(i).padStart(5, '0')}`).token);
}
// pair users: 2k <-> 2k+1
const convs = [];
for (let i = 0; i < N; i += 2) convs.push(store.getOrCreateDirect(`u${String(i).padStart(5, '0')}`, `u${String(i + 1).padStart(5, '0')}`).id || store.getOrCreateDirect(`u${String(i).padStart(5, '0')}`, `u${String(i + 1).padStart(5, '0')}`));
fs.writeFileSync(path.join(require('os').tmpdir(), 'vartiq-load-tokens.json'), JSON.stringify({ tokens, convs: convs.map((c) => (typeof c === 'string' ? c : c.id)) }));
const { server } = createApp({ store, rateLimit: { windowMs: 60000, max: 1e9, authMax: 1e9 } });
server.listen(PORT, () => console.log('listening', N));
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
let last = process.cpuUsage(), lastT = Date.now();
setInterval(() => {
  const c = process.cpuUsage(last), dt = (Date.now() - lastT) * 1000; last = process.cpuUsage(); lastT = Date.now();
  const size = fs.existsSync(path.join(dir, 'db.json')) ? fs.statSync(path.join(dir, 'db.json')).size : 0;
  fs.appendFileSync(path.join(require('os').tmpdir(), 'vartiq-load-stats.log'), JSON.stringify({ t: Math.round(Date.now() / 1000), cpuPct: Math.round(((c.user + c.system) / dt) * 100), rssMB: Math.round(process.memoryUsage().rss / 1048576), lagP50: +(h.percentile(50) / 1e6).toFixed(1), lagP99: +(h.percentile(99) / 1e6).toFixed(1), lagMax: +(h.max / 1e6).toFixed(0), dbMB: +(size / 1048576).toFixed(1) }) + '\n'); h.reset();
}, 5000);
process.on('SIGTERM', () => process.exit(0));
