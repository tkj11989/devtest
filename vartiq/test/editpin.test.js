'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const make = async (name) => {
    const r = store.register(name, 'pass', name);
    const s = connect(base, { auth: { token: r.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((ok) => s.once('connect', ok));
    return { name, token: r.token, s };
  };
  const ann = await make('ann');
  const bob = await make('bob');
  const cat = await make('cat');
  const dm = store.getOrCreateDirect('ann', 'bob');
  const rest = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, ann, bob, cat, dm, rest };
}

test('edit: only the author, only text, within 15 minutes; the other side hears "edited"', async (t) => {
  const { store, ann, bob, dm } = await setup(t);
  const sent = (await call(ann.s, 'message:send', { convId: dm.id, text: 'helo' })).message;
  const heard = once(bob.s, 'message:edited');
  const res = await call(ann.s, 'message:edit', { id: sent.id, text: 'hello' });
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.message.text, 'hello');
  assert.ok(res.message.edited);
  assert.strictEqual((await heard).message.text, 'hello');
  assert.strictEqual((await call(bob.s, 'message:edit', { id: sent.id, text: 'mine now' })).code, 'forbidden');
  assert.strictEqual((await call(ann.s, 'message:edit', { id: sent.id, text: '  ' })).code, 'invalid_request');
  assert.strictEqual((await call(ann.s, 'message:edit', { id: sent.id, text: 'x', e2ee: { v: 1, w: {} } })).ok, false);
  // The window closes after 15 minutes.
  assert.throws(() => store.editMessage('ann', sent.id, { text: 'late' }, sent.ts + Store.EDIT_WINDOW_MS + 1), (e) => e.code === 'edit_window_closed');
  // Messages made of something other than text cannot be edited.
  const poll = (await call(ann.s, 'poll:send', { convId: dm.id, question: 'Q?', options: ['a', 'b'] }));
  if (poll.ok) assert.strictEqual((await call(ann.s, 'message:edit', { id: poll.message.id, text: 'x' })).code, 'conflict');
});

test('edit: an encrypted message needs a new envelope, and a count limit applies', async (t) => {
  const { store, ann, dm } = await setup(t);
  const enc = store.addMessage(dm.id, 'ann', '', { e2ee: { v: 1, w: {} } });
  assert.throws(() => store.editMessage('ann', enc.id, { text: 'plain' }), (e) => e.code === 'invalid_request');
  const plain = store.addMessage(dm.id, 'ann', 'one');
  for (let i = 0; i < Store.MAX_EDITS; i++) store.editMessage('ann', plain.id, { text: `v${i}` });
  assert.throws(() => store.editMessage('ann', plain.id, { text: 'again' }), (e) => e.code === 'conflict');
  void ann;
});

test('pin: up to three, either person in a chat, auto-unpinned when the message is deleted; REST too', async (t) => {
  const { store, ann, bob, cat, dm, rest } = await setup(t);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await call(ann.s, 'message:send', { convId: dm.id, text: `m${i}` })).message.id);
  const heard = once(bob.s, 'chat:pins');
  assert.ok((await call(ann.s, 'message:pin', { id: ids[0], pinned: true })).ok);
  assert.strictEqual((await heard).pins[0].id, ids[0]);
  assert.ok((await call(bob.s, 'message:pin', { id: ids[1], pinned: true })).ok);
  assert.ok((await call(ann.s, 'message:pin', { id: ids[2], pinned: true })).ok);
  assert.strictEqual((await call(ann.s, 'message:pin', { id: ids[3], pinned: true })).code, 'too_many_pins');
  assert.strictEqual((await call(cat.s, 'message:pin', { id: ids[3], pinned: true })).code, 'not_found');
  assert.strictEqual((await call(ann.s, 'message:pin', { id: ids[3], pinned: 'yes' })).code, 'invalid_request');

  const list = await rest(bob.token, 'GET', `/conversations/${dm.id}/pins`);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.body.messages.map((m) => m.text).sort(), ['m0', 'm1', 'm2']);

  assert.ok((await call(ann.s, 'message:delete', { id: ids[0] })).ok);
  assert.deepStrictEqual(store.getConversation(dm.id).pins.map((p) => p.id), [ids[1], ids[2]]);
  const un = await rest(ann.token, 'PUT', `/messages/${ids[1]}/pin`, { pinned: false });
  assert.strictEqual(un.status, 200);
  assert.deepStrictEqual(un.body.pins.map((p) => p.id), [ids[2]]);
  const ed = await rest(ann.token, 'PUT', `/messages/${ids[2]}`, { text: 'changed' });
  assert.strictEqual(ed.status, 200);
  assert.strictEqual(ed.body.message.text, 'changed');
});

test('pin: in a group only an admin can pin', async (t) => {
  const { store, ann, bob } = await setup(t);
  const g = store.createGroup('ann', 'Team', ['bob']);
  const m = (await call(bob.s, 'message:send', { convId: g.id, text: 'hi' })).message;
  assert.strictEqual((await call(bob.s, 'message:pin', { id: m.id, pinned: true })).code, 'forbidden');
  assert.ok((await call(ann.s, 'message:pin', { id: m.id, pinned: true })).ok);
});
