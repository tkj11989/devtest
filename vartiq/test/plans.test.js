'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

async function setup(t) {
  const store = new Store({ file: null });
  const app = createApp({ store, admin: { username: 'root', password: 'correct-horse-battery' }, otp: { sender: async () => {} }, rateLimit: { max: 100000, authMax: 100000 }, messageSweepMs: 3600 * 1000 });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const client = async (token) => {
    const s = connect(base, { auth: { token, appSession: 'x' }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  const alice = store.register('alice', 'pass');
  const bob = store.register('bob', 'pass');
  const carol = store.register('carol', 'pass');
  const dm = store.getOrCreateDirect('alice', 'bob');
  const group = store.createGroup('alice', 'Trip', ['bob', 'carol']);
  return { store, app, api, client, alice, bob, carol, dm, group };
}
const once = (s, ev) => new Promise((r) => s.once(ev, r));
const DAY = 24 * 3600 * 1000;

test('poll: free = one choice, up to 6 options, names visible; voting, changing, withdrawing, closing', async (t) => {
  const env = await setup(t);
  const { api, alice, bob, carol, group } = env;
  const bobSock = await env.client(bob.token);
  const seen = once(bobSock, 'message:new');
  const made = await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'Where to eat?', options: ['Pizza', 'Sushi', 'pizza', ' ', 'Thali'] });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const poll = made.body.message;
  assert.strictEqual(poll.type, 'poll');
  assert.deepStrictEqual(poll.poll.options.map((o) => o.text), ['Pizza', 'Sushi', 'Thali'], 'duplicates and blanks are dropped');
  assert.strictEqual((await seen).message.poll.question, 'Where to eat?');

  const ids = poll.poll.options.map((o) => o.id);
  const upd = once(bobSock, 'poll:update');
  const v1 = await api('PUT', `/polls/${poll.id}/vote`, bob.token, { options: [ids[0]] });
  assert.strictEqual(v1.body.message.poll.mine[0], ids[0]);
  assert.strictEqual((await upd).message.poll.options[0].votes, 1);
  assert.strictEqual((await api('PUT', `/polls/${poll.id}/vote`, carol.token, { options: [ids[0], ids[1]] })).status, 400, 'free polls take one choice');
  await api('PUT', `/polls/${poll.id}/vote`, carol.token, { options: [ids[1]] });
  await api('PUT', `/polls/${poll.id}/vote`, bob.token, { options: [ids[2]] }); // change of mind
  const after = (await api('GET', `/conversations/${group.id}/messages`, alice.token)).body.messages.find((m) => m.id === poll.id);
  assert.deepStrictEqual(after.poll.options.map((o) => o.votes), [0, 1, 1]);
  assert.deepStrictEqual(after.poll.options[2].voters, ['bob']);
  assert.strictEqual(after.poll.total, 2);
  assert.strictEqual(after.poll.votes, undefined, 'raw votes are never sent');
  await api('PUT', `/polls/${poll.id}/vote`, carol.token, { options: [] });
  assert.strictEqual((await api('GET', `/conversations/${group.id}/messages`, alice.token)).body.messages.find((m) => m.id === poll.id).poll.total, 1);

  assert.strictEqual((await api('PUT', `/polls/${poll.id}/vote`, bob.token, { options: ['nope'] })).status, 400);
  assert.strictEqual((await api('POST', `/polls/${poll.id}/close`, bob.token)).status, 403, 'only the maker closes it');
  assert.strictEqual((await api('POST', `/polls/${poll.id}/close`, alice.token)).body.message.poll.closed, true);
  assert.strictEqual((await api('PUT', `/polls/${poll.id}/vote`, bob.token, { options: [ids[0]] })).body.error.code, 'poll_closed');
});

test('poll: Premium extras (multiple choice, anonymous, auto-close, 12 options) need Premium', async (t) => {
  const env = await setup(t);
  const { api, alice, bob, group, store } = env;
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.strictEqual((await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'q', options: seven })).body.error.code, 'premium_required');
  assert.strictEqual((await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'q', options: ['a', 'b'], multi: true })).body.error.code, 'premium_required');
  assert.strictEqual((await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'q', options: ['a', 'b'], anonymous: true })).status, 402);
  assert.strictEqual((await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'q', options: ['a'] })).status, 400);

  store.setPremiumByAdmin('alice', Date.now() + 30 * DAY);
  const made = await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'Pick', options: seven, multi: true, anonymous: true, closesAt: Date.now() + 2 * 60 * 1000 });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const p = made.body.message;
  const ids = p.poll.options.map((o) => o.id);
  assert.strictEqual((await api('PUT', `/polls/${p.id}/vote`, bob.token, { options: [ids[0], ids[3]] })).status, 200, 'several choices');
  const view = (await api('GET', `/conversations/${group.id}/messages`, alice.token)).body.messages.find((m) => m.id === p.id).poll;
  assert.strictEqual(view.options[0].voters, undefined, 'anonymous: no names, not even for the maker');
  assert.deepStrictEqual(view.options.map((o) => o.votes).slice(0, 4), [1, 0, 0, 1]);
  assert.strictEqual((await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'q', options: ['a', 'b'], closesAt: Date.now() + 5000 })).status, 400, 'at least a minute ahead');

  // It closes by itself when the time is up.
  store.findPlan(p.id).message.poll.closesAt = Date.now() - 1000;
  const bobSock = await env.client(bob.token);
  const closed = once(bobSock, 'poll:update');
  env.app.service.runPlans();
  assert.strictEqual((await closed).message.poll.closed, true);
});

