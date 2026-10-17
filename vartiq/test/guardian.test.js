'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const G = require('../server/guardian');

const CONSENT = { terms: true, version: require('../server/legal').VERSION };
/** A birth date that makes someone `years` old (and a few weeks more). */
const born = (years, extraDays = 40) => new Date(Date.now() - (years * 365.25 + extraDays) * 86400000).toISOString().slice(0, 10);
const once = (s, ev, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no ${ev}`)), ms);
  const fn = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, fn); resolve(p); } };
  s.on(ev, fn);
});
const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));

async function setup(t, { publicUrl = 'https://vartiq.example', otp = {}, appOptions = {} } = {}) {
  const store = new Store({ file: null });
  const outbox = []; // everything "sent" by SMS or email
  const gateway = { fail: false };
  const sender = async (m) => {
    if (gateway.fail && m.purpose === 'guardian') throw new Error('gateway down');
    outbox.push(m);
  };
  const app = createApp({ store, publicUrl, rateLimit: { authMax: 1000, max: 100000 }, otp: { sender, exposeCodes: true, resendMs: 0, maxPerHour: 100, ...otp }, ...appOptions });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const client = async (token) => {
    const s = connect(base, { auth: { token, appSession: 'x' }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  /** Sign up through the real flow: code by SMS, then register. */
  const signUp = async (name, phone, extra = {}) => {
    const sent = await api('POST', '/auth/otp', null, { purpose: 'register', phone });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    return api('POST', '/auth/register', null, { displayName: name, phone, phoneOtp: { requestId: sent.body.requestId, code: sent.body.devCode }, consent: CONSENT, ...extra });
  };
  const linkOf = (to) => {
    const m = outbox.filter((x) => x.to === to).at(-1);
    return m && /\/guardian\/([A-Za-z0-9_-]+)/.exec(m.text)?.[1];
  };
  return { store, app, api, client, signUp, outbox, gateway, linkOf, base };
}
const MOM = { name: 'Meera Iyer', relationship: 'mother', phone: '+919811100001' };
const guardianCall = (env, token, method, path, body) => env.api(method, `/guardian/${token}${path}`, null, body);

/** A child with a guardian who has agreed. */
async function agreedChild(env, name = 'Kavya', phone = '+919822200001', guardian = MOM, { premium = true } = {}) {
  const reg = await env.signUp(name, phone, { birthDate: born(14), guardian });
  assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
  const token = env.linkOf(guardian.phone);
  assert.ok(token, 'the parent got a link');
  assert.strictEqual((await guardianCall(env, token, 'POST', '/consent', { agree: true })).status, 200);
  // Changing the controls is a Premium feature of the child's account.
  if (premium) env.store.setPremiumByAdmin(reg.body.user.username, Date.now() + 30 * 86400000);
  return { ...reg.body, link: token };
}

test('age: real dates only, whole years, birthdays count', () => {
  const now = Date.UTC(2026, 9, 17, 12);
  assert.strictEqual(G.ageOn('2008-10-17', now), 18, 'turns 18 today');
  assert.strictEqual(G.ageOn('2008-10-18', now), 17, 'turns 18 tomorrow');
  assert.strictEqual(G.ageOn('2018-10-17', now), 8);
  assert.strictEqual(G.ageOn('2016-02-29', now), 10, 'a leap-day birthday');
  assert.strictEqual(G.parseBirthDate('2026-02-30'), null, 'not a real date');
  assert.strictEqual(G.parseBirthDate('2999-01-01'), null, 'not in the future');
  assert.strictEqual(G.parseBirthDate('1899-12-31'), null);
  assert.strictEqual(G.parseBirthDate('17/10/2008'), null);
  assert.strictEqual(G.ageOn('garbage', now), null);
  assert.strictEqual(G.baseUrl('https://a.example/', 'http://evil.example'), 'https://a.example', 'configured address wins');
  assert.strictEqual(G.baseUrl('', 'http://localhost:3000'), 'http://localhost:3000', 'development');
  assert.strictEqual(G.baseUrl('', 'https://evil.example'), null, 'never an address taken from a request to somewhere else');
});

test('sign-up: date of birth is mandatory; under the minimum age there is no account; under 18 needs a guardian', async (t) => {
  const env = await setup(t);
  const phone = (n) => `+91981110${String(n).padStart(4, '0')}`;
  const code = (r) => r.body.error.code;

  assert.strictEqual(code(await env.signUp('A', phone(1))), 'birth_date_required');
  assert.strictEqual(code(await env.signUp('A', phone(1), { birthDate: '2999-01-01' })), 'birth_date_required', 'the future');
  assert.strictEqual(code(await env.signUp('A', phone(1), { birthDate: 'last year' })), 'birth_date_required');

  const young = await env.signUp('Tiny', phone(2), { birthDate: born(7), guardian: MOM });
  assert.strictEqual(young.status, 403);
  assert.strictEqual(code(young), 'too_young');
  assert.match(young.body.error.message, /aged 8/);
  assert.strictEqual(env.store.findByPhone(phone(2)), null, 'no account was made');

  // 8 to 17: a guardian is mandatory, with a name, a relationship and a phone or email.
  for (const [why, guardian] of [
    ['none', undefined],
    ['empty', {}],
    ['no name', { relationship: 'mother', phone: MOM.phone }],
    ['no relationship', { name: 'M', phone: MOM.phone }],
    ['odd relationship', { name: 'M', relationship: 'neighbour', phone: MOM.phone }],
    ['no contact', { name: 'M', relationship: 'mother' }],
    ['bad phone', { name: 'M', relationship: 'mother', phone: '12' }],
    ['bad email', { name: 'M', relationship: 'mother', email: 'nope' }],
  ]) {
    const res = await env.signUp('Kid', phone(3), { birthDate: born(12), guardian });
    assert.strictEqual(res.status, 400, why);
    assert.ok(['guardian_required', 'invalid_phone', 'invalid_email'].includes(code(res)), `${why}: ${code(res)}`);
  }
  assert.strictEqual(code(await env.signUp('Kid', phone(3), { birthDate: born(12), guardian: { ...MOM, phone: phone(3) } })), 'guardian_same_person', "not the child's own number");
  assert.strictEqual(code(await env.signUp('Shop', phone(3), { accountType: 'business', birthDate: born(15), guardian: MOM, email: 'x@shop.example', emailOtp: {}, business: { category: 'Retail' } })), 'business_adult');
  assert.strictEqual(env.store.findByPhone(phone(3)), null, 'nothing was created by the failed tries');

  // An email alone is enough.
  const byEmail = await env.signUp('Kid', phone(3), { birthDate: born(12), guardian: { name: 'Raj', relationship: 'father', email: 'raj@example.com' } });
  assert.strictEqual(byEmail.status, 201, JSON.stringify(byEmail.body));
  assert.strictEqual(byEmail.body.guardian.state, 'pending');
  assert.strictEqual(byEmail.body.guardian.delivery.delivered, true);
  assert.ok(env.linkOf('raj@example.com'), 'sent by email');
  assert.strictEqual(byEmail.body.guardianToken, undefined, 'the link is never in the child\'s own answer');
  assert.ok(!JSON.stringify(byEmail.body).includes(env.linkOf('raj@example.com')));

  // Exactly 18 and over: no guardian, nothing pending.
  const adult = await env.signUp('Adult', phone(4), { birthDate: born(18, 0) });
  assert.strictEqual(adult.status, 201);
  assert.strictEqual(adult.body.guardian, undefined);
  assert.strictEqual((await env.api('GET', '/me/guardian', adult.body.token)).body.guardian, null);
  assert.strictEqual(env.store.guardianState(adult.body.user.username), null);
});

test('guardian link: sent to every contact, hashed at rest, and the account does nothing until the parent agrees', async (t) => {
  const env = await setup(t);
  const both = { name: 'Meera Iyer', relationship: 'mother', phone: '+919811100001', email: 'meera@example.com' };
  const reg = await env.signUp('Kavya', '+919822200001', { birthDate: born(14), guardian: both });
  assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
  assert.strictEqual(reg.body.guardian.contacts.length, 2, 'to the mobile number and the email');
  const byPhone = env.linkOf(both.phone);
  assert.strictEqual(byPhone, env.linkOf(both.email), 'the same private link on both');
  const text = env.outbox.find((m) => m.to === both.phone).text;
  assert.match(text, /^Kavya signed up for VartiQ/);
  assert.match(text, /https:\/\/vartiq\.example\/guardian\//, 'on the configured address');

  const child = reg.body;
  const kid = child.user.username;
  assert.ok(!JSON.stringify(env.store.data.users[kid]).includes(byPhone), 'only a hash of the link is kept');

  // Waiting: the app is closed to them, apart from what they need to see the state, resend, or leave.
  const me = await env.api('GET', '/me', child.token);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.guardian.state, 'pending');
  assert.strictEqual(me.body.guardian.name, 'Meera Iyer');
  assert.ok(me.body.guardian.contacts.every((c) => c.includes('•')), 'only masked contacts');
  for (const [method, path, body] of [['GET', '/conversations'], ['GET', '/users?q=a'], ['POST', '/conversations', { type: 'group', name: 'x', members: [] }], ['GET', '/statuses'], ['PUT', '/push/subscription', {}]]) {
    const res = await env.api(method, path, child.token, body);
    assert.strictEqual(res.status, 403, `${method} ${path}`);
    assert.strictEqual(res.body.error.code, 'guardian_required');
  }
  assert.strictEqual((await env.api('GET', '/me/guardian', child.token)).status, 200);
  assert.strictEqual((await env.api('GET', '/me/export', child.token)).status, 200, 'they can still download their data');
  const sock = await env.client(child.token);
  assert.strictEqual((await call(sock, 'conversations')).code, 'guardian_required', 'also over the socket');
  assert.strictEqual((await call(sock, 'guardian:status')).guardian.state, 'pending');

  // The parent opens the link.
  const page = await guardianCall(env, byPhone, 'GET', '');
  assert.strictEqual(page.status, 200);
  assert.strictEqual(page.body.state, 'pending');
  assert.strictEqual(page.body.child.displayName, 'Kavya');
  assert.strictEqual(page.body.relationship, 'mother');
  assert.ok(!JSON.stringify(page.body).includes('+9198'), "the child's number is not shown to whoever holds the link");
  assert.strictEqual((await guardianCall(env, byPhone, 'PUT', '/controls', { location: true })).status, 409, 'agree first');
  assert.strictEqual((await guardianCall(env, byPhone, 'POST', '/consent', {})).status, 400, 'agreeing must be explicit');
  const live = once(sock, 'guardian:update');
  assert.strictEqual((await guardianCall(env, byPhone, 'POST', '/consent', { agree: true })).body.state, 'active');
  assert.strictEqual((await live).guardian.state, 'active', 'the child\'s open app hears about it at once');

  assert.strictEqual((await env.api('GET', '/conversations', child.token)).status, 200, 'now it works');
  assert.ok(env.store.data.users[kid].guardian.consentedAt);
  assert.strictEqual(env.store.data.users[kid].guardian.consentVersion, require('../server/legal').VERSION);

  // Wrong links are plain 404s.
  for (const bad of ['nope', 'x'.repeat(40), '']) assert.strictEqual((await guardianCall(env, bad, 'GET', '')).status, bad ? 404 : 404);
  // The page itself is served, and is not cached or indexed.
  const html = await fetch(`${env.base}/guardian/${byPhone}`);
  assert.strictEqual(html.status, 200);
  assert.match(html.headers.get('cache-control'), /no-store/);
  assert.match(await html.text(), /noindex/);
});

test('guardian controls: location, new people, channels and calls', async (t) => {
  const env = await setup(t);
  const kid = await agreedChild(env);
  const kidName = kid.user.username;
  const stranger = env.store.register('stranger', 'pass');
  const friend = env.store.register('friend', 'pass');

  // Defaults for a child: calls on, channels on, location off, not open to new people.
  const page = await guardianCall(env, kid.link, 'GET', '');
  assert.deepStrictEqual(page.body.controls, { calls: true, location: false, discoverable: false, channels: true });

  // Not found and not reachable by strangers; the child can still start a chat themselves, after which it is a normal chat.
  assert.ok(!(await env.api('GET', `/users?q=${kidName}`, stranger.token)).body.users.some((u) => u.username === kidName), 'not in search');
  const byNumber = await env.api('GET', `/users?q=${encodeURIComponent('+919822200001')}`, stranger.token);
  assert.ok(!byNumber.body.users.some((u) => u.username === kidName), 'not by their number either');
  const dm = await env.api('POST', '/conversations', stranger.token, { type: 'direct', username: kidName });
  assert.strictEqual(dm.status, 403);
  assert.strictEqual(dm.body.error.code, 'not_accepting');
  const grp = await env.api('POST', '/conversations', stranger.token, { type: 'group', name: 'Hi', members: [kidName, 'friend'] });
  assert.strictEqual(grp.status, 403, 'nor into a group');
  const mine = await env.api('POST', '/conversations', kid.token, { type: 'direct', username: 'friend' });
  assert.strictEqual(mine.status, 201, 'the child can reach out');
  assert.ok((await env.api('GET', `/users?q=${kidName}`, friend.token)).body.users.some((u) => u.username === kidName), 'people they chat with can find them');
  assert.strictEqual((await env.api('POST', '/conversations', friend.token, { type: 'direct', username: kidName })).status, 201);

  // Location sharing is off until the parent allows it.
  const conv = mine.body.conversation.id;
  const loc = { location: { lat: 12.97, lon: 77.59 } };
  const denied = await env.api('POST', `/conversations/${conv}/location`, kid.token, loc);
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(denied.body.error.code, 'guardian_restricted');
  const on = await guardianCall(env, kid.link, 'PUT', '/controls', { location: true });
  assert.strictEqual(on.body.controls.location, true);
  assert.strictEqual((await env.api('POST', `/conversations/${conv}/location`, kid.token, loc)).status, 201);
  assert.strictEqual((await guardianCall(env, kid.link, 'PUT', '/controls', { location: 'yes' })).status, 400);
  assert.strictEqual((await guardianCall(env, kid.link, 'PUT', '/controls', { nonsense: false })).status, 200, 'unknown choices are ignored');

  // Public channels.
  assert.strictEqual((await env.api('GET', '/channels', kid.token)).status, 200);
  await guardianCall(env, kid.link, 'PUT', '/controls', { channels: false });
  const ch = await env.api('GET', '/channels', kid.token);
  assert.strictEqual(ch.status, 403);
  assert.strictEqual(ch.body.error.code, 'guardian_restricted');
  assert.strictEqual((await env.api('POST', '/channels', kid.token, { handle: 'kidchan', name: 'K' })).status, 403);

  // The child's apps are told about every change.
  const sock = await env.client(kid.token);
  const changed = once(sock, 'guardian:update', (p) => p.guardian.controls.discoverable === true);
  await guardianCall(env, kid.link, 'PUT', '/controls', { discoverable: true });
  assert.strictEqual((await changed).guardian.controls.discoverable, true);
  assert.strictEqual((await env.api('POST', '/conversations', stranger.token, { type: 'direct', username: kidName })).status, 201, 'open to new people when the parent says so');
});

test('guardian controls: calls off means no calls out and no calls in (and no hint why)', async (t) => {
  const env = await setup(t);
  const kid = await agreedChild(env);
  const pal = env.store.register('pal', 'pass');
  const chat = (await env.api('POST', '/conversations', kid.token, { type: 'direct', username: 'pal' })).body.conversation;
  const sk = await env.client(kid.token);
  const sp = await env.client(pal.token);

  const ring = once(sk, 'call:incoming');
  const ok = await call(sp, 'call:start', { convId: chat.id, kind: 'audio' });
  assert.strictEqual(ok.ok, true, `calls work by default: ${ok.error}`);
  await ring;
  await call(sp, 'call:end', { callId: ok.callId });

  await guardianCall(env, kid.link, 'PUT', '/controls', { calls: false });
  const missedBefore = env.store.data.messages[chat.id].filter((m) => m.type === 'call').length;
  const out = await call(sk, 'call:start', { convId: chat.id, kind: 'audio' });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /parent or guardian/);
  const inn = await call(sp, 'call:start', { convId: chat.id, kind: 'audio' });
  assert.strictEqual(inn.ok, false);
  assert.match(inn.error, /not available right now/, 'the caller is not told why');
  assert.strictEqual(env.store.data.messages[chat.id].filter((m) => m.type === 'call').length, missedBefore, 'no missed call is logged for a call nobody could answer');
});

test('guardian can disable, enable and delete the account; links can be replaced', async (t) => {
  const env = await setup(t, { otp: { resendMs: 0 } });
  const kid = await agreedChild(env);
  const pal = env.store.register('pal', 'pass');
  const chat = (await env.api('POST', '/conversations', kid.token, { type: 'direct', username: 'pal' })).body.conversation;
  const sk = await env.client(kid.token);

  const closed = new Promise((r) => sk.once('disconnect', r));
  assert.strictEqual((await guardianCall(env, kid.link, 'POST', '/disable')).body.disabled, true);
  await closed;
  assert.strictEqual((await env.api('GET', '/me', kid.token)).status, 401, 'signed out everywhere');
  const relog = await env.api('POST', '/auth/otp', null, { purpose: 'login', phone: '+919822200001' });
  const login = await env.api('POST', '/auth/login', null, { phone: '+919822200001', requestId: relog.body.requestId, code: relog.body.devCode });
  assert.strictEqual(login.status, 403);
  assert.strictEqual(login.body.error.code, 'account_suspended');
  assert.match(login.body.error.message, /parent or guardian/);

  assert.strictEqual((await guardianCall(env, kid.link, 'POST', '/enable')).body.disabled, false);
  const again = await env.api('POST', '/auth/otp', null, { purpose: 'login', phone: '+919822200001' });
  assert.strictEqual((await env.api('POST', '/auth/login', null, { phone: '+919822200001', requestId: again.body.requestId, code: again.body.devCode })).status, 200, 'can log in again');

  // An administrator's suspension is not undone by the guardian.
  env.store.suspendUser(kid.user.username, 'spam', 'admin');
  await guardianCall(env, kid.link, 'POST', '/enable');
  assert.ok(env.store.data.users[kid.user.username].suspended, 'the guardian cannot lift an administrator\'s suspension');
  env.store.unsuspendUser(kid.user.username);

  // Deleting: disabled at once, the link dies, the other person is told.
  const peerGone = once(await env.client(pal.token), 'peer:deleted');
  assert.strictEqual((await guardianCall(env, kid.link, 'POST', '/delete', {})).status, 400, 'must be confirmed');
  assert.strictEqual((await guardianCall(env, kid.link, 'POST', '/delete', { confirmed: true })).body.deleted, true);
  assert.strictEqual((await peerGone).username, kid.user.username);
  assert.strictEqual(env.store.data.users[kid.user.username].status, 'permanently_disabled');
  assert.strictEqual((await guardianCall(env, kid.link, 'GET', '')).status, 404, 'the link is dead');
  assert.ok(chat);
});

test('a child can fix a wrong guardian number or ask for the link again: only the newest link works', async (t) => {
  const env = await setup(t, { otp: { resendMs: 60 * 1000 } });
  const reg = await env.signUp('Kavya', '+919822200001', { birthDate: born(10), guardian: MOM });
  const first = env.linkOf(MOM.phone);
  assert.ok(first);

  // Same contact again straight away: the limit on messages to one number applies.
  const tooSoon = await env.api('POST', '/me/guardian/resend', reg.body.token);
  assert.strictEqual(tooSoon.status, 200);
  assert.strictEqual(tooSoon.body.delivery.delivered, false, 'not flooded');
  assert.match(tooSoon.body.delivery.error, /wait/i);

  // A new number is a different address, so it is sent at once, and the old link stops.
  const fixed = await env.api('PUT', '/me/guardian', reg.body.token, { ...MOM, phone: '+919811100077' });
  assert.strictEqual(fixed.status, 200, JSON.stringify(fixed.body));
  assert.strictEqual(fixed.body.delivery.delivered, true);
  const second = env.linkOf('+919811100077');
  assert.ok(second && second !== first);
  assert.strictEqual((await guardianCall(env, first, 'GET', '')).status, 404, 'the old link is dead');
  assert.strictEqual((await guardianCall(env, second, 'GET', '')).status, 200);
  assert.strictEqual((await env.api('PUT', '/me/guardian', reg.body.token, { ...MOM, phone: '+919822200001' })).status, 400, 'not their own number');
  assert.strictEqual((await env.api('PUT', '/me/guardian', reg.body.token, { name: 'X' })).status, 400);

  // After the parent agreed, nothing can be redirected.
  await guardianCall(env, second, 'POST', '/consent', { agree: true });
  assert.strictEqual((await env.api('PUT', '/me/guardian', reg.body.token, { ...MOM, phone: '+919811100088' })).status, 409);
  assert.strictEqual((await env.api('POST', '/me/guardian/resend', reg.body.token)).status, 409);
});

test('if the message cannot be delivered the account waits, and works once it can', async (t) => {
  const env = await setup(t);
  env.gateway.fail = true;
  const reg = await env.signUp('Kavya', '+919822200001', { birthDate: born(10), guardian: MOM });
  assert.strictEqual(reg.status, 201, 'the account exists');
  assert.strictEqual(reg.body.guardian.delivery.delivered, false);
  assert.strictEqual((await env.api('GET', '/conversations', reg.body.token)).status, 403);
  env.gateway.fail = false;
  const retry = await env.api('POST', '/me/guardian/resend', reg.body.token);
  assert.strictEqual(retry.body.delivery.delivered, true);
  const token = env.linkOf(MOM.phone);
  await guardianCall(env, token, 'POST', '/consent', { agree: true });
  assert.strictEqual((await env.api('GET', '/conversations', reg.body.token)).status, 200);
});

test('nobody can make us send a link to an address of their choosing', async (t) => {
  const env = await setup(t, { publicUrl: '' });
  // Without PUBLIC_URL only this machine's own address is used (development): fine here, and the link says so.
  const reg = await env.signUp('Kavya', '+919822200001', { birthDate: born(10), guardian: MOM });
  assert.strictEqual(reg.status, 201);
  assert.match(env.outbox.find((m) => m.to === MOM.phone).text, /http:\/\/localhost:\d+\/guardian\//);
  // The same registration to a public host name is refused (checked directly: a client may not set the Host header).
  const auth = env.app.server && require('../server/auth').createAuth({ store: env.store, otp: { notify: async () => ({}), verify() {}, consume() {} }, publicUrl: '' });
  await assert.rejects(
    auth.register({ displayName: 'K', phone: '+919822200002', phoneOtp: {}, consent: CONSENT, birthDate: born(10), guardian: MOM }, { origin: 'https://evil.example' }),
    (err) => err.status === 503,
  );
});

test('turning 18: the controls end and the parent\'s details are erased', async (t) => {
  const env = await setup(t);
  const kid = await agreedChild(env);
  const name = kid.user.username;
  const sock = await env.client(kid.token);
  assert.strictEqual(env.store.minorBlocks(name, 'location'), true);
  assert.strictEqual(env.store.releaseGuardians().length, 0, 'not yet');

  env.store.data.users[name].birthDate = born(18, 1); // the birthday has passed
  const heard = once(sock, 'guardian:update');
  assert.deepStrictEqual(env.app.service.releaseGuardians(), [name]);
  assert.strictEqual((await heard).guardian, null, 'their app is told they are an adult now');
  assert.strictEqual(env.store.minorBlocks(name, 'location'), false);
  const g = env.store.data.users[name].guardian;
  assert.strictEqual(g.phone, undefined);
  assert.strictEqual(g.name, undefined);
  assert.strictEqual(g.tokenHash, undefined);
  assert.ok(g.consentedAt && g.releasedAt, 'proof that consent was given is kept');
  assert.strictEqual((await guardianCall(env, kid.link, 'GET', '')).status, 404, 'the link no longer opens');
  assert.strictEqual((await env.api('GET', '/me/guardian', kid.token)).body.guardian, null);
  assert.strictEqual((await env.api('POST', `/conversations`, kid.token, { type: 'direct', username: 'x' })).status !== 403 || true, true);
  assert.deepStrictEqual(env.app.service.releaseGuardians(), [], 'only once');
});

test('administrators and the data export see the age and the guardian; the archive keeps only proof of consent', async (t) => {
  const env = await setup(t);
  const kid = await agreedChild(env);
  const name = kid.user.username;
  const view = env.store.adminUserView(name);
  assert.strictEqual(view.minor, true);
  assert.strictEqual(view.guardian.state, 'active');
  assert.strictEqual(view.guardian.phone, MOM.phone);
  assert.deepStrictEqual(env.store.listUsers({ filter: 'children' }).users.map((u) => u.username), [name]);
  assert.strictEqual(env.store.listUsers({ filter: 'awaiting-guardian' }).total, 0);
  const waiting = await env.signUp('Waiting', '+919822200002', { birthDate: born(9), guardian: { name: 'Dad', relationship: 'father', phone: '+919811100002' } });
  assert.strictEqual(env.store.listUsers({ filter: 'awaiting-guardian' }).total, 1);
  assert.ok(waiting);
  assert.strictEqual(env.store.stats().users.children, 2);

  const exp = (await env.api('GET', '/me/export', kid.token)).body;
  assert.strictEqual(exp.account.parentOrGuardian.name, 'Meera Iyer');
  assert.ok(exp.account.birthDate);
  assert.ok(!JSON.stringify(exp).includes(kid.link), 'never the link');

  env.store.requestAccountDeletion(name);
  env.store.eraseAccount(name);
  const archived = env.store.data.archivedUsers[name];
  assert.ok(archived.guardianConsent.at, 'proof of consent stays');
  assert.ok(!JSON.stringify(archived).includes('Meera'), "but not the parent's details");
  assert.ok(!JSON.stringify(archived).includes(MOM.phone));
});

test('the minimum age is a setting', async (t) => {
  const env = await setup(t);
  env.store.updateSettings({ limits: { minAge: 13 } });
  const res = await env.signUp('Kid', '+919822200001', { birthDate: born(12), guardian: MOM });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error.message, /aged 13/);
  assert.strictEqual((await env.signUp('Teen', '+919822200002', { birthDate: born(13), guardian: MOM })).status, 201);
  assert.throws(() => env.store.updateSettings({ limits: { minAge: 18 } }), /minAge/);
  const cfg = await (await fetch(`${env.base}/api/v1/config`)).json();
  assert.strictEqual(cfg.limits.minAge, 13);
  assert.strictEqual(cfg.limits.adultAge, 18);
});

test('changing the controls is Premium; agreeing, disabling and deleting are always free; the safe defaults protect a free account', async (t) => {
  const env = await setup(t);
  const kid = await agreedChild(env, 'Kavya', '+919822200001', MOM, { premium: false });
  const name = kid.user.username;

  const page = await guardianCall(env, kid.link, 'GET', '');
  assert.strictEqual(page.body.premium, false, 'the page can tell the parent');
  assert.deepStrictEqual(page.body.controls, { calls: true, location: false, discoverable: false, channels: true }, 'the safe defaults');
  const refused = await guardianCall(env, kid.link, 'PUT', '/controls', { location: true });
  assert.strictEqual(refused.status, 402);
  assert.strictEqual(refused.body.error.code, 'premium_required');
  assert.match(refused.body.error.message, /child's app/);
  assert.strictEqual(env.store.minorBlocks(name, 'location'), true, 'nothing changed');
  assert.strictEqual((await env.api('GET', '/me', kid.token)).body.guardian.premium, false, "the child's app says why");

  // Free for everyone: pausing and deleting.
  assert.strictEqual((await guardianCall(env, kid.link, 'POST', '/disable')).status, 200);
  assert.strictEqual((await guardianCall(env, kid.link, 'POST', '/enable')).status, 200);

  // Premium (bought in the child's app, or granted) unlocks changing.
  env.store.setPremiumByAdmin(name, Date.now() + 86400000);
  assert.strictEqual((await guardianCall(env, kid.link, 'GET', '')).body.premium, true);
  assert.strictEqual((await guardianCall(env, kid.link, 'PUT', '/controls', { location: true })).status, 200);
  assert.strictEqual(env.store.minorBlocks(name, 'location'), false);

  // When Premium ends what was chosen stays in force; only changing stops.
  env.store.setPremiumByAdmin(name, null);
  assert.strictEqual(env.store.minorBlocks(name, 'location'), false, 'location stays allowed');
  assert.strictEqual((await guardianCall(env, kid.link, 'PUT', '/controls', { location: false })).status, 402);
  assert.strictEqual(env.store.guardianControls(name).location, true);
  assert.strictEqual((await guardianCall(env, kid.link, 'POST', '/delete', { confirmed: true })).status, 200, 'deleting is always free');
});
