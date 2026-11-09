'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const OK = { confirmed: true };

async function setup(t) {
  const store = new Store({ file: null });
  // The sender runs by hand (service.runCampaigns), so a test decides when a batch goes out.
  const app = createApp({ store, campaignSweepMs: 3600 * 1000 });
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
  const person = async (name, { online = true } = {}) => {
    const reg = store.register(name, 'pass', name[0].toUpperCase() + name.slice(1));
    return { name, token: reg.token, app: online ? await client(reg.token) : null };
  };
  const shop = await person('shop');
  store.setContact('shop', 'sms', '+919800000001');
  store.setContact('shop', 'email', 'hi@shop.example');
  assert.ok((await call(shop.app, 'business:set', { category: 'Retail' })).ok);
  return { store, app, client, person, shop, base, run: (now) => app.service.runCampaigns(now) };
}

test('a campaign goes to each person in their own chat and the report follows sent, delivered, read and failed', async (t) => {
  const { store, client, person, shop, run } = await setup(t);
  const ann = await person('ann');
  const bob = await person('bob', { online: false }); // offline: sent, not yet delivered
  const cy = await person('cyd');
  const dee = await person('dee'); // blocked the shop
  const eve = await person('eve'); // asked the shop to stop
  await call(dee.app, 'user:block', { username: 'shop', blocked: true });
  assert.ok((await call(eve.app, 'promo:set', { business: 'shop', receive: false })).ok);

  const made = await call(shop.app, 'campaign:create', { name: 'Diwali offer', text: 'Flat 20% off this week', audience: 'list', to: ['ann', '@bob', 'cyd', 'dee', 'eve', 'nobody-here', 'ANN'], ...OK });
  assert.ok(made.ok, made.error);
  assert.strictEqual(made.campaign.status, 'sending');
  assert.strictEqual(made.campaign.counts.total, 6, 'the duplicate (ANN) is counted once');
  assert.strictEqual(made.campaign.counts.failed, 1, 'a name that does not exist fails at once');

  run();
  run(); // a second run sends nothing twice
  const id = made.campaign.id;
  const rep = (await call(shop.app, 'campaign:get', { id })).campaign;
  assert.strictEqual(rep.status, 'completed');
  assert.deepStrictEqual([rep.counts.delivered, rep.counts.sent, rep.counts.failed, rep.counts.read], [2, 1, 3, 0], 'ann and cy online (delivered), bob offline (sent)');
  assert.deepStrictEqual(rep.counts.failedReasons, { opted_out: 1, not_delivered: 2 }, 'blocked and unknown look the same');

  // The person sees an ordinary message from the business marked as a promotion; the business keeps the campaign id.
  const dm = (await call(ann.app, 'chat:direct', { username: 'shop' })).conversation;
  const msgs = (await call(ann.app, 'messages:get', { convId: dm.id })).messages;
  assert.strictEqual(msgs.length, 1);
  assert.deepStrictEqual([msgs[0].from, msgs[0].text, msgs[0].campaign], ['shop', 'Flat 20% off this week', true]);
  assert.strictEqual(store.data.messages[dm.id][0].campaign, id);
  assert.strictEqual(store.data.messages['dm:dee:shop'], undefined, 'nothing was created for the person who blocked the shop');

  // ann reads it and replies; bob comes online and gets it.
  await call(ann.app, 'messages:read', { convId: dm.id });
  await call(ann.app, 'message:send', { convId: dm.id, text: 'Thanks!' });
  await client(bob.token); // bob comes online: his message is delivered
  await new Promise((r) => setTimeout(r, 150));
  const after = (await call(shop.app, 'campaign:get', { id })).campaign;
  assert.deepStrictEqual([after.counts.read, after.counts.delivered, after.counts.sent, after.counts.replied], [1, 2, 0, 1]);
  assert.deepStrictEqual(after.counts.cumulative, { sent: 3, delivered: 3, read: 1 });

  const failed = (await call(shop.app, 'campaign:get', { id, status: 'failed' })).recipients;
  assert.strictEqual(failed.total, 3);
  assert.deepStrictEqual(failed.items.map((r) => [r.to, r.reason]).sort(), [['dee', 'not_delivered'], ['eve', 'opted_out'], ['nobody-here', 'not_delivered']]);
  const list = (await call(shop.app, 'campaigns', {})).campaigns;
  assert.deepStrictEqual(list.map((c) => c.name), ['Diwali offer']);
});

