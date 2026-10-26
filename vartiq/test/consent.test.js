'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const legal = require('../server/legal');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));
const enc = encodeURIComponent;
const CONSENT = { terms: true, version: legal.VERSION };

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const sms = [];
  const app = createApp({
    store,
    otp: { sender: async (m) => { sms.push(m); }, resendMs: 0 },
    translate: { sandbox: true },
    ...opts,
  });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); app.io.close(); app.server.close(); });
  const api = async (method, path, { token, body, raw } = {}) => {
    const res = await fetch(`${base}${raw ? '' : '/api/v1'}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* html */ }
    return { status: res.status, body: parsed, text };
  };
  const client = async (token) => {
    const s = connect(base, { auth: { token, appSession: 'x' }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); });
    return s;
  };
  const codeFor = async (purpose, phone) => {
    const sent = (await api('POST', '/auth/otp', { body: { purpose, phone } })).body;
    const code = sms.filter((m) => m.purpose === purpose).pop().code;
    return { requestId: sent.requestId, code };
  };
  const signup = async (name, phone, consent = CONSENT) => {
    const proof = await codeFor('register', phone);
    return api('POST', '/auth/register', { body: { birthDate: '1990-05-17', displayName: name, phone, phoneOtp: proof, consent } });
  };
  const emailCode = async () => ({ code: sms.filter((m) => m.channel === 'email').pop().code });
  return { store, api, client, sms, codeFor, emailCode, signup, app };
}

test('legal: the Terms and Privacy Notice are public, readable, and name who is responsible', async (t) => {
  const { api, store } = await setup(t);
  const summary = (await api('GET', '/legal')).body;
  assert.strictEqual(summary.version, legal.VERSION);
  assert.deepStrictEqual(summary.consents.map((c) => [c.id, c.required]), [['terms', true], ['translation', false], ['kyc', false]]);
  assert.strictEqual(summary.configured, false, 'placeholders until an administrator fills in the company details');

  const page = await api('GET', '/legal/privacy', { raw: true });
  assert.strictEqual(page.status, 200);
  for (const must of ['Privacy Notice', 'end-to-end encrypted', 'Grievance Officer', 'DPDP', 'not end-to-end encrypted', 'Cloudflare', 'translation service', 'identity verification', 'do not read your phone']) {
    assert.ok(page.text.includes(must), `the notice should mention "${must}"`);
  }
  assert.match(page.text, /\[Company legal name\]/);
  assert.strictEqual((await api('GET', '/legal/nope', { raw: true })).status, 404);
  const terms = (await api('GET', '/legal/terms')).body;
  assert.ok(terms.sections.length >= 10 && terms.sections[0].title.includes('Agreement'));

  store.updateSettings({ legal: { company: 'PrayukTech Pvt Ltd', address: '12 Example Road, Bengaluru', grievanceName: 'Asha Rao', grievanceEmail: 'grievance@prayuktech.example', contactEmail: 'hello@prayuktech.example', city: 'Bengaluru', hosting: 'India (Mumbai)' } });
  const after = await api('GET', '/legal/privacy', { raw: true });
  assert.ok(after.text.includes('PrayukTech Pvt Ltd') && after.text.includes('grievance@prayuktech.example') && after.text.includes('India (Mumbai)'));
  assert.ok(!after.text.includes('[Company legal name]'));
  assert.strictEqual((await api('GET', '/legal')).body.configured, true);
  assert.throws(() => store.updateSettings({ legal: { grievanceEmail: 'not an email' } }), /email/);
  assert.throws(() => store.updateSettings({ legal: { nonsense: 'x' } }), /Unknown legal setting/);
});

test('registration needs consent: the tick and the current version; nothing is used up if missing', async (t) => {
  const { api, codeFor, store, emailCode } = await setup(t);
  const phone = '+919811100001';
  const proof = await codeFor('register', phone);
  const reg = (consent) => api('POST', '/auth/register', { body: { birthDate: '1990-05-17', displayName: 'Meera Iyer', phone, phoneOtp: proof, ...(consent ? { consent } : {}) } });

  assert.deepStrictEqual([(await reg(null)).status, (await reg(null)).body.error.code], [400, 'consent_required']);
  assert.strictEqual((await reg({ terms: false, version: legal.VERSION })).body.error.code, 'consent_required');
  assert.strictEqual((await reg({ terms: 'yes', version: legal.VERSION })).body.error.code, 'consent_required', 'must be an explicit true');
  assert.strictEqual((await reg({ terms: true, version: '2000-01-01' })).body.error.code, 'consent_outdated');
  assert.strictEqual(store.findByPhone(phone), null, 'no account without consent');

  const ok = await reg(CONSENT); // the same code still works: the failed tries did not use it up
  assert.strictEqual(ok.status, 201, ok.text);
  const record = store.consentOf(ok.body.user.username);
  assert.deepStrictEqual([record.version, record.accepted, record.history[0].action, record.history[0].via], [legal.VERSION, ['terms'], 'accept', 'registration']);
  assert.ok(record.at > 0);
  const me = (await api('GET', '/me', { token: ok.body.token })).body;
  assert.deepStrictEqual([me.consent.upToDate, me.consent.optional], [true, { translation: false, kyc: false }]);

  // A business account needs it too.
  const bsms = await codeFor('register', '+919811100002');
  const bmail = (await api('POST', '/auth/otp', { body: { purpose: 'register', email: 'shop@example.com' } })).body;
  const bemailCode = (await emailCode()).code;
  const biz = { birthDate: '1990-05-17', accountType: 'business', displayName: 'Corner Shop', phone: '+919811100002', phoneOtp: bsms, email: 'shop@example.com', emailOtp: { requestId: bmail.requestId, code: bemailCode }, business: { category: 'Retail', timezone: 'UTC' } };
  assert.strictEqual((await api('POST', '/auth/register', { body: biz })).body.error.code, 'consent_required');
  assert.strictEqual((await api('POST', '/auth/register', { body: { birthDate: '1990-05-17', ...biz, consent: CONSENT } })).status, 201);
});

test('when the texts change, everybody must accept again before they can use anything', async (t) => {
  const { api, client, signup, store } = await setup(t);
  const a = (await signup('Asha Rao', '+919811100011')).body;
  const b = (await signup('Bilal Khan', '+919811100012')).body;
  const dm = store.getOrCreateDirect(a.user.username, b.user.username);
  const sa = await client(a.token);
  assert.strictEqual((await call(sa, 'message:send', { convId: dm.id, text: 'hi' })).ok, true);

  // A newer version of the texts is published: their stored acceptance is now old.
  store.data.users[a.user.username].consent.version = '2000-01-01';
  const blockedRest = await api('GET', '/conversations', { token: a.token });
  assert.deepStrictEqual([blockedRest.status, blockedRest.body.error.code], [403, 'consent_required']);
  const blockedSocket = await call(sa, 'message:send', { convId: dm.id, text: 'again' });
  assert.deepStrictEqual([blockedSocket.ok, blockedSocket.code], [false, 'consent_required']);
  assert.strictEqual((await call(sa, 'call:start', { convId: dm.id, kind: 'audio' }).catch(() => ({ code: 'x' }))).code, 'consent_required', 'calls are blocked too');
  // Still reachable: what you need to accept, download or leave.
  assert.strictEqual((await api('GET', '/me', { token: a.token })).body.consent.upToDate, false);
  assert.strictEqual((await api('GET', '/me/consent', { token: a.token })).status, 200);
  assert.strictEqual((await api('GET', '/me/export', { token: a.token })).status, 200);
  // Not an acceptance unless it is an explicit yes.
  assert.strictEqual((await api('POST', '/me/consent', { token: a.token, body: { terms: 'maybe' } })).body.error.code, 'consent_required');
  const accepted = await api('POST', '/me/consent', { token: a.token, body: { terms: true } });
  assert.deepStrictEqual([accepted.status, accepted.body.upToDate, accepted.body.acceptedVersion], [200, true, legal.VERSION]);
  assert.strictEqual((await api('GET', '/conversations', { token: a.token })).status, 200);
  assert.strictEqual((await call(sa, 'message:send', { convId: dm.id, text: 'back' })).ok, true);
  const history = store.consentOf(a.user.username).history;
  assert.deepStrictEqual(history.map((h) => h.action), ['accept', 'accept']);
});

test('accounts made before consent existed are only held to it when the administrator says so', async (t) => {
  const { api, store } = await setup(t);
  const old = store.register('olduser', 'pass');
  assert.strictEqual((await api('GET', '/conversations', { token: old.token })).status, 200, 'allowed by default');
  store.updateSettings({ legal: { requireForLegacy: true } });
  assert.strictEqual((await api('GET', '/conversations', { token: old.token })).body.error.code, 'consent_required');
  await api('POST', '/me/consent', { token: old.token, body: { terms: true } });
  assert.strictEqual((await api('GET', '/conversations', { token: old.token })).status, 200);
});

test('optional consents: translation and ID verification do nothing until the person agrees, and can be withdrawn', async (t) => {
  const { api, signup, store } = await setup(t);
  const a = (await signup('Asha Rao', '+919811100021')).body;
  const b = (await signup('Bilal Khan', '+919811100022')).body;
  const dm = store.getOrCreateDirect(a.user.username, b.user.username);

  const blocked = await api('PUT', `/conversations/${enc(dm.id)}/translation`, { token: a.token, body: { lang: 'hi' } });
  assert.deepStrictEqual([blocked.status, blocked.body.error.code], [403, 'consent_translation']);
  assert.match(blocked.body.error.message, /translation service/);
  assert.strictEqual((await api('PUT', '/me/consent/translation', { token: a.token, body: { granted: 'yes' } })).status, 400);
  assert.strictEqual((await api('PUT', '/me/consent/terms', { token: a.token, body: { granted: false } })).status, 400, 'required ones cannot be "withdrawn" here');
  const granted = await api('PUT', '/me/consent/translation', { token: a.token, body: { granted: true } });
  assert.deepStrictEqual([granted.status, granted.body.optional], [200, { translation: true, kyc: false }]);
  assert.strictEqual((await api('PUT', `/conversations/${enc(dm.id)}/translation`, { token: a.token, body: { lang: 'hi' } })).status, 200);
  assert.strictEqual(store.translateTo(a.user.username, dm.id), 'hi');

  // Withdrawing is as easy, and stops translation everywhere.
  await api('PUT', '/me/consent/translation', { token: a.token, body: { granted: false } });
  assert.strictEqual(store.translateTo(a.user.username, dm.id), null);
  assert.strictEqual((await api('POST', `/conversations/${enc(dm.id)}/translate`, { token: a.token, body: { texts: ['hello'] } })).status >= 400, true);
  assert.deepStrictEqual(store.consentOf(a.user.username).history.map((h) => `${h.action}:${h.items}`), ['accept:terms', 'grant:translation', 'withdraw:translation']);

  const kyc = await api('POST', '/me/verification/otp', { token: a.token, body: { type: 'aadhaar', idNumber: '123456789012' } });
  assert.strictEqual(kyc.body.error.code, 'consent_kyc');
  assert.match(kyc.body.error.message, /not store my ID number/);
});

test('"download my data" returns what is held, including consent history, without secrets', async (t) => {
  const { api, signup, store } = await setup(t);
  const a = (await signup('Asha Rao', '+919811100031')).body;
  const b = (await signup('Bilal Khan', '+919811100032')).body;
  const dm = store.getOrCreateDirect(a.user.username, b.user.username);
  store.addMessage(dm.id, a.user.username, 'hello bilal');
  store.createApiKey(a.user.username, 'my bot');
  const res = await api('GET', '/me/export', { token: a.token });
  assert.strictEqual(res.status, 200);
  const data = res.body;
  assert.strictEqual(data.format, 'vartiq-export-1');
  assert.deepStrictEqual([data.account.username, data.account.mobile], [a.user.username, '+919811100031']);
  assert.strictEqual(data.consent.accepted.includes('terms'), true);
  assert.strictEqual(data.chats[0].messages[0].text, 'hello bilal');
  assert.strictEqual(data.developer.apiKeys[0].name, 'my bot');
  assert.ok(!('hash' in data.developer.apiKeys[0]) && !JSON.stringify(data).includes('whsec_'), 'no key hashes or webhook secrets in the export');
  assert.strictEqual(data.account.hash, undefined);
  assert.strictEqual((await api('GET', '/me/export', {})).status, 401);
});

const deleteWith = async (api, codeFor, token, phone, extra = {}) => {
  const sent = (await api('POST', '/me/delete/code', { token })).body;
  const proof = { requestId: sent.requestId, code: (await codeFor('delete', phone)).code };
  return api('DELETE', '/me', { token, body: { ...proof, confirmed: true, ...extra } });
};

test('deleting an account: permanently disabled at once, chats and personal data erased within 24 hours, a basic record stays', async (t) => {
  const { api, client, signup, store, codeFor, app } = await setup(t);
  const a = (await signup('Asha Rao', '+919811100041')).body;
  const b = (await signup('Bilal Khan', '+919811100042')).body;
  const c = (await signup('Chitra Nair', '+919811100043')).body;
  const [ua, ub, uc] = [a.user.username, b.user.username, c.user.username];
  const dm = store.getOrCreateDirect(ua, ub);
  store.addMessage(dm.id, ua, 'a secret from asha');
  store.addMessage(dm.id, ub, 'a reply from bilal');
  const group = store.createGroup(ua, 'Study group', [ub, uc]);
  store.addMessage(group.id, ua, 'group hello');
  const channel = store.createChannel(ua, { handle: 'ashas_news', name: 'News', description: 'd' });
  store.postToChannel(ua, channel.id, 'post');
  store.createApiKey(ua, 'bot');
  store.addStatus(ua, { type: 'text', text: 'my status' });
  store.setContact(ua, 'email', 'asha@example.com');
  const sa = await client(a.token);
  const sb = await client(b.token);
  const peerDeleted = next(sb, 'peer:deleted');
  const disconnected = next(sa, 'disconnect');

  // Not without the tick in the popup, and not without the right code.
  const sent = (await api('POST', '/me/delete/code', { token: a.token })).body;
  const code = (await codeFor('delete', '+919811100041')).code;
  const bad = (extra) => api('DELETE', '/me', { token: a.token, body: { requestId: sent.requestId, code, ...extra } });
  assert.strictEqual((await bad({})).status, 400, 'no confirmation');
  assert.strictEqual((await bad({ confirmed: 'yes' })).status, 400, 'must be an explicit true');
  assert.strictEqual((await bad({ confirmed: true, code: code === '000000' ? '111111' : '000000' })).body.error.code, 'otp_invalid');
  const t0 = Date.now();
  const done = await bad({ confirmed: true });
  assert.strictEqual(done.status, 200, done.text);
  assert.deepStrictEqual([done.body.deleted, done.body.loginBlocked], [true, true]);
  assert.ok(new Date(done.body.dataErasedBy).getTime() - t0 <= 24 * 3600 * 1000 + 5000, 'the promise: erased within 24 hours');
  assert.deepStrictEqual((await peerDeleted).username, ua);
  await disconnected;

  // Immediately: permanently disabled. No login, no session, nothing of them is shown, nobody can write to them.
  assert.strictEqual((await api('GET', '/me', { token: a.token })).status, 401);
  assert.strictEqual(store.data.users[ua].status, 'permanently_disabled');
  assert.strictEqual((await api('POST', '/auth/otp', { body: { purpose: 'login', phone: '+919811100041' } })).body.devCode, undefined, 'the number no longer belongs to that account: no code is made');
  assert.throws(() => store.createSession(ua), /being deleted/);
  assert.deepStrictEqual([store.publicUser(ua).displayName, store.publicUser(ua).about, store.publicUser(ua).deleted], ['Deleted account', '', true]);
  assert.deepStrictEqual(store.searchUsers('asha', ub), []);
  assert.throws(() => store.addMessage(dm.id, ub, 'are you there?'), /account was deleted/);
  assert.throws(() => store.getOrCreateDirect(ub, ua), /not found/i);
  assert.strictEqual(Object.values(store.data.apiKeys).length, 0, 'keys revoked at once');
  assert.strictEqual(app.service.eraseDueAccounts().length, 0, 'not erased before its time');
  assert.strictEqual(store.data.users[ua].phone, undefined, 'the number is released at once');
  assert.strictEqual(store.data.users[ua].displayName, 'Asha Rao', 'the rest of the personal data is erased by the next step');

  // Registering again is allowed straight away: a brand-new account with a new registration date.
  const again = await signup('Asha Again', '+919811100041');
  assert.strictEqual(again.status, 201, again.text);
  assert.notStrictEqual(again.body.user.username, ua);
  assert.ok(store.data.users[again.body.user.username].createdAt >= t0 && store.data.users[again.body.user.username].createdAt > store.data.users[ua].createdAt);
  assert.strictEqual((await api('GET', '/me/export', { token: again.body.token })).body.chats.length, 0, 'none of the old chats');

  const waiting = store.stats().users;
  assert.deepStrictEqual([waiting.deleting, waiting.deletionOverdue, waiting.total], [1, 0, 3]);

  // The erase step (the server runs it by itself within the deadline).
  store.data.users[ua].deletion.eraseAt = Date.now() - 1;
  assert.deepStrictEqual(app.service.eraseDueAccounts(), [ua]);
  const tomb = store.data.archivedUsers[ua];
  assert.strictEqual(store.data.users[ua], undefined, 'moved out of the live users');
  assert.deepStrictEqual(Object.keys(tomb).sort(), ['about', 'archivedAt', 'consent', 'createdAt', 'deletedAt', 'disabledAt', 'displayName', 'lastSeen', 'status', 'username'], 'a basic archived record: no phone, email, name, settings, keys, chats or media');
  assert.deepStrictEqual([tomb.status, tomb.displayName, tomb.consent.accepted], ['permanently_disabled', 'Deleted account', ['terms']], 'the record of consent is kept');
  assert.strictEqual(store.findByEmail('asha@example.com'), null);
  const left = store.getMessages(dm.id, ub);
  assert.deepStrictEqual(left.map((m) => [m.deleted === true, m.text]), [[true, ''], [false, 'a reply from bilal']]);
  assert.ok(!JSON.stringify(store.data).includes('a secret from asha') && !JSON.stringify(store.data).includes('group hello') && !JSON.stringify(store.data).includes('my status'));
  assert.deepStrictEqual([store.data.conversations[group.id].members.sort(), store.data.conversations[group.id].owner === ua], [[ub, uc].sort(), false]);
  assert.deepStrictEqual([store.data.channels[channel.id], Object.values(store.data.statuses).length, Object.values(store.data.apiKeys).length], [undefined, 0, 0]);
  assert.deepStrictEqual([store.stats().users.deleting, store.stats().users.deleted], [0, 1]);
  assert.strictEqual(store.publicUser(ua).displayName, 'Deleted account', 'other people\'s chats still resolve');
  assert.deepStrictEqual(store.listUsers({ filter: 'deleted' }).users.map((x) => [x.username, x.status]), [[ua, 'permanently_disabled']]);
  assert.ok(!store.listUsers({}).users.some((x) => x.username === ua), 'not among the live users');

  // No duplicates: the archived username is reserved, so a new account with the same name gets another one and none of the old chats.
  const twin = await signup('Asha Rao', '+919811100071');
  assert.strictEqual(twin.status, 201, twin.text);
  assert.notStrictEqual(twin.body.user.username, ua);
  assert.throws(() => store.registerVerified({ displayName: 'Asha Rao', username: ua, phone: '+919811100072' }), /already taken/);
  assert.strictEqual((await api('GET', '/conversations', { token: twin.body.token })).body.conversations.length, 0, 'the new account does not inherit the old chats');

});

test('the server erases a closed account by itself, within the deadline', async (t) => {
  const { api, signup, store, codeFor } = await setup(t, { accountEraseDelayMs: 0, deletionSweepMs: 30 });
  const a = (await signup('Asha Rao', '+919811100061')).body;
  const res = await deleteWith(api, codeFor, a.token, '+919811100061');
  assert.strictEqual(res.status, 200);
  for (let i = 0; i < 40 && !store.data.archivedUsers[a.user.username]; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(store.data.archivedUsers[a.user.username]?.deletedAt, 'erased and archived without anybody asking');
  assert.strictEqual(store.findByPhone('+919811100061'), null);
});

test('a group with only one person left disappears when they delete their account', async (t) => {
  const { api, signup, store, codeFor, app } = await setup(t);
  const a = (await signup('Asha Rao', '+919811100051')).body;
  const b = (await signup('Bilal Khan', '+919811100052')).body;
  const group = store.createGroup(a.user.username, 'Pair', [b.user.username]);
  store.addMessage(group.id, b.user.username, 'hi');
  assert.strictEqual((await deleteWith(api, codeFor, b.token, '+919811100052')).status, 200);
  store.data.users[b.user.username].deletion.eraseAt = Date.now() - 1;
  app.service.eraseDueAccounts();
  assert.strictEqual(store.data.conversations[group.id], undefined);
  assert.strictEqual(store.data.messages[group.id], undefined);
});
