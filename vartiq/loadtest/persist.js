// After a server restart: sessions still valid, conversations and messages identical.
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.env.STATE || 'state.json'));
const BASE = 'http://localhost:3400/api/v1';
const get = async (path, u) => { const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${u.token}`, 'X-Forwarded-For': u.ip || '203.0.113.9' } }); return { status: r.status, body: await r.json().catch(() => null) }; };
(async () => {
  let sessionsOk = 0; let convDiff = 0; let msgDiff = 0;
  for (let i = 0; i < st.users.length; i += 25) {
    await Promise.all(st.users.slice(i, i + 25).map(async (u) => { if ((await get('/me', u)).status === 200) sessionsOk += 1; }));
  }
  for (const s of st.snap) {
    const lst = await get('/conversations', s);
    if ((lst.body?.conversations || []).length !== s.convs) convDiff += 1;
    const h = await get(`/conversations/${s.conv}/messages?limit=200`, s);
    if ((h.body?.messages || []).length !== s.msgs) msgDiff += 1;
  }
  console.log(JSON.stringify({ users: st.users.length, sessionsStillValid: sessionsOk, sampled: st.snap.length, conversationCountDiffs: convDiff, messageCountDiffs: msgDiff }));
})();