test('the sender has to confirm; names, text and audience are checked; "customers" is for businesses only', async (t) => {
  const { person, shop } = await setup(t);
  const ann = await person('ann');
  assert.strictEqual((await call(ann.app, 'campaign:create', { name: 'x', text: 'y', audience: 'customers', ...OK })).code, 'invalid_request');
  const bad = (p) => call(shop.app, 'campaign:create', { name: 'n', text: 't', audience: 'list', to: ['ann'], ...OK, ...p });
  assert.strictEqual((await bad({ confirmed: false })).code, 'confirmation_required');
  assert.strictEqual((await bad({ name: '' })).code, 'invalid_request');
  assert.strictEqual((await bad({ text: 'x'.repeat(1001) })).code, 'invalid_request');
  assert.strictEqual((await bad({ audience: 'everyone' })).code, 'invalid_request');
  assert.strictEqual((await bad({ to: [] })).code, 'invalid_request');
  assert.strictEqual((await bad({ to: ['shop'] })).code, 'no_recipients', 'not to yourself');
  assert.strictEqual((await call(shop.app, 'campaign:create', { name: 'n', text: 't', audience: 'customers', ...OK })).code, 'no_recipients', 'nobody has written to the shop yet');
});

test('customers audience: people who wrote to the business; children never get promotions', async (t) => {
  const { store, person, shop, run } = await setup(t);
  const ann = await person('ann');
  const bob = await person('bob');
  const kid = await person('kid');
  store.data.users.kid.birthDate = `${new Date().getUTCFullYear() - 12}-01-01`;
  for (const p of [ann, kid]) {
    const dm = (await call(p.app, 'chat:direct', { username: 'shop' })).conversation;
    await call(p.app, 'message:send', { convId: dm.id, text: 'Hello' });
  }
  void bob; // never wrote
  const audience = await call(shop.app, 'campaign:audience', {});
  assert.strictEqual(audience.customers, 2);
  const made = await call(shop.app, 'campaign:create', { name: 'News', text: 'New stock', audience: 'customers', ...OK });
  assert.ok(made.ok, made.error);
  run();
  const rep = (await call(shop.app, 'campaign:get', { id: made.campaign.id })).campaign;
  assert.deepStrictEqual([rep.counts.total, rep.counts.delivered, rep.counts.failed], [2, 1, 1]);
  const kidMsgs = (store.data.messages['dm:kid:shop'] || []).filter((m) => m.campaign);
  assert.strictEqual(kidMsgs.length, 0);
});

test('limits: free businesses get fewer campaigns and recipients; Premium raises both', async (t) => {
  const { store, person, shop } = await setup(t);
  await person('ann');
  store.updateSettings({ limits: { freeCampaignRecipients: 2, premiumCampaignRecipients: 3, freeCampaignsPerDay: 1, premiumCampaignsPerDay: 2 } });
  const mk = (to) => call(shop.app, 'campaign:create', { name: 'c', text: 't', audience: 'list', to, ...OK });
  const many = await mk(['a1', 'a2', 'a3']);
  assert.strictEqual(many.code, 'premium_required');
  assert.ok((await mk(['ann'])).ok);
  assert.strictEqual((await mk(['ann'])).code, 'premium_required', 'second campaign today');
  store.activateSubscription('shop', { plan: 'monthly', expiresAt: Date.now() + 86400000 });
  assert.ok((await mk(['ann', 'a2', 'a3'])).ok);
  assert.strictEqual((await mk(['a1', 'a2', 'a3', 'a4'])).code, 'campaign_limit', 'third campaign today, even with Premium');
  store.updateSettings({ limits: { premiumCampaignsPerDay: 5 } });
  assert.strictEqual((await mk(['a1', 'a2', 'a3', 'a4'])).code, 'too_many_recipients');
});