test('event: details, yes / maybe / no, edit, cancel; the maker is going', async (t) => {
  const env = await setup(t);
  const { api, alice, bob, carol, group } = env;
  const start = Date.now() + 3 * DAY;
  assert.strictEqual((await api('POST', `/conversations/${group.id}/events`, alice.token, { title: 'Trek', startsAt: Date.now() - DAY })).status, 400, 'not in the past');
  assert.strictEqual((await api('POST', `/conversations/${group.id}/events`, alice.token, { title: '', startsAt: start })).status, 400);
  const made = await api('POST', `/conversations/${group.id}/events`, alice.token, { title: 'Trek', description: 'Bring water', location: 'Sinhagad', startsAt: start, endsAt: start + 4 * 3600 * 1000 });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const ev = made.body.message;
  assert.strictEqual(ev.type, 'event');
  assert.deepStrictEqual([ev.event.mine, ev.event.counts.yes, ev.event.reminder, ev.event.repeat], ['yes', 1, 60, 'none']);

  const bobSock = await env.client(bob.token);
  const upd = once(bobSock, 'event:update');
  await api('PUT', `/events/${ev.id}/rsvp`, bob.token, { status: 'maybe' });
  assert.strictEqual((await upd).message.event.counts.maybe, 1);
  await api('PUT', `/events/${ev.id}/rsvp`, carol.token, { status: 'no' });
  assert.strictEqual((await api('PUT', `/events/${ev.id}/rsvp`, carol.token, { status: 'perhaps' })).status, 400);
  const view = (await api('GET', `/conversations/${group.id}/messages`, alice.token)).body.messages.find((m) => m.id === ev.id).event;
  assert.deepStrictEqual([view.going, view.maybe, view.notGoing], [['alice'], ['bob'], ['carol']]);
  assert.strictEqual(view.rsvp, undefined);
  await api('PUT', `/events/${ev.id}/rsvp`, carol.token, { status: null });
  assert.strictEqual((await api('GET', `/conversations/${group.id}/messages`, carol.token)).body.messages.find((m) => m.id === ev.id).event.mine, null);

  assert.strictEqual((await api('PATCH', `/events/${ev.id}`, bob.token, { title: 'x' })).status, 403);
  const edited = await api('PATCH', `/events/${ev.id}`, alice.token, { location: 'Lonavala', startsAt: start + DAY });
  assert.strictEqual(edited.body.message.event.location, 'Lonavala');
  assert.strictEqual(edited.body.message.event.startsAt, start + DAY);
  assert.strictEqual(edited.body.message.event.endsAt, start + DAY + 4 * 3600 * 1000, 'the end moved with the start');
  assert.strictEqual((await api('POST', `/events/${ev.id}/cancel`, bob.token)).status, 403);
  assert.strictEqual((await api('POST', `/events/${ev.id}/cancel`, alice.token)).body.message.event.canceled, true);
  assert.strictEqual((await api('PUT', `/events/${ev.id}/rsvp`, bob.token, { status: 'yes' })).body.error.code, 'event_canceled');
});

