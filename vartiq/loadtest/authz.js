// Cross-user access attempts: a user must never read or change another person's chats, polls, events, media, or sessions.
const st = require('./state-file2.json');
const BASE = 'http://localhost:3400/api/v1';
const call = async (u, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${u.token}`, 'X-Forwarded-For': u.ip, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
(async () => {
  const bad = []; let tried = 0;
  const rnd = (n) => Math.floor(Math.random() * n);
  for (let k = 0; k < 150; k++) {
    const victim = st.users[100 + rnd(300)]; const attacker = st.users[rnd(100)];
    const convs = (await call(victim, 'GET', '/conversations')).body.conversations.filter((c) => c.name !== 'Everyone');
    const mine = new Set((await call(attacker, 'GET', '/conversations')).body.conversations.map((c) => c.id));
    const c = convs.find((x) => !mine.has(x.id));
    if (!c) continue;
    const msgs = (await call(victim, 'GET', `/conversations/${c.id}/messages?limit=20`)).body.messages;
    const plan = msgs.find((m) => m.poll || m.event);
    const attempts = [
      ['GET', `/conversations/${c.id}`], ['GET', `/conversations/${c.id}/messages`], ['POST', `/conversations/${c.id}/messages`, { text: 'intrusion' }],
      ['POST', `/conversations/${c.id}/read`], ['POST', `/conversations/${c.id}/polls`, { question: 'x', options: ['a', 'b'] }],
      ['POST', `/conversations/${c.id}/events`, { title: 'x', startsAt: Date.now() + 864e5 }], ['PUT', `/conversations/${c.id}/lock`], ['PUT', `/conversations/${c.id}/disappearing`, { seconds: 60 }],
    ];
    if (msgs[0]) attempts.push(['DELETE', `/messages/${msgs[0].id}`], ['PUT', `/messages/${msgs[0].id}/star`, { starred: true }]);
    if (plan?.poll) attempts.push(['PUT', `/polls/${plan.id}/vote`, { options: [plan.poll.options[0].id] }], ['POST', `/polls/${plan.id}/close`]);
    if (plan?.event) attempts.push(['PUT', `/events/${plan.id}/rsvp`, { status: 'yes' }], ['PATCH', `/events/${plan.id}`, { title: 'hacked' }], ['POST', `/events/${plan.id}/cancel`]);
    for (const [m, p, b] of attempts) {
      tried += 1;
      const r = await call(attacker, m, p, b);
      if (r.status < 400 || r.status >= 500) bad.push(`${m} ${p} -> ${r.status}`);
    }
  }
  // stolen token reuse after logout and forged tokens
  const u = st.users[450];
  const t = u.token;
  const bogus = await call({ token: 'x'.repeat(48), ip: '1.1.1.1' }, 'GET', '/me');
  await call(u, 'POST', '/auth/logout');
  const after = await call({ token: t, ip: u.ip }, 'GET', '/me');
  console.log(JSON.stringify({ attempts: tried, unauthorizedSuccesses: bad.length, examples: bad.slice(0, 5), bogusTokenStatus: bogus.status, tokenAfterLogoutStatus: after.status }));
})();