test('scheduled campaigns wait for their time; cancel stops the rest; retry resends what failed; only finished ones are deleted', async (t) => {
  const { store, person, shop, run } = await setup(t);
  store.updateSettings({ limits: { freeCampaignsPerDay: 20 } });
  const ann = await person('ann');
  await person('eve');
  const later = Date.now() + 3600 * 1000;
  const sched = await call(shop.app, 'campaign:create', { name: 'Later', text: 'Hello later', audience: 'list', to: ['ann'], scheduleAt: later, ...OK });
  assert.strictEqual(sched.campaign.status, 'scheduled');
  run();
  assert.strictEqual((await call(shop.app, 'campaign:get', { id: sched.campaign.id })).campaign.counts.queued, 1, 'not before its time');
  assert.strictEqual((await call(shop.app, 'campaign:delete', { id: sched.campaign.id })).code, 'conflict', 'cancel it first');
  const cancelled = await call(shop.app, 'campaign:cancel', { id: sched.campaign.id });
  assert.deepStrictEqual([cancelled.campaign.status, cancelled.campaign.counts.cancelled], ['cancelled', 1]);
  assert.strictEqual((await call(shop.app, 'campaign:cancel', { id: sched.campaign.id })).code, 'conflict');

  const again = await call(shop.app, 'campaign:retry', { id: sched.campaign.id });
  assert.strictEqual(again.requeued, 1);
  run();
  assert.strictEqual((await call(shop.app, 'campaign:get', { id: sched.campaign.id })).campaign.counts.delivered, 1);

  // A schedule that has come: started by the sender.
  const due = await call(shop.app, 'campaign:create', { name: 'Soon', text: 'Hello soon', audience: 'list', to: ['ann'], scheduleAt: Date.now() + 60 * 1000, ...OK });
  run(Date.now() + 120 * 1000);
  assert.strictEqual((await call(shop.app, 'campaign:get', { id: due.campaign.id })).campaign.status, 'completed');

  // Retry: failed people are sent to again, but never someone who opted out.
  await call(ann.app, 'promo:set', { business: 'shop', receive: false });
  const c = await call(shop.app, 'campaign:create', { name: 'Third', text: 'Third', audience: 'list', to: ['ann', 'eve', 'ghost'], ...OK });
  run();
  let rep = (await call(shop.app, 'campaign:get', { id: c.campaign.id })).campaign;
  assert.deepStrictEqual(rep.counts.failedReasons, { opted_out: 1, not_delivered: 1 });
  store.data.users.ann.promoOptOut = [];
  const retry = await call(shop.app, 'campaign:retry', { id: c.campaign.id });
  assert.strictEqual(retry.requeued, 1, 'ann (no longer opted out); ghost still has no account');
  run();
  rep = (await call(shop.app, 'campaign:get', { id: c.campaign.id })).campaign;
  assert.deepStrictEqual([rep.counts.delivered, rep.counts.failed], [2, 1]);
  assert.ok((await call(shop.app, 'campaign:delete', { id: c.campaign.id })).ok);
});

