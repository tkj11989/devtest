'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

test('store: register, login and reject bad credentials', () => {
  const store = new Store({ file: null });
  const { token, user } = store.register('Alice', 'secret', 'Alice A');
  assert.ok(token);
  assert.strictEqual(user.username, 'alice');
  assert.strictEqual(store.userForToken(token), 'alice');
  assert.throws(() => store.register('alice', 'xxxx'), /taken/);
  assert.throws(() => store.login('alice', 'wrong'), /Invalid/);
  assert.ok(store.login('ALICE', 'secret').token);
});

test('store: direct chat, read receipts and groups', () => {
  const store = new Store({ file: null });
  store.register('alice', 'pass');
  store.register('bob', 'pass');
  store.register('carol', 'pass');

  const dm = store.getOrCreateDirect('alice', 'bob');
  assert.strictEqual(dm.id, store.getOrCreateDirect('bob', 'alice').id);

  const msg = store.addMessage(dm.id, 'alice', 'hi bob');
  assert.strictEqual(store.conversationsFor('bob')[0].unread, 1);
  assert.throws(() => store.addMessage(dm.id, 'carol', 'intrude'), /Not a member/);

  store.markRead(dm.id, 'bob');
  assert.deepStrictEqual(msg.readBy, ['bob']);
  assert.deepStrictEqual(msg.deliveredTo, ['bob']);
  assert.strictEqual(store.conversationsFor('bob')[0].unread, 0);

  const grp = store.createGroup('alice', 'Friends', ['bob', 'carol']);
  assert.deepStrictEqual(grp.members.sort(), ['alice', 'bob', 'carol']);
  assert.throws(() => store.createGroup('alice', 'Solo', []), /at least one/);
});

test('realtime: messages, delivery/read status and typing between two clients', async (t) => {
  const store = new Store({ file: null });
  const { server, io } = createApp({ store });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  t.after(() => { io.close(); server.close(); });

  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');

  const client = (token) => new Promise((resolve, reject) => {
    const s = connect(url, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
  const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
  const next = (s, ev) => new Promise((r) => s.once(ev, r));

  await assert.rejects(client('bad-token'), /unauthorized/);

  const a = await client(alice.token);
  const b = await client(bob.token);
  t.after(() => { a.close(); b.close(); });

  const { conversation } = await call(a, 'chat:direct', { username: 'bob' });

  const typing = next(b, 'typing');
  a.emit('typing', { convId: conversation.id, isTyping: true });
  assert.deepStrictEqual(await typing, { convId: conversation.id, username: 'alice', isTyping: true });

  const newConv = next(b, 'conversation:new');
  const incoming = next(b, 'message:new');
  const sent = await call(a, 'message:send', { convId: conversation.id, text: 'Hello Bob!' });
  assert.ok(sent.ok);
  assert.strictEqual((await newConv).conversation.id, conversation.id);
  const { message } = await incoming;
  assert.strictEqual(message.text, 'Hello Bob!');
  assert.deepStrictEqual(message.deliveredTo, ['bob'], 'online recipient gets it delivered');

  const status = next(a, 'message:status');
  await call(b, 'messages:read', { convId: conversation.id });
  const { messages } = await status;
  assert.deepStrictEqual(messages[0].readBy, ['bob']);

  const { conversations } = await call(b, 'conversations');
  assert.strictEqual(conversations.length, 1);
  assert.strictEqual(conversations[0].unread, 0);

  const err = await call(a, 'message:send', { convId: 'dm:x:y', text: 'nope' });
  assert.strictEqual(err.ok, false);
});

test('store: masked messages and duplicate-safe retries via clientId', () => {
  const store = new Store({ file: null });
  store.register('alice', 'pass');
  store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');

  const m1 = store.addMessage(dm.id, 'alice', 'secret', { masked: true, clientId: 'c-1' });
  assert.strictEqual(m1.masked, true);
  assert.strictEqual(m1.clientId, 'c-1');
  // Same clientId again (a retry): no duplicate, same message back.
  assert.strictEqual(store.addMessage(dm.id, 'alice', 'secret', { masked: true, clientId: 'c-1' }), m1);
  // Another sender may coincidentally use the same clientId.
  assert.notStrictEqual(store.addMessage(dm.id, 'bob', 'hi', { clientId: 'c-1' }).id, m1.id);
  assert.strictEqual(store.data.messages[dm.id].length, 2);
  assert.strictEqual(store.addMessage(dm.id, 'alice', 'plain').masked, undefined);
});

test('realtime: a retried send is acknowledged without a second broadcast', async (t) => {
  const store = new Store({ file: null });
  const { server, io } = createApp({ store });
  await new Promise((r) => server.listen(0, r));
  t.after(() => { io.close(); server.close(); });
  const { token } = store.register('alice', 'pass');
  store.register('bob', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');

  const a = connect(`http://localhost:${server.address().port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
  t.after(() => a.close());
  await new Promise((r) => a.once('connect', r));
  let broadcasts = 0;
  a.on('message:new', () => broadcasts++);
  const send = () => new Promise((r) => a.emit('message:send', { convId: dm.id, text: 'hey', masked: true, clientId: 'c-9' }, r));

  const first = await send();
  const second = await send();
  assert.ok(first.ok && second.ok);
  assert.strictEqual(first.message.id, second.message.id);
  assert.strictEqual(first.message.masked, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(broadcasts, 1);
});