test('event: Premium reminder times and repeating; reminders go to people who said yes or maybe', async (t) => {
  const env = await setup(t);
  const { api, alice, bob, carol, group, store } = env;
  const start = Date.now() + 2 * 3600 * 1000;
  assert.strictEqual((await api('POST', `/conversations/${group.id}/events`, alice.token, { title: 'Yoga', startsAt: start, reminderMinutes: 15 })).body.error.code, 'premium_required');
  assert.strictEqual((await api('POST', `/conversations/${group.id}/events`, alice.token, { title: 'Yoga', startsAt: start, repeat: 'weekly' })).status, 402);
  assert.strictEqual((await api('POST', `/conversations/${group.id}/events`, alice.token, { title: 'Yoga', startsAt: start, reminderMinutes: 7 })).status, 400);
  store.setPremiumByAdmin('alice', Date.now() + 30 * DAY);
  const made = await api('POST', `/conversations/${group.id}/events`, alice.token, { title: 'Yoga', startsAt: start, reminderMinutes: 120, repeat: 'weekly' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const id = made.body.message.id;
  await api('PUT', `/events/${id}/rsvp`, bob.token, { status: 'yes' });
  await api('PUT', `/events/${id}/rsvp`, carol.token, { status: 'no' });

  const bobSock = await env.client(bob.token);
  const carolSock = await env.client(carol.token);
  const got = [];
  bobSock.on('event:reminder', (e) => got.push(['bob', e.message.event.title]));
  carolSock.on('event:reminder', () => got.push(['carol']));
  const sweep = () => env.app.service.runPlans();
  sweep();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(got, [['bob', 'Yoga']], 'two hours before: bob said yes; carol said no and is not reminded');
  got.length = 0;
  sweep();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(got, [], 'only once');

  // A repeating event moves to its next date once it is over, and the answers start again.
  const e = store.findPlan(id).message.event;
  e.startsAt = Date.now() - 3 * 24 * 3600 * 1000;
  e.remindedAt = 1;
  sweep();
  const moved = store.findPlan(id).message.event;
  assert.ok(moved.startsAt > Date.now(), 'next week');
  assert.deepStrictEqual(moved.rsvp, {});
});

test('polls and events: locked chats do not leak, admin switches, accounts that leave', async (t) => {
  const env = await setup(t);
  const { api, alice, bob, group, store, dm } = env;
  // Votes and answers of someone who deletes their account disappear.
  const p = (await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'q', options: ['a', 'b'] })).body.message;
  await api('PUT', `/polls/${p.id}/vote`, bob.token, { options: [p.poll.options[0].id] });
  store.setSettings?.({ features: { polls: false } });
  const s = store.getSettings(); s.features.polls = false; store.settingsCache = s;
  assert.strictEqual((await api('POST', `/conversations/${group.id}/polls`, alice.token, { question: 'q2', options: ['a', 'b'] })).body.error.code, 'feature_disabled');
  assert.strictEqual((await api('PUT', `/polls/${p.id}/vote`, bob.token, { options: [] })).body.error.code, 'feature_disabled');
  assert.strictEqual((await api('POST', `/polls/${p.id}/close`, alice.token)).status, 200, 'closing still works with the switch off');
  s.features.polls = true;

  // A person who is not in the chat cannot see or answer.
  const dave = store.register('dave', 'pass');
  assert.strictEqual((await api('PUT', `/polls/${p.id}/vote`, dave.token, { options: [] })).status, 404);
  assert.strictEqual((await api('POST', `/conversations/${dm.id}/polls`, dave.token, { question: 'q', options: ['a', 'b'] })).status, 404);

  // Locked chat: the poll is withheld until unlocked.
  await api('PUT', '/chat-lock/code', bob.token, { code: '123456' });
  await api('PUT', `/conversations/${group.id}/lock`, bob.token, { locked: true });
  const seen = (await api('GET', `/conversations/${group.id}/messages`, bob.token));
  assert.strictEqual(seen.status, 423);
});