test('the feature switch pauses campaigns, but people can always stop messages from a business', async (t) => {
  const { store, person, shop, run } = await setup(t);
  const ann = await person('ann');
  const made = await call(shop.app, 'campaign:create', { name: 'Now', text: 'Hello', audience: 'list', to: ['ann'], ...OK });
  store.updateSettings({ features: { bulkMessaging: false } });
  assert.strictEqual(run(), 0, 'paused: nothing goes out');
  assert.strictEqual((await call(shop.app, 'campaign:get', { id: made.campaign.id })).campaign.counts.queued, 1);
  assert.strictEqual((await call(shop.app, 'campaign:create', { name: 'x', text: 'y', audience: 'list', to: ['ann'], ...OK })).code, 'feature_disabled');
  assert.ok((await call(ann.app, 'promo:set', { business: 'shop', receive: false })).ok, 'stopping always works');
  assert.deepStrictEqual((await call(ann.app, 'promo:list', {})).optedOut, ['shop']);
  store.updateSettings({ features: { bulkMessaging: true } });
  run();
  const rep = (await call(shop.app, 'campaign:get', { id: made.campaign.id })).campaign;
  assert.deepStrictEqual([rep.counts.failed, rep.counts.failedReasons.opted_out], [1, 1]);
  assert.ok((await call(ann.app, 'promo:set', { business: 'shop', receive: true })).ok);
  assert.strictEqual((await call(ann.app, 'promo:set', { business: 'shop', receive: 'no' })).code, 'invalid_request');
});

test('the CSV report defuses spreadsheet formulas; administrators can list and stop campaigns; erasing a person leaves only a count', async (t) => {
  const { store, app, person, shop, run } = await setup(t);
  await person('ann');
  await person('bob');
  const made = await call(shop.app, 'campaign:create', { name: '=HYPERLINK("x")', text: 'Hello', audience: 'list', to: ['ann', '=1+1', '+919800000099'], ...OK });
  const { csv, filename } = app.service.campaigns.actions.campaignCsv('shop', { id: made.campaign.id });
  assert.match(filename, /^campaign-[0-9a-f]+\.csv$/);
  assert.ok(csv.includes('"\'=1+1"') && !csv.includes(',"=1+1"'), 'a typed value that starts with = is quoted as text');
  assert.ok(csv.startsWith('﻿"Recipient","Name","Status"'));

  const listed = app.service.campaigns.adminList();
  assert.deepStrictEqual(listed.map((c) => [c.owner, c.name]), [['shop', '=HYPERLINK("x")']]);
  const stopped = app.service.campaigns.adminStop(made.campaign.id, 'root');
  assert.deepStrictEqual([stopped.status, stopped.stoppedBy], ['stopped', 'admin:root']);
  assert.strictEqual(run(), 0);
  assert.strictEqual((await call(shop.app, 'campaign:retry', { id: made.campaign.id })).code, 'conflict', 'a campaign an administrator stopped cannot be retried');

  const second = await call(shop.app, 'campaign:create', { name: 'Two', text: 'Hello', audience: 'list', to: ['bob'], ...OK });
  run();
  store.eraseAccount('bob');
  const row = store.data.campaigns[second.campaign.id].recipients[0];
  assert.deepStrictEqual([row.u, row.n], [null, undefined]);
  assert.strictEqual((await call(shop.app, 'campaign:get', { id: second.campaign.id })).campaign.counts.total, 1);
});

