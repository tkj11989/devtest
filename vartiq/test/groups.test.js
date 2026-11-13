'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

async function setup(t, names = ['ann', 'bob', 'cat', 'dee']) {
  const store = new Store({ file: null });
  const app = createApp({ store });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const u = {};
  for (const n of names) {
    const r = store.register(n, 'pass', n);
    const s = connect(base, { auth: { token: r.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((ok) => s.once('connect', ok));
    u[n] = { token: r.token, s };
  }
  const rest = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const group = (members = ['bob']) => store.createGroup('ann', 'Team', members);
  return { store, u, rest, group, base };
}

test('add people: admins only by default; new members see only what is sent after they join; everyone gets a notice', async (t) => {
  const { store, u, group } = await setup(t);
  const g = group(['bob']);
  store.addMessage(g.id, 'ann', 'old secret');
  assert.strictEqual((await call(u.bob.s, 'group:add', { convId: g.id, usernames: ['cat'] })).code, 'forbidden');
  const heardNew = once(u.cat.s, 'conversation:new');
  const heardUpd = once(u.bob.s, 'conversation:updated');
  const res = await call(u.ann.s, 'group:add', { convId: g.id, usernames: ['cat'] });
  assert.ok(res.ok, res.error);
  assert.deepStrictEqual(res.added, ['cat']);
  assert.ok((await heardNew).conversation.members.includes('cat'));
  assert.ok((await heardUpd).conversation.members.includes('cat'));
  const seen = (await call(u.cat.s, 'messages:get', { convId: g.id })).messages.map((m) => m.text || m.system?.event);
  assert.deepStrictEqual(seen, ['members_added'], 'no history');
  assert.ok(store.isMember(g.id, 'cat'));
  assert.strictEqual((await call(u.ann.s, 'group:add', { convId: g.id, usernames: ['cat'] })).code, 'invalid_request');
  // Everyone may add when the group says so.
  assert.ok((await call(u.ann.s, 'group:settings', { convId: g.id, addMembers: 'all' })).ok);
  assert.ok((await call(u.bob.s, 'group:add', { convId: g.id, usernames: ['dee'] })).ok);
  assert.strictEqual(store.getConversation(g.id).members.length, 4);
});

test('remove, leave, roles and handing over', async (t) => {
  const { store, u, group } = await setup(t);
  const g = group(['bob', 'cat']);
  assert.strictEqual((await call(u.bob.s, 'group:remove', { convId: g.id, username: 'cat' })).code, 'forbidden');
  const gone = once(u.cat.s, 'conversation:removed');
  assert.ok((await call(u.ann.s, 'group:remove', { convId: g.id, username: 'cat' })).ok);
  assert.strictEqual((await gone).convId, g.id);
  assert.strictEqual(store.isMember(g.id, 'cat'), false);
  assert.strictEqual((await call(u.cat.s, 'messages:get', { convId: g.id })).ok, false);
  assert.strictEqual((await call(u.ann.s, 'group:remove', { convId: g.id, username: 'ann' })).code, 'invalid_request');
  // Roles
  assert.ok((await call(u.ann.s, 'group:admin', { convId: g.id, username: 'bob', admin: true })).ok);
  assert.strictEqual((await call(u.bob.s, 'group:admin', { convId: g.id, username: 'ann', admin: false })).code, 'forbidden');
  assert.strictEqual((await call(u.bob.s, 'group:remove', { convId: g.id, username: 'ann' })).code, 'forbidden', 'the owner cannot be removed');
  assert.ok((await call(u.ann.s, 'group:admin', { convId: g.id, username: 'bob', admin: false })).ok);
  // Hand over, then the old owner leaves: the new owner stays; an empty group disappears.
  assert.ok((await call(u.ann.s, 'group:transfer', { convId: g.id, to: 'bob' })).ok);
  assert.strictEqual(store.getConversation(g.id).owner, 'bob');
  assert.ok((await call(u.ann.s, 'group:leave', { convId: g.id })).ok);
  assert.deepStrictEqual(store.getConversation(g.id).members, ['bob']);
  assert.ok((await call(u.bob.s, 'group:leave', { convId: g.id })).ok);
  assert.strictEqual(store.getConversation(g.id), null);
});

test('the owner leaving passes the group on to the oldest admin', async (t) => {
  const { store, u, group } = await setup(t);
  const g = group(['bob', 'cat']);
  await call(u.ann.s, 'group:admin', { convId: g.id, username: 'cat', admin: true });
  await call(u.ann.s, 'group:leave', { convId: g.id });
  const c = store.getConversation(g.id);
  assert.strictEqual(c.owner, 'cat');
  assert.ok(c.admins.includes('cat'));
});

test('settings: only admins write; only admins edit the info; description and rename show a notice', async (t) => {
  const { store, u, group } = await setup(t);
  const g = group(['bob']);
  assert.strictEqual((await call(u.bob.s, 'group:settings', { convId: g.id, sendMode: 'admins' })).code, 'forbidden');
  assert.ok((await call(u.ann.s, 'group:settings', { convId: g.id, sendMode: 'admins', editInfo: 'admins' })).ok);
  assert.strictEqual((await call(u.bob.s, 'message:send', { convId: g.id, text: 'hi' })).code, 'admins_only');
  assert.ok((await call(u.ann.s, 'message:send', { convId: g.id, text: 'announcement' })).ok);
  assert.strictEqual((await call(u.bob.s, 'group:edit', { convId: g.id, name: 'Mine' })).code, 'forbidden');
  const res = await call(u.ann.s, 'group:edit', { convId: g.id, name: 'Family', description: 'Weekend plans' });
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.conversation.name, 'Family');
  assert.strictEqual(res.conversation.description, 'Weekend plans');
  const events = store.data.messages[g.id].filter((m) => m.type === 'system').map((m) => m.system.event);
  assert.deepStrictEqual(events.filter((e) => e !== 'settings'), ['renamed', 'description']);
  assert.strictEqual((await call(u.ann.s, 'group:settings', { convId: g.id, sendMode: 'nobody' })).code, 'invalid_request');
  assert.ok((await call(u.ann.s, 'group:settings', { convId: g.id, sendMode: 'all' })).ok);
  assert.ok((await call(u.bob.s, 'message:send', { convId: g.id, text: 'hi again' })).ok);
});

test('invite link: join straight away, reset it, switch it off; only admins see the code', async (t) => {
  const { store, u, rest, group } = await setup(t);
  const g = group(['bob']);
  assert.strictEqual((await call(u.bob.s, 'group:invite', { convId: g.id })).code, 'forbidden');
  const link = await call(u.ann.s, 'group:invite', { convId: g.id });
  assert.ok(link.code && link.url.endsWith(`/join/${link.code}`));
  const view = await call(u.ann.s, 'conversations');
  assert.strictEqual(view.conversations.find((c) => c.id === g.id).inviteCode, link.code);
  assert.strictEqual((await call(u.bob.s, 'conversations')).conversations.find((c) => c.id === g.id).inviteCode, undefined);
  const info = await rest(u.cat.token, 'GET', `/groups/invite/${link.code}`);
  assert.deepStrictEqual([info.body.group.name, info.body.group.members], ['Team', 2]);
  const joined = await rest(u.cat.token, 'POST', '/groups/join', { code: link.code });
  assert.strictEqual(joined.body.status, 'joined');
  assert.ok(store.isMember(g.id, 'cat'));
  assert.strictEqual((await rest(u.cat.token, 'POST', '/groups/join', { code: link.code })).body.status, 'member');
  const fresh = await call(u.ann.s, 'group:invite', { convId: g.id, reset: true });
  assert.notStrictEqual(fresh.code, link.code);
  assert.strictEqual((await rest(u.dee.token, 'POST', '/groups/join', { code: link.code })).status, 404);
  await call(u.ann.s, 'group:invite', { convId: g.id, off: true });
  assert.strictEqual((await rest(u.dee.token, 'POST', '/groups/join', { code: fresh.code })).status, 404);
});

test('join requests: with approval an admin says yes or no', async (t) => {
  const { store, u, rest, group } = await setup(t);
  const g = group(['bob']);
  await call(u.ann.s, 'group:settings', { convId: g.id, approval: true });
  const { code } = await call(u.ann.s, 'group:invite', { convId: g.id });
  assert.strictEqual((await rest(u.cat.token, 'POST', '/groups/join', { code })).body.status, 'pending');
  assert.strictEqual((await rest(u.dee.token, 'POST', '/groups/join', { code })).body.status, 'pending');
  assert.strictEqual(store.isMember(g.id, 'cat'), false);
  const list = await rest(u.ann.token, 'GET', `/groups/${encodeURIComponent(g.id)}/requests`);
  assert.deepStrictEqual(list.body.requests.map((r) => r.username).sort(), ['cat', 'dee']);
  assert.strictEqual((await rest(u.bob.token, 'GET', `/groups/${encodeURIComponent(g.id)}/requests`)).status, 403);
  const got = once(u.cat.s, 'conversation:new');
  assert.strictEqual((await rest(u.ann.token, 'POST', `/groups/${encodeURIComponent(g.id)}/requests/cat`, { approve: true })).body.approved, true);
  assert.ok((await got).conversation.id === g.id);
  assert.strictEqual((await rest(u.ann.token, 'POST', `/groups/${encodeURIComponent(g.id)}/requests/dee`, { approve: false })).body.approved, false);
  assert.strictEqual(store.isMember(g.id, 'dee'), false);
  assert.strictEqual(store.getConversation(g.id).requests, undefined);
});

test('REST: change a group, add and remove people, make an admin, leave', async (t) => {
  const { store, u, rest, group } = await setup(t);
  const g = group(['bob']);
  const id = encodeURIComponent(g.id);
  assert.strictEqual((await rest(u.ann.token, 'PATCH', `/groups/${id}`, { name: 'New name', sendMode: 'admins' })).status, 200);
  assert.strictEqual(store.getConversation(g.id).name, 'New name');
  assert.strictEqual((await rest(u.ann.token, 'PATCH', `/groups/${id}`, {})).status, 400);
  assert.strictEqual((await rest(u.ann.token, 'POST', `/groups/${id}/members`, { usernames: ['cat'] })).status, 201);
  assert.strictEqual((await rest(u.ann.token, 'PUT', `/groups/${id}/members/cat/admin`, { admin: true })).status, 200);
  assert.strictEqual((await rest(u.ann.token, 'DELETE', `/groups/${id}/members/bob`)).status, 200);
  assert.strictEqual((await rest(u.cat.token, 'POST', `/groups/${id}/leave`)).status, 200);
  assert.deepStrictEqual(store.getConversation(g.id).members, ['ann']);
  assert.strictEqual((await rest(u.dee.token, 'PATCH', `/groups/${id}`, { name: 'x' })).status, 404);
});

test('communities: an announcements group, linked groups members join themselves, leaving takes you out of all of them', async (t) => {
  const { store, u, rest } = await setup(t);
  const made = await call(u.ann.s, 'community:create', { name: 'Green Park', description: 'Our society' });
  assert.ok(made.ok, made.error);
  const com = made.community;
  const announce = store.getConversation(com.announceId);
  assert.deepStrictEqual([announce.sendMode, announce.communityId, announce.members], ['admins', com.id, ['ann']]);

  // Add people: they are in the announcements group, which only admins can write to.
  const heard = once(u.bob.s, 'conversation:new');
  assert.ok((await call(u.ann.s, 'community:add', { id: com.id, usernames: ['bob', 'cat'] })).ok);
  assert.strictEqual((await heard).conversation.id, com.announceId);
  assert.strictEqual((await call(u.bob.s, 'message:send', { convId: com.announceId, text: 'hi' })).code, 'admins_only');
  assert.ok((await call(u.ann.s, 'message:send', { convId: com.announceId, text: 'Water cut tomorrow' })).ok);
  assert.strictEqual((await call(u.bob.s, 'community:add', { id: com.id, usernames: ['dee'] })).code, 'forbidden');
  assert.strictEqual((await call(u.bob.s, 'group:leave', { convId: com.announceId })).code, 'invalid_request');

  // A group in the community: members join it themselves; outsiders cannot.
  const grp = await call(u.ann.s, 'community:group', { id: com.id, create: { name: 'Parking' } });
  assert.ok(grp.ok, grp.error);
  const gid = grp.conversation.id;
  assert.strictEqual(store.getConversation(gid).communityId, com.id);
  assert.strictEqual((await call(u.dee.s, 'community:join-group', { id: com.id, convId: gid })).code, 'not_found');
  assert.ok((await call(u.bob.s, 'community:join-group', { id: com.id, convId: gid })).ok);
  assert.ok(store.isMember(gid, 'bob'));
  assert.strictEqual((await call(u.ann.s, 'group:add', { convId: gid, usernames: ['dee'] })).code, 'invalid_request', 'dee must join the community first');
  const view = (await call(u.bob.s, 'community:get', { id: com.id })).community;
  assert.deepStrictEqual(view.groups.map((g) => [g.name, g.joined]), [['Parking', true]]);
  assert.strictEqual(view.inviteCode, undefined);

  // Link an existing group of mine: its members become community members.
  const mine = store.createGroup('ann', 'Cricket', ['dee']);
  assert.ok((await call(u.ann.s, 'community:group', { id: com.id, link: mine.id })).ok);
  assert.ok(store.data.communities[com.id].members.includes('dee'));
  assert.ok(store.isMember(com.announceId, 'dee'));
  assert.strictEqual((await call(u.bob.s, 'community:group', { id: com.id, link: mine.id })).code, 'forbidden');

  // Roles and removal.
  assert.ok((await call(u.ann.s, 'community:admin', { id: com.id, username: 'bob', admin: true })).ok);
  assert.ok(store.getConversation(com.announceId).admins.includes('bob'), 'community admins write in Announcements');
  assert.ok((await call(u.bob.s, 'message:send', { convId: com.announceId, text: 'from bob' })).ok);
  const gone = once(u.dee.s, 'community:removed');
  assert.ok((await call(u.ann.s, 'community:remove', { id: com.id, username: 'dee' })).ok);
  assert.strictEqual((await gone).id, com.id);
  assert.strictEqual(store.isMember(mine.id, 'dee'), false);
  assert.strictEqual(store.isMember(com.announceId, 'dee'), false);

  // Leaving takes bob out of everything; the last person leaving ends the community and frees its groups.
  assert.ok((await call(u.bob.s, 'community:leave', { id: com.id })).ok);
  assert.strictEqual(store.isMember(gid, 'bob'), false);
  assert.strictEqual(store.isMember(com.announceId, 'bob'), false);
  assert.ok((await call(u.cat.s, 'community:leave', { id: com.id })).ok);
  assert.strictEqual((await call(u.ann.s, 'community:leave', { id: com.id })).ok, true);
  assert.strictEqual(store.data.communities[com.id], undefined);
  assert.strictEqual(store.getConversation(mine.id)?.communityId, undefined);
  void rest;
});

test('communities: invite link, owner hand-over when the owner leaves, REST', async (t) => {
  const { store, u, rest } = await setup(t);
  const { community: com } = await call(u.ann.s, 'community:create', { name: 'Club' });
  await call(u.ann.s, 'community:add', { id: com.id, usernames: ['bob'] });
  await call(u.ann.s, 'community:admin', { id: com.id, username: 'bob', admin: true });
  const link = await rest(u.ann.token, 'POST', `/communities/${encodeURIComponent(com.id)}/invite`, {});
  assert.strictEqual(link.status, 200);
  const info = await rest(u.cat.token, 'GET', `/groups/invite/${link.body.code}`);
  assert.strictEqual(info.body.group.kind, 'community');
  const joined = await rest(u.cat.token, 'POST', '/groups/join', { code: link.body.code });
  assert.strictEqual(joined.body.status, 'joined');
  assert.ok(store.data.communities[com.id].members.includes('cat'));
  const list = await rest(u.cat.token, 'GET', '/communities');
  assert.deepStrictEqual(list.body.communities.map((c) => c.name), ['Club']);
  assert.strictEqual((await rest(u.dee.token, 'GET', `/communities/${encodeURIComponent(com.id)}`)).status, 404);
  assert.strictEqual((await rest(u.ann.token, 'PATCH', `/communities/${encodeURIComponent(com.id)}`, { name: 'Club 2' })).body.community.name, 'Club 2');
  await call(u.ann.s, 'community:leave', { id: com.id });
  const c = store.data.communities[com.id];
  assert.strictEqual(c.owner, 'bob');
  assert.ok(store.getConversation(c.announceId).admins.includes('bob'));
});
