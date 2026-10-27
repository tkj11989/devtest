'use strict';
const { io: connect } = require('socket.io-client');
const fs = require('fs');
const { execSync } = require('child_process');
const N = Number(process.env.USERS || 500);
const BASE = 'http://localhost:3400';
const SERVER_PID = Number(process.env.SERVER_PID);
const legal = require('../server/legal');
const report = { users: N, phases: {}, defects: [], notes: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
const lat = () => ({ ms: [], err: 0, codes: {} });
const stats = (l) => ({ n: l.ms.length, errors: l.err, p50: Math.round(pct(l.ms, 0.5)), p95: Math.round(pct(l.ms, 0.95)), p99: Math.round(pct(l.ms, 0.99)), max: Math.round(Math.max(0, ...l.ms)), codes: l.codes });
const defect = (sev, text) => { report.defects.push({ sev, text }); console.log(`  DEFECT[${sev}] ${text}`); };
let ipn = 0;
const ipFor = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

async function call(l, user, method, path, body, { raw = false, headers = {} } = {}) {
  const t0 = performance.now();
  let res; let data = null;
  try {
    res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { 'X-Forwarded-For': user?.ip || '203.0.113.1', ...(user?.token ? { Authorization: `Bearer ${user.token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    l.err += 1; l.codes.net = (l.codes.net || 0) + 1;
    return { status: 0, body: null };
  }
  l.ms.push(performance.now() - t0);
  l.codes[res.status] = (l.codes[res.status] || 0) + 1;
  if (res.status >= 400) l.err += 1;
  return { status: res.status, body: data };
}

function sample() {
  try {
    const [rss, cpu] = execSync(`ps -o rss=,pcpu= -p ${SERVER_PID}`).toString().trim().split(/\s+/).map(Number);
    return { rssMb: Math.round(rss / 1024), cpu };
  } catch { return { rssMb: 0, cpu: 0 }; }
}
const peak = { rssMb: 0, cpu: 0 };
const sampler = setInterval(() => { const s = sample(); peak.rssMb = Math.max(peak.rssMb, s.rssMb); peak.cpu = Math.max(peak.cpu, s.cpu); }, 1000);

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// 1x1 PNG-ish photo: use a real valid 512x512 PNG for the photo test.
const zlib = require('zlib');
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
const png = (w, h) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 150)]); return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]); };

(async () => {
  const T0 = Date.now();
  const users = Array.from({ length: N }, (_, i) => ({ i, ip: ipFor(i + 1), phone: `+9198${String(10000000 + i)}`, name: `Tester ${i}` }));

  // ---------- 1. sign-up ----------
  console.log('1. sign-up of', N, 'users (real OTP flow, one IP each)');
  const L1 = lat();
  await pool(users, 25, async (u) => {
    const sent = await call(L1, u, 'POST', '/auth/otp', { purpose: 'register', phone: u.phone });
    if (sent.status !== 200) return;
    const reg = await call(L1, u, 'POST', '/auth/register', { displayName: u.name, phone: u.phone, phoneOtp: { requestId: sent.body.requestId, code: sent.body.devCode }, consent: { terms: true, version: legal.VERSION }, birthDate: '1990-01-01' });
    if (reg.status === 201) { u.token = reg.body.token; u.username = reg.body.user.username; }
  });
  report.phases.signup = stats(L1);
  const ok = users.filter((u) => u.token);
  console.log(`   registered ${ok.length}/${N}`);
  if (ok.length < N) defect('high', `only ${ok.length}/${N} registered`);
  if (new Set(ok.map((u) => u.username)).size !== ok.length) defect('high', 'duplicate usernames issued');

  // ---------- 2. sockets ----------
  console.log('2. 500 websocket connections');
  const connectTimes = [];
  const inbox = new Map(); // username -> { msgs:Set, polls:[], ... }
  const evCount = { 'message:new': 0, 'poll:update': 0, 'event:update': 0, 'status:new': 0, errors: 0 };
  let seq = 0;
  const deliveryLag = [];
  await pool(ok, 50, async (u) => {
    const t0 = performance.now();
    const s = connect(BASE, { auth: { token: u.token, appSession: `s${u.i}` }, transports: ['websocket'], forceNew: true, extraHeaders: { 'X-Forwarded-For': u.ip }, reconnection: true });
    u.sock = s; u.got = new Set(); u.polls = new Map(); u.events = new Map();
    s.on('message:new', ({ message }) => {
      evCount['message:new'] += 1; u.got.add(message.id);
      const m = /^ping (\d+)$/.exec(message.text || '');
      if (m && sentAt.has(m[1])) deliveryLag.push(performance.now() - sentAt.get(m[1]));
    });
    s.on('poll:update', ({ message }) => { evCount['poll:update'] += 1; u.polls.set(message.id, message.poll); });
    s.on('event:update', ({ message }) => { evCount['event:update'] += 1; u.events.set(message.id, message.event); });
    s.on('status:new', () => { evCount['status:new'] += 1; });
    await new Promise((res) => { s.once('connect', () => { connectTimes.push(performance.now() - t0); res(); }); s.once('connect_error', () => { evCount.errors += 1; res(); }); });
  });
  const sentAt = new Map();
  report.phases.sockets = { connected: ok.filter((u) => u.sock?.connected).length, p50: Math.round(pct(connectTimes, 0.5)), p95: Math.round(pct(connectTimes, 0.95)), max: Math.round(Math.max(...connectTimes)) };
  console.log('  ', JSON.stringify(report.phases.sockets), JSON.stringify(sample()));
  if (report.phases.sockets.connected < ok.length) defect('high', `only ${report.phases.sockets.connected}/${ok.length} sockets connected`);

  // ---------- 3. chats ----------
  console.log('3. direct chats and groups');
  const L3 = lat();
  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (k, not) => { const s = new Set(); while (s.size < k) { const x = ok[rnd(ok.length)]; if (x !== not) s.add(x); } return [...s]; };
  const directs = []; // [conv, a, b]
  await pool(ok, 25, async (u) => {
    for (const peer of pick(3, u)) {
      const r = await call(L3, u, 'POST', '/conversations', { type: 'direct', username: peer.username });
      if (r.status === 201 || r.status === 200) directs.push({ id: r.body.conversation?.id || r.body.id, a: u, b: peer });
    }
  });
  const groups = [];
  const gsizes = [];
  await pool(Array.from({ length: 40 }), 10, async (_, k) => {
    const owner = ok[rnd(ok.length)];
    const members = pick(11, owner).map((m) => m.username);
    const r = await call(L3, owner, 'POST', '/conversations', { type: 'group', name: `Group ${k}`, members });
    if (r.status === 201) groups.push({ id: r.body.conversation?.id || r.body.id, owner, members: [owner.username, ...members] });
  });
  // the default group size limit refuses a 500-member group; then the administrator raises it for this stress test
  const refused = await call(L3, ok[0], 'POST', '/conversations', { type: 'group', name: 'Everyone', members: ok.slice(1).map((u) => u.username) });
  report.phases.groupLimit = { defaultRefused: refused.status === 400 && refused.body?.error?.code === 'group_too_large' };
  if (!report.phases.groupLimit.defaultRefused) defect('medium', 'a 500-member group was not refused by the default group size limit');
  const admToken = (await fetch(`${BASE}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'correct-horse-battery' }) }).then((r) => r.json())).token;
  await fetch(`${BASE}/admin/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admToken}` }, body: JSON.stringify({ limits: { maxGroupMembers: 1000 } }) });
  const big = await call(L3, ok[0], 'POST', '/conversations', { type: 'group', name: 'Everyone', members: ok.slice(1).map((u) => u.username) });
  report.phases.chats = { ...stats(L3), directs: directs.length, groups: groups.length, bigGroup: big.status, bigGroupMsg: big.body?.error?.message };
  console.log('  ', JSON.stringify(report.phases.chats));
  if (big.status !== 201) defect('info', `a group with ${ok.length} members was refused: ${big.body?.error?.message}`);

  // ---------- 4. messaging ----------
  console.log('4. messaging: 20 messages per user into direct chats and groups, with delivery check');
  const L4 = lat();
  const myConvs = new Map(ok.map((u) => [u, []]));
  for (const d of directs) { myConvs.get(d.a).push({ id: d.id, members: [d.a.username, d.b.username] }); myConvs.get(d.b).push({ id: d.id, members: [d.a.username, d.b.username] }); }
  for (const g of groups) for (const m of g.members) { const u = ok.find((x) => x.username === m); myConvs.get(u).push(g); }
  const sent = []; // { id, conv, from }
  const t4 = Date.now();
  await pool(ok, 100, async (u) => {
    const cs = myConvs.get(u);
    for (let k = 0; k < 20 && cs.length; k++) {
      const c = cs[rnd(cs.length)];
      const id = String(++seq);
      sentAt.set(id, performance.now());
      const r = await call(L4, u, 'POST', `/conversations/${c.id}/messages`, { text: `ping ${id}` });
      if (r.status === 201) sent.push({ mid: r.body.message?.id || r.body.id, conv: c, from: u.username });
      await sleep(20 + rnd(60));
    }
  });
  await sleep(2500);
  report.phases.messaging = { ...stats(L4), seconds: Math.round((Date.now() - t4) / 1000), sent: sent.length, deliveryLagMs: { p50: Math.round(pct(deliveryLag, 0.5)), p95: Math.round(pct(deliveryLag, 0.95)), p99: Math.round(pct(deliveryLag, 0.99)) } };
  // delivery completeness: every member except the sender must have received the message over the socket
  let expected = 0; let missing = 0;
  const byName = new Map(ok.map((u) => [u.username, u]));
  for (const s of sent) for (const m of s.conv.members) if (m !== s.from) { expected += 1; if (!byName.get(m).got.has(s.mid)) missing += 1; }
  report.phases.messaging.deliveries = { expected, missing };
  console.log('  ', JSON.stringify(report.phases.messaging), JSON.stringify(sample()));
  if (missing) defect('high', `${missing}/${expected} message deliveries missing over the socket`);
  if (L4.codes[429]) defect('medium', `${L4.codes[429]} messages refused by the rate limit (429) while ~${Math.round(20 / ((Date.now() - t4) / 60000))} msgs/min per user`);

  // ---------- 5. history integrity ----------
  console.log('5. history read-back and read receipts');
  const L5 = lat();
  let histBad = 0;
  await pool(ok.slice(0, 200), 25, async (u) => {
    const lst = await call(L5, u, 'GET', '/conversations');
    if (lst.status !== 200) return;
    const first = (lst.body.conversations || [])[0];
    if (!first) return;
    const h = await call(L5, u, 'GET', `/conversations/${first.id}/messages?limit=50`);
    if (h.status !== 200) { histBad += 1; return; }
    const ids = h.body.messages.map((m) => m.id);
    if (new Set(ids).size !== ids.length) histBad += 1;
    const ts = h.body.messages.map((m) => m.ts);
    if (ts.some((t, i) => i && t < ts[i - 1])) histBad += 1;
    await call(L5, u, 'POST', `/conversations/${first.id}/read`);
  });
  report.phases.history = { ...stats(L5), integrityProblems: histBad };
  if (histBad) defect('high', `${histBad} chat histories had duplicate or out-of-order messages`);

  // ---------- 6. polls and events ----------
  console.log('6. polls and events in 40 groups (everyone votes / answers)');
  const L6 = lat();
  const DAY = 864e5;
  let pollBad = 0; let eventBad = 0;
  await pool(groups, 10, async (g) => {
    const owner = g.owner;
    const pr = await call(L6, owner, 'POST', `/conversations/${g.id}/polls`, { question: `Lunch ${g.id.slice(-4)}?`, options: ['Pizza', 'Sushi', 'Thali'] });
    if (pr.status !== 201) { pollBad += 1; return; }
    const pid = pr.body.message.id; const opts = pr.body.message.poll.options.map((o) => o.id);
    const choices = {};
    await Promise.all(g.members.map(async (name) => {
      const u = byName.get(name); const pick1 = opts[rnd(3)]; choices[name] = pick1;
      await call(L6, u, 'PUT', `/polls/${pid}/vote`, { options: [pick1] });
    }));
    const er = await call(L6, owner, 'POST', `/conversations/${g.id}/events`, { title: `Meetup ${g.id.slice(-4)}`, startsAt: Date.now() + 2 * DAY, location: 'Cafe' });
    if (er.status !== 201) { eventBad += 1; return; }
    const eid = er.body.message.id; const answers = { [owner.username]: 'yes' };
    await Promise.all(g.members.filter((n) => n !== owner.username).map(async (name) => {
      const st = ['yes', 'maybe', 'no'][rnd(3)]; answers[name] = st;
      await call(L6, byName.get(name), 'PUT', `/events/${eid}/rsvp`, { status: st });
    }));
    await sleep(300);
    const view = (await call(L6, owner, 'GET', `/conversations/${g.id}/messages?limit=100`)).body.messages;
    const pv = view.find((m) => m.id === pid)?.poll; const ev = view.find((m) => m.id === eid)?.event;
    const want = [0, 0, 0]; for (const c of Object.values(choices)) want[opts.indexOf(c)] += 1;
    if (!pv || pv.options.map((o) => o.votes).join() !== want.join() || pv.total !== g.members.length) pollBad += 1;
    const wy = Object.values(answers).filter((x) => x === 'yes').length;
    if (!ev || ev.counts.yes !== wy || ev.counts.maybe + ev.counts.no + ev.counts.yes !== g.members.length) eventBad += 1;
  });
  report.phases.pollsEvents = { ...stats(L6), wrongPollTallies: pollBad, wrongEventTallies: eventBad, pollUpdatesPushed: evCount['poll:update'], eventUpdatesPushed: evCount['event:update'] };
  console.log('  ', JSON.stringify(report.phases.pollsEvents));
  if (pollBad) defect('high', `${pollBad} polls had wrong vote totals`);
  if (eventBad) defect('high', `${eventBad} events had wrong reply counts`);

  // ---------- 7. other features ----------
  console.log('7. statuses, profile photos, chat lock, search, profile views, blocks');
  const L7 = lat();
  const feat = {};
  await pool(ok.slice(0, 150), 25, async (u) => {
    const r = await call(L7, u, 'POST', '/statuses', { type: 'text', text: `Hello from ${u.name}`, bg: '#0670DE' });
    feat.status = (feat.status || 0) + (r.status === 201 ? 1 : 0);
  });
  const l7p = lat();
  await pool(ok.slice(0, 60), 10, async (u) => {
    const r = await call(l7p, u, 'POST', '/me/photos', { image: png(512, 512).toString('base64'), thumb: png(128, 128).toString('base64') });
    feat.photo = (feat.photo || 0) + (r.status === 201 ? 1 : 0);
  });
  await pool(ok.slice(0, 100), 25, async (u) => {
    const c = await call(L7, u, 'PUT', '/chat-lock/code', { code: 'secret123' });
    const conv = myConvs.get(u)[0];
    if (c.status === 200 && conv) {
      const l = await call(L7, u, 'PUT', `/conversations/${conv.id}/lock`);
      feat.lock = (feat.lock || 0) + (l.status === 200 ? 1 : 0);
      const m = await call(L7, u, 'GET', `/conversations/${conv.id}/messages?limit=5`);
      if (l.status === 200 && m.status !== 423) feat.lockLeak = (feat.lockLeak || 0) + 1; // a locked chat must not open without unlocking
    }
  });
  await pool(ok.slice(0, 200), 25, async (u) => {
    const s = await call(L7, u, 'GET', `/users?q=${encodeURIComponent('Tester 1')}`);
    feat.search = (feat.search || 0) + (s.status === 200 ? 1 : 0);
    const peer = ok[rnd(ok.length)];
    if (peer !== u) await call(L7, u, 'POST', `/users/${peer.username}/view`);
  });
  const blocker = ok[10]; const blocked = ok[11];
  await call(L7, blocker, 'PUT', `/blocked/${blocked.username}`);
  const dm = await call(L7, blocked, 'POST', '/conversations', { type: 'direct', username: blocker.username });
  const blockedSend = dm.body?.conversation?.id ? await call(L7, blocked, 'POST', `/conversations/${dm.body.conversation.id}/messages`, { text: 'hi' }) : { status: 0 };
  feat.blockedSendStatus = blockedSend.status;
  report.phases.features = { ...stats(L7), ...feat, photoLatency: stats(l7p) };
  console.log('  ', JSON.stringify({ ...feat }));
  if (feat.lockLeak) defect('critical', `${feat.lockLeak} locked chats opened without the code`);
  if ((feat.status || 0) < 150) defect('medium', `only ${feat.status}/150 statuses posted`);
  if ((feat.photo || 0) < 60) defect('medium', `only ${feat.photo}/60 profile photos uploaded`);

  // idempotent retry, blocked sender, isolated big-group message
  {
    const u = ok[20]; const conv = myConvs.get(u)[0];
    const key = { 'Idempotency-Key': `retry-${Date.now()}` };
    const r1 = await call(L7, u, 'POST', `/conversations/${conv.id}/messages`, { text: 'once' }, { headers: key });
    const r2 = await call(L7, u, 'POST', `/conversations/${conv.id}/messages`, { text: 'once' }, { headers: key });
    const id1 = r1.body.message?.id || r1.body.id; const id2 = r2.body.message?.id || r2.body.id;
    report.phases.idempotency = { sameMessage: id1 === id2 };
    if (id1 !== id2) defect('high', 'a retried message with the same Idempotency-Key was stored twice');
    const dmConv = dm.body?.conversation?.id;
    const hist = dmConv ? await call(L7, blocker, 'GET', `/conversations/${dmConv}/messages?limit=20`) : null;
    const leaked = hist?.body?.messages?.some((m) => m.text === 'hi');
    report.phases.blocked = { blockerSawBlockedMessage: !!leaked };
    if (leaked) defect('high', 'a blocked user message reached the person who blocked them');
  }
  if (big.body?.conversation?.id || big.body?.id) {
    const bid = big.body?.conversation?.id || big.body?.id; const lone = lat();
    for (let k = 0; k < 10; k++) { await call(lone, ok[30 + k], 'POST', `/conversations/${bid}/messages`, { text: `solo ${k}` }); await sleep(300); }
    report.phases.bigGroupSingleSend = stats(lone);
    console.log('   single sends into the 500-member group:', JSON.stringify(report.phases.bigGroupSingleSend));
  }

  // ---------- 8. spike: everybody into the big group ----------
  console.log('8. spike: all users send 1 message to the 500-member group at once');
  const L8 = lat();
  let bigId = big.body?.conversation?.id || big.body?.id;
  if (bigId) {
    const before = ok.map((u) => u.got.size);
    const t8 = Date.now();
    await Promise.all(ok.map(async (u) => { const id = String(++seq); sentAt.set(id, performance.now()); await call(L8, u, 'POST', `/conversations/${bigId}/messages`, { text: `ping ${id}` }); }));
    await sleep(6000);
    const gotDelta = ok.map((u, k) => u.got.size - before[k]);
    const wantEach = ok.length - 1;
    const short = gotDelta.filter((d) => d < wantEach).length;
    report.phases.spike = { ...stats(L8), totalMs: Date.now() - t8, usersWithAllMessages: ok.length - short, deliveriesExpected: ok.length * wantEach, deliveriesReceived: gotDelta.reduce((a, b) => a + b, 0) };
    console.log('  ', JSON.stringify(report.phases.spike), JSON.stringify(sample()));
    if (short) defect('high', `spike: ${short}/${ok.length} users missed some of the ${wantEach} broadcast messages`);
  }

  // ---------- 9. reconnect storm ----------
  console.log('9. reconnect storm: all sockets dropped and reconnected');
  const t9 = performance.now();
  ok.forEach((u) => u.sock.disconnect());
  await sleep(500);
  let back = 0; const rec = [];
  await pool(ok, 100, async (u) => { const t = performance.now(); u.sock.connect(); await new Promise((r) => { u.sock.once('connect', () => { back += 1; rec.push(performance.now() - t); r(); }); setTimeout(r, 15000); }); });
  report.phases.reconnect = { reconnected: back, p95: Math.round(pct(rec, 0.95)), totalMs: Math.round(performance.now() - t9) };
  console.log('  ', JSON.stringify(report.phases.reconnect));
  if (back < ok.length) defect('high', `only ${back}/${ok.length} reconnected`);

  // ---------- 10. steady read load ----------
  console.log('10. steady REST load: every user loads /me and /conversations 5 times');
  const L10 = lat();
  await pool(ok, 100, async (u) => { for (let k = 0; k < 5; k++) { await call(L10, u, 'GET', '/me'); await call(L10, u, 'GET', '/conversations'); } });
  report.phases.steadyRead = stats(L10);
  console.log('  ', JSON.stringify(report.phases.steadyRead));

  // ---------- 11. abuse / limits ----------
  console.log('11. abuse checks: one IP hammering login, one user hammering the API');
  const L11 = lat();
  const hammerIp = { ip: '198.51.100.77' };
  for (let k = 0; k < 40; k++) await call(L11, hammerIp, 'POST', '/auth/otp', { purpose: 'login', phone: `+91990000${String(1000 + k)}`, clientType: 'app' });
  const rl = L11.codes[429] || 0;
  const L11b = lat();
  await Promise.all(Array.from({ length: 300 }, () => call(L11b, ok[5], 'GET', '/me')));
  report.phases.abuse = { loginHammer429: rl, apiHammer: { ok: L11b.codes[200] || 0, limited: L11b.codes[429] || 0 } };
  console.log('  ', JSON.stringify(report.phases.abuse));
  if (!rl) defect('high', 'no rate limit on repeated OTP requests from one IP');
  if (!L11b.codes[429]) defect('medium', 'no per-user API rate limit at 300 requests');

  // ---------- admin ----------
  console.log('12. admin dashboard under data');
  const L12 = lat();
  const adm = await fetch(`${BASE}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'correct-horse-battery' }) }).then((r) => r.json());
  const a = async (path) => { const t = performance.now(); const r = await fetch(`${BASE}/admin/api${path}`, { headers: { Authorization: `Bearer ${adm.token}` } }); L12.ms.push(performance.now() - t); L12.codes[r.status] = (L12.codes[r.status] || 0) + 1; return r.json(); };
  const ov = await a('/overview'); await a('/users?pageSize=50'); await a('/users?q=Tester%2042'); await a('/settings'); await a('/audit');
  report.phases.admin = { ...stats(L12), usersCounted: ov.stats?.users?.total ?? ov.stats?.totalUsers ?? JSON.stringify(ov.stats).slice(0, 160) };
  console.log('  ', JSON.stringify(report.phases.admin));

  // snapshot for the restart check
  const snap = [];
  await pool(ok.slice(0, 120), 20, async (u) => {
    const lst = await call(lat(), u, 'GET', '/conversations');
    const c = (lst.body?.conversations || [])[0];
    if (!c) return;
    const h = await call(lat(), u, 'GET', `/conversations/${c.id}/messages?limit=200`);
    snap.push({ username: u.username, token: u.token, convs: lst.body.conversations.length, conv: c.id, msgs: (h.body?.messages || []).length });
  });
  fs.writeFileSync(process.env.STATE || 'state.json', JSON.stringify({ users: ok.map((u) => ({ username: u.username, token: u.token, ip: u.ip })), snap }));
  clearInterval(sampler);
  report.server = { peakRssMb: peak.rssMb, peakCpuPct: peak.cpu, final: sample() };
  report.totalSeconds = Math.round((Date.now() - T0) / 1000);
  ok.forEach((u) => u.sock?.close());
  fs.writeFileSync(process.env.OUT || 'report.json', JSON.stringify(report, null, 2));
  console.log('\nDONE', JSON.stringify(report.server), 'seconds', report.totalSeconds, 'defects', report.defects.length);
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
