'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

test('read receipts: only the sender of a message is told it was read (not every member of a big group)', async (t) => {
  const store = new Store({ file: null });
  const app = createApp({ store, otp: { sender: async () => {} } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const socks = [];
  t.after(() => { socks.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const users = {};
  for (const n of ['alice', 'bob', 'carol', 'dave']) users[n] = store.register(n, 'pass');
  const group = store.createGroup('alice', 'G', ['bob', 'carol', 'dave']);
  const seen = { alice: [], bob: [], carol: [], dave: [] };
  for (const n of Object.keys(users)) {
    const s = connect(base, { auth: { token: users[n].token, appSession: 'x' }, transports: ['websocket'], forceNew: true });
    socks.push(s);
    await new Promise((r) => s.once('connect', r));
    s.on('message:status', (e) => seen[n].push(...e.messages.map((m) => m.id)));
  }
  const a = store.addMessage(group.id, 'alice', 'from alice');
  const b = store.addMessage(group.id, 'bob', 'from bob');
  const res = await fetch(`${base}/api/v1/conversations/${group.id}/read`, { method: 'POST', headers: { Authorization: `Bearer ${users.carol.token}` } });
  assert.strictEqual(res.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(seen.alice, [a.id], 'alice is told about her own message only');
  assert.deepStrictEqual(seen.bob, [b.id], 'bob about his');
  assert.deepStrictEqual(seen.carol, [], 'the reader gets nothing');
  assert.deepStrictEqual(seen.dave, [], 'other members get nothing');
});
