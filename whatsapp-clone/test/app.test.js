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
