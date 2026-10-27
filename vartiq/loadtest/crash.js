const st = require('./state-file.json');
const BASE = 'http://localhost:3400/api/v1';
const u = st.users[7];
const h = { Authorization: `Bearer ${u.token}`, 'X-Forwarded-For': '7.7.7.7', 'Content-Type': 'application/json' };
(async () => {
  const lst = await (await fetch(`${BASE}/conversations`, { headers: h })).json();
  const c = lst.conversations.find((x) => x.type === 'direct');
  const before = (await (await fetch(`${BASE}/conversations/${c.id}/messages?limit=200`, { headers: h })).json()).messages.length;
  let acked = 0;
  for (let i = 0; i < 30; i++) { const r = await fetch(`${BASE}/conversations/${c.id}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: `crash ${i}` }) }); if (r.status === 201) acked += 1; }
  console.log(JSON.stringify({ conv: c.id, before, acked }));
})();
