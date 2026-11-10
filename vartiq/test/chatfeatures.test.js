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
  const client = async (token) => {
    const s = connect(base, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r) => s.once('connect', r));
    return s;
  };
  const make = async (name) => { const r = store.register(name, 'pass', name); return { name, token: r.token, s: await client(r.token) }; };
  const ann = await make('ann');
  const bob = await make('bob');
  const eve = await make('eve');
  const dm = store.getOrCreateDirect('ann', 'bob');
  const rest = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, ann, bob, eve, dm, rest, make };
}

test('replies: the answer points at a message in the same chat, with a short quote when the server may read both', async (t) => {
  const { store, ann, bob, dm } = await setup(t);
  const first = (await call(ann.s, 'message:send', { convId: dm.id, text: 'Are we meeting today? '.repeat(10) })).message;
  const reply = await call(bob.s, 'message:send', { convId: dm.id, text: 'Yes!', replyTo: first.id });
  assert.ok(reply.ok, reply.error);
  assert.deepStrictEqual([reply.message.replyTo.id, reply.message.replyTo.from, reply.message.replyTo.kind], [first.id, 'ann', 'text']);
  assert.strictEqual(reply.message.replyTo.text.length, 120, 'a short quote');

  assert.strictEqual((await call(bob.s, 'message:send', { convId: dm.id, text: 'x', replyTo: 'nope' })).code, 'invalid_request');
  const other = store.getOrCreateDirect('ann', 'bob');
  void other;
  // A masked original is never quoted; an encrypted one has no quote (the app puts it inside its own encrypted message).
  const masked = (await call(ann.s, 'message:send', { convId: dm.id, text: 'secret', masked: true })).message;
  assert.strictEqual((await call(bob.s, 'message:send', { convId: dm.id, text: 'ok', replyTo: masked.id })).message.replyTo.text, undefined);
  const enc = store.addMessage(dm.id, 'ann', '', { e2ee: { v: 1, w: {} } });
  assert.strictEqual((await call(bob.s, 'message:send', { convId: dm.id, text: 'ok', replyTo: enc.id })).message.replyTo.text, undefined);

  // The original cannot be a deleted message, a message of another chat, a call or a system line.
  await call(ann.s, 'message:delete', { id: first.id });
  assert.strictEqual((await call(bob.s, 'message:send', { convId: dm.id, text: 'late', replyTo: first.id })).code, 'invalid_request');
  const elsewhere = store.getOrCreateDirect('ann', 'eve');
  const em = store.addMessage(elsewhere.id, 'ann', 'private to eve');
  assert.strictEqual((await call(bob.s, 'message:send', { convId: dm.id, text: 'sneaky', replyTo: em.id })).code, 'invalid_request');

  // Deleting a reply removes its quote.
  await call(bob.s, 'message:delete', { id: reply.message.id });
  assert.strictEqual(store.data.messages[dm.id].find((m) => m.id === reply.message.id).replyTo, undefined);
});

test('forwarded: a message is marked as sent on, and the mark goes when it is deleted', async (t) => {
  const { store, ann, dm } = await setup(t);
  const sent = (await call(ann.s, 'message:send', { convId: dm.id, text: 'Shared news', forwarded: true })).message;
  assert.strictEqual(sent.forwarded, true);
  assert.strictEqual((await call(ann.s, 'message:send', { convId: dm.id, text: 'Mine' })).message.forwarded, undefined);
  await call(ann.s, 'message:delete', { id: sent.id });
  assert.strictEqual(store.data.messages[dm.id].find((m) => m.id === sent.id).forwarded, undefined);
});

test('reactions: one emoji each, change it, take it back; everybody in the chat hears; outsiders cannot', async (t) => {
  const { store, ann, bob, eve, dm, rest } = await setup(t);
  const m = (await call(ann.s, 'message:send', { convId: dm.id, text: 'Good news' })).message;
  const heard = once(ann.s, 'message:reaction');
  const r1 = await call(bob.s, 'message:react', { id: m.id, emoji: '👍' });
  assert.deepStrictEqual(r1.message.reactions, { bob: '👍' });
  assert.deepStrictEqual(await heard, { convId: dm.id, id: m.id, reactions: { bob: '👍' } });
  await call(ann.s, 'message:react', { id: m.id, emoji: '❤️' });
  assert.deepStrictEqual((await call(bob.s, 'message:react', { id: m.id, emoji: '😂' })).message.reactions, { bob: '😂', ann: '❤️' }, 'bob changed his: still one each');
  assert.deepStrictEqual((await call(ann.s, 'message:react', { id: m.id, emoji: null })).message.reactions, { bob: '😂' });
  assert.strictEqual((await call(ann.s, 'message:react', { id: m.id, emoji: '💩' })).code, 'invalid_request', 'only the offered emoji');
  assert.strictEqual((await call(eve.s, 'message:react', { id: m.id, emoji: '👍' })).code, 'not_found', 'not in the chat');
  assert.strictEqual((await call(ann.s, 'message:react', { id: 'nope', emoji: '👍' })).code, 'not_found');

  // The last one taken back leaves no empty record; a deleted message keeps none.
  await call(bob.s, 'message:react', { id: m.id, emoji: null });
  assert.strictEqual(store.data.messages[dm.id].find((x) => x.id === m.id).reactions, undefined);
  await call(bob.s, 'message:react', { id: m.id, emoji: '🙏' });
  await call(ann.s, 'message:delete', { id: m.id });
  assert.strictEqual(store.data.messages[dm.id].find((x) => x.id === m.id).reactions, undefined);
  assert.strictEqual((await call(bob.s, 'message:react', { id: m.id, emoji: '👍' })).code, 'conflict', 'not on a deleted message');

  // Over HTTP, and the other person's block hides it from the blocked.
  const m2 = (await call(ann.s, 'message:send', { convId: dm.id, text: 'Second' })).message;
  const put = await rest(bob.token, 'PUT', `/messages/${m2.id}/reaction`, { emoji: '😮' });
  assert.deepStrictEqual([put.status, put.body.message.reactions], [200, { bob: '😮' }]);
  assert.strictEqual((await rest(bob.token, 'PUT', `/messages/${m2.id}/reaction`, { emoji: null })).body.message.reactions, undefined);
  void store;
});