test('REST: the same campaign calls over HTTP, the CSV download, other people cannot see a campaign, and the admin routes', async (t) => {
  const { store, base, person, shop, run } = await setup(t);
  await person('ann');
  const other = store.register('rival', 'pass', 'Rival');
  const api = async (token, method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* csv */ }
    return { status: res.status, body: json, text, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition') };
  };
  const made = await api(shop.token, 'POST', '/campaigns', { name: 'Web', text: 'Hello over REST', audience: 'list', to: ['ann'], confirmed: true });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const id = made.body.campaign.id;
  run();
  const got = await api(shop.token, 'GET', `/campaigns/${id}?status=delivered`);
  assert.deepStrictEqual([got.status, got.body.recipients.total, got.body.recipients.items[0].to], [200, 1, 'ann']);
  assert.strictEqual((await api(shop.token, 'GET', '/campaigns/audience')).body.limits.recipients, 50);
  assert.strictEqual((await api(shop.token, 'GET', '/campaigns')).body.campaigns[0].counts.delivered, 1);
  const csv = await api(shop.token, 'GET', `/campaigns/${id}/report.csv`);
  assert.deepStrictEqual([csv.status, csv.type, /attachment; filename="campaign-/.test(csv.disposition)], [200, 'text/csv; charset=utf-8', true]);
  assert.ok(csv.text.includes('"ann","Ann","delivered"'));
  assert.strictEqual((await api(other.token, 'GET', `/campaigns/${id}`)).status, 404, 'not somebody else\'s');
  assert.strictEqual((await api(shop.token, 'POST', `/campaigns/${id}/cancel`)).status, 409, 'already finished');
  assert.strictEqual((await api(shop.token, 'DELETE', `/campaigns/${id}`)).status, 204);

  // People can stop a business over REST too.
  assert.strictEqual((await api(shop.token, 'PUT', '/me/promotions/rival', { receive: false })).status, 200);
  assert.deepStrictEqual((await api(shop.token, 'GET', '/me/promotions')).body.optedOut, ['rival']);
});

test('personal accounts can broadcast, but only to people they already chat with, with smaller limits; children cannot', async (t) => {
  const { store, person, run } = await setup(t);
  const zoe = await person('zoe');
  const amy = await person('amy');
  await person('ben'); // never chatted with zoe
  const kid = await person('kid');
  const dm = (await call(zoe.app, 'chat:direct', { username: 'amy' })).conversation;
  await call(zoe.app, 'message:send', { convId: dm.id, text: 'Hi Amy' });

  const aud = await call(zoe.app, 'campaign:audience', {});
  assert.deepStrictEqual([aud.business, aud.contacts, aud.limits.recipients, aud.limits.perDay], [false, 1, 20, 2]);
  const made = await call(zoe.app, 'campaign:create', { name: 'Party', text: 'Party on Saturday!', audience: 'list', to: ['amy', 'ben'], ...OK });
  assert.ok(made.ok, made.error);
  run();
  const rep = (await call(zoe.app, 'campaign:get', { id: made.campaign.id })).campaign;
  assert.deepStrictEqual([rep.counts.delivered, rep.counts.failed], [1, 1], 'ben is not someone zoe chats with: failed, like any other undeliverable name');
  assert.strictEqual(store.data.messages['dm:ben:zoe'], undefined);
  const msgs = (await call(amy.app, 'messages:get', { convId: dm.id })).messages;
  assert.deepStrictEqual([msgs[1].from, msgs[1].campaign], ['zoe', true]);

  const all = await call(zoe.app, 'campaign:create', { name: 'All', text: 'Hello all', audience: 'contacts', ...OK });
  assert.strictEqual(all.campaign.counts.total, 1, '"contacts" = the people zoe chats with');
  assert.strictEqual((await call(zoe.app, 'campaign:create', { name: 'x', text: 'y', audience: 'contacts', ...OK })).code, 'premium_required', 'free personal accounts: 2 a day');

  // Amy can stop broadcasts from zoe like anything else.
  await call(amy.app, 'promo:set', { business: 'zoe', receive: false });
  store.activateSubscription('zoe', { plan: 'monthly', expiresAt: Date.now() + 86400000 });
  const again = await call(zoe.app, 'campaign:create', { name: 'Again', text: 'Hello again', audience: 'contacts', ...OK });
  run();
  assert.deepStrictEqual((await call(zoe.app, 'campaign:get', { id: again.campaign.id })).campaign.counts.failedReasons, { opted_out: 1, not_delivered: 0 });

  store.data.users.kid.birthDate = `${new Date().getUTCFullYear() - 12}-01-01`;
  assert.strictEqual((await call(kid.app, 'campaign:create', { name: 'x', text: 'y', audience: 'list', to: ['amy'], ...OK })).code, 'adult_required');
});