test('search: every word, any capitals, any script; only what the server may read, never other people\'s chats', async (t) => {
  const { store, ann, bob, eve, dm, rest } = await setup(t);
  const m = (await call(ann.s, 'message:send', { convId: dm.id, text: 'Please send the Invoice for March' })).message;
  await call(bob.s, 'message:send', { convId: dm.id, text: 'नमस्ते, कल मिलते हैं' });
  await call(bob.s, 'message:send', { convId: dm.id, text: 'masked thing invoice', masked: true });
  store.addMessage(dm.id, 'ann', '', { e2ee: { v: 1, w: {} } }); // encrypted: the server cannot read it
  const elsewhere = store.getOrCreateDirect('eve', 'bob');
  store.addMessage(elsewhere.id, 'eve', 'invoice for April, private to eve and bob');

  const found = (await call(ann.s, 'messages:search', { q: 'INVOICE march' })).results;
  assert.deepStrictEqual(found.map((r) => [r.id, r.convId, r.from]), [[m.id, dm.id, 'ann']]);
  assert.match(found[0].snippet, /Invoice for March/);
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'invoice' })).results.length, 1, 'not the masked one, not eve and bob\'s chat');
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'invoice april' })).results.length, 0);
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'मिलते' })).results.length, 1, 'other scripts');
  assert.strictEqual((await call(eve.s, 'messages:search', { q: 'invoice' })).results[0].convId, elsewhere.id, 'eve only sees her own chat');

  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'a' })).code, 'invalid_request', 'too short');
  assert.strictEqual((await call(ann.s, 'messages:search', { q: '1 2 3 4 5 6 7 8 9' })).code, 'invalid_request');

  // Deleted messages, hidden chats and one-chat searches.
  const doomed = (await call(ann.s, 'message:send', { convId: dm.id, text: 'invoice to delete' })).message;
  await call(ann.s, 'message:delete', { id: doomed.id });
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'invoice' })).results.length, 1);
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'invoice', convId: dm.id })).results.length, 1);
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'invoice', convId: elsewhere.id })).code, 'not_found');
  store.data.users.ann.hiddenChats = [dm.id];
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'invoice' })).results.length, 0, 'a hidden chat is not searched');
  store.data.users.ann.hiddenChats = [];

  const viaRest = await rest(ann.token, 'GET', '/search/messages?q=invoice&limit=5');
  assert.deepStrictEqual([viaRest.status, viaRest.body.results.length, viaRest.body.words], [200, 1, ['invoice']]);
});

test('search: newest first, limited, and captions, document names and poll questions are searched too', async (t) => {
  const { store, ann, dm } = await setup(t);
  for (let i = 0; i < 40; i++) {
    const msg = store.addMessage(dm.id, 'ann', `report number ${i}`);
    msg.ts = 1_700_000_000_000 + i * 1000;
    store._touchMsg(dm.id, msg); // a change made by hand has to be noted, as the store's own methods do
  }
  const r = (await call(ann.s, 'messages:search', { q: 'report', limit: 10 })).results;
  assert.strictEqual(r.length, 10);
  assert.ok(r[0].ts > r[9].ts, 'newest first');
  assert.match(r[0].snippet, /report number 39/);

  store.addMessage(dm.id, 'ann', 'See attached', { media: { mediaId: 'x', kind: 'file', size: 10, mime: 'application/pdf', name: 'Quarterly-budget.pdf' } });
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'quarterly budget' })).results[0].kind, 'file');
  const poll = await call(ann.s, 'poll:send', { convId: dm.id, question: 'Where shall we eat dinner?', options: ['Pizza', 'Thai'] });
  assert.ok(poll.ok, poll.error);
  assert.strictEqual((await call(ann.s, 'messages:search', { q: 'eat dinner' })).results.length, 1);
});
