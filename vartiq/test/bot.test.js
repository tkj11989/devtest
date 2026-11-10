'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const bot = require('../server/bot');

const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = {
  enabled: true,
  rules: [
    { keywords: ['price', 'cost', 'how much'], reply: 'Our price list: https://example.com/prices' },
    { keywords: ['पता'], reply: 'हमारा पता: मुख्य बाज़ार' },
  ],
  menu: { enabled: true, keywords: ['menu'], intro: 'How can we help?', items: [{ label: 'Opening hours', reply: 'Mon-Sat 9 to 6' }, { label: 'Delivery', reply: 'We deliver in 2 days' }] },
  handoff: { enabled: true, keywords: ['agent'], reply: 'A person will reply soon.', pauseHours: 8 },
  fallback: { enabled: false, text: '' },
};

test('matching: words next to each other, capitals and punctuation do not matter, other scripts work', () => {
  const b = bot.normalise(SETUP, { maxRules: 5 });
  assert.strictEqual(bot.answer(b, 'What is the PRICE??')?.kind, 'rule');
  assert.strictEqual(bot.answer(b, 'how   much is it')?.text, 'Our price list: https://example.com/prices');
  assert.strictEqual(bot.answer(b, 'how is much')?.kind, undefined, 'the words of a phrase must be next to each other, in order');
  assert.strictEqual(bot.answer(b, 'pricey things'), null, 'a keyword is a whole word, not a part of one');
  assert.strictEqual(bot.answer(b, 'आपका पता क्या है?')?.text, 'हमारा पता: मुख्य बाज़ार');
  assert.strictEqual(bot.answer(b, 'hello'), null, 'nothing matched and no fallback: silence');
  assert.strictEqual(bot.answer({ ...b, enabled: false }, 'price'), null);
  assert.strictEqual(bot.answer(b, '   '), null);
});

test('matching: the menu, a number only picks an item right after the menu, and handing over comes first', () => {
  const b = bot.normalise(SETUP, { maxRules: 5 });
  const menu = bot.answer(b, 'Menu please');
  assert.deepStrictEqual([menu.kind, menu.auto, menu.text], ['menu', 'bot-menu', 'How can we help?\n1. Opening hours\n2. Delivery']);
  assert.strictEqual(bot.answer(b, '2', { afterMenu: true }).text, 'We deliver in 2 days');
  assert.strictEqual(bot.answer(b, '2'), null, 'a bare number means nothing without the menu');
  assert.strictEqual(bot.answer(b, '7', { afterMenu: true }), null, 'there is no item 7');
  const h = bot.answer(b, 'I want an agent, what is the price?');
  assert.deepStrictEqual([h.kind, h.pauseHours], ['handoff', 8]);

  const withFallback = bot.normalise({ ...SETUP, fallback: { enabled: true, text: 'Sorry, I did not get that. Type menu.' } }, { maxRules: 5 });
  assert.strictEqual(bot.answer(withFallback, 'blah').kind, 'fallback');
  assert.strictEqual(bot.answer(withFallback, 'blah', { fallbackOk: false }), null, 'the fallback is not repeated');
});

test('setup checks: every problem says what to fix; free accounts get fewer rules', () => {
  const bad = (input, re, opts) => assert.throws(() => bot.normalise(input, opts || { maxRules: 5 }), re);
  bad({ enabled: true }, /at least one rule/);
  bad({ rules: [{ keywords: [], reply: 'x' }] }, /needs at least one keyword/);
  bad({ rules: [{ keywords: ['a'], reply: '' }] }, /needs a reply/);
  bad({ rules: [{ keywords: ['!!!'], reply: 'x' }] }, /no letters or numbers/);
  bad({ rules: [{ keywords: ['a'.repeat(41)], reply: 'x' }] }, /too long/);
  bad({ rules: [{ keywords: ['a'], reply: 'x'.repeat(1001) }] }, /too long/);
  bad({ rules: Array.from({ length: 6 }, () => ({ keywords: ['a'], reply: 'x' })) }, /You can have 5 rules/);
  bad({ menu: { enabled: true, items: [] } }, /at least one menu item/);
  bad({ menu: { enabled: true, keywords: [], items: [{ label: 'a', reply: 'b' }] } }, /word that shows the menu/);
  bad({ menu: { items: Array.from({ length: 10 }, () => ({ label: 'a', reply: 'b' })) } }, /at most 9/);
  bad({ handoff: { enabled: true, pauseHours: 5 } }, /stay quiet for/);
  bad({ fallback: { enabled: true, text: '' } }, /needs text/);
  assert.strictEqual(bot.normalise({ rules: Array.from({ length: 6 }, () => ({ keywords: ['a'], reply: 'x' })) }, { maxRules: 30 }).rules.length, 6);
  assert.deepStrictEqual(bot.normalise({}, { maxRules: 5 }).menu.keywords, ['menu', 'help'], 'sensible defaults');
});

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
  const shopReg = store.register('shop', 'pass', 'Corner Shop');
  store.setContact('shop', 'sms', '+919800000001');
  store.setContact('shop', 'email', 'hi@shop.example');
  const shop = await client(shopReg.token);
  assert.ok((await call(shop, 'business:set', { category: 'Retail' })).ok);
  const cust = async (name) => { const r = store.register(name, 'pass', name); const s = await client(r.token); const dm = (await call(s, 'chat:direct', { username: 'shop' })).conversation; return { s, dm, token: r.token }; };
  const thread = async (c) => (await call(c.s, 'messages:get', { convId: c.dm.id })).messages;
  return { store, app, base, shop, client, cust, thread, shopToken: shopReg.token };
}

test('a customer chats with the assistant: rules, the menu, hand-over, then silence; replies are marked Automated', async (t) => {
  const { shop, cust, thread } = await setup(t);
  const saved = await call(shop, 'bot:set', SETUP);
  assert.ok(saved.ok, saved.error);
  assert.strictEqual(saved.user.business.assistant, true, 'everyone can tell the assistant is on');
  assert.ok(!('bot' in saved.user.business), 'but not what it says');

  const ann = await cust('ann');
  await call(ann.s, 'message:send', { convId: ann.dm.id, text: 'What is the PRICE?' });
  let msgs = await thread(ann);
  assert.deepStrictEqual(msgs.map((m) => [m.from, m.auto || null]), [['ann', null], ['shop', 'bot']]);
  assert.strictEqual(msgs[1].text, 'Our price list: https://example.com/prices');

  await call(ann.s, 'message:send', { convId: ann.dm.id, text: 'Something nobody planned for' });
  assert.strictEqual((await thread(ann)).length, 3, 'no match, no fallback: no reply');

  await call(ann.s, 'message:send', { convId: ann.dm.id, text: 'menu' });
  await call(ann.s, 'message:send', { convId: ann.dm.id, text: '1' });
  msgs = await thread(ann);
  assert.deepStrictEqual(msgs.slice(-3).map((m) => [m.auto || null, m.text]), [['bot-menu', 'How can we help?\n1. Opening hours\n2. Delivery'], [null, '1'], ['bot', 'Mon-Sat 9 to 6']]);

  await call(ann.s, 'message:send', { convId: ann.dm.id, text: 'agent' });
  assert.strictEqual((await thread(ann)).at(-1).text, 'A person will reply soon.');
  const before = (await thread(ann)).length;
  await call(ann.s, 'message:send', { convId: ann.dm.id, text: 'price?' });
  assert.strictEqual((await thread(ann)).length, before + 1, 'after hand-over the assistant stays quiet in this chat');

  // Another customer is unaffected by ann's hand-over.
  const bob = await cust('bob');
  await call(bob.s, 'message:send', { convId: bob.dm.id, text: 'price' });
  assert.strictEqual((await thread(bob)).length, 2);
});

test('a person of the business answering keeps the assistant out of the chat for an hour', async (t) => {
  const { shop, cust, thread } = await setup(t);
  await call(shop, 'bot:set', SETUP);
  const ann = await cust('ann');
  await call(ann.s, 'message:send', { convId: ann.dm.id, text: 'hello' });
  await call(shop, 'message:send', { convId: ann.dm.id, text: 'Hi Ann, this is Ravi, how can I help?' });
  await call(ann.s, 'message:send', { convId: ann.dm.id, text: 'what is the price' });
  assert.deepStrictEqual((await thread(ann)).map((m) => m.from), ['ann', 'shop', 'ann'], 'a person is talking: no assistant');
});

test('limits: at most 20 assistant answers an hour in one chat; only plain customer text; nothing when switched off', async (t) => {
  const { store, shop, cust, thread } = await setup(t);
  await call(shop, 'bot:set', SETUP);
  const ann = await cust('ann');
  for (let i = 0; i < 24; i++) await call(ann.s, 'message:send', { convId: ann.dm.id, text: 'price' });
  const bots = (await thread(ann)).filter((m) => m.auto === 'bot').length;
  assert.strictEqual(bots, 20);

  const bob = await cust('bob');
  await call(bob.s, 'message:send', { convId: bob.dm.id, text: 'Where?', masked: true });
  store.updateSettings({ features: { businessBot: false } });
  await call(bob.s, 'message:send', { convId: bob.dm.id, text: 'price' });
  assert.strictEqual((await thread(bob)).length, 2, 'administrator switched the assistant off: silence');
  assert.strictEqual((await call(shop, 'bot:set', SETUP)).code, 'feature_disabled');
  const view = await call(bob.s, 'user:get', { username: 'shop' });
  assert.ok(!view.user.business.assistant, 'switched off: apps go back to encrypting chats with it');
  store.updateSettings({ features: { businessBot: true } });
});

test('the assistant and the profile: saving the profile keeps it, the owner sees everything, free accounts get 5 rules, only business accounts', async (t) => {
  const { store, shop, client } = await setup(t);
  await call(shop, 'bot:set', SETUP);
  const again = await call(shop, 'business:set', { category: 'Retail', description: 'Changed' });
  assert.ok(again.ok);
  const mine = await call(shop, 'bot:get', {});
  assert.deepStrictEqual([mine.bot.enabled, mine.bot.rules.length, mine.limits.rules, mine.available], [true, 2, 5, true]);

  const many = { ...SETUP, rules: Array.from({ length: 6 }, (_, i) => ({ keywords: [`k${i}`], reply: 'x' })) };
  assert.strictEqual((await call(shop, 'bot:set', many)).code, 'premium_required');
  store.activateSubscription('shop', { plan: 'monthly', expiresAt: Date.now() + 86400000 });
  assert.ok((await call(shop, 'bot:set', many)).ok);

  const pers = store.register('pat', 'pass', 'Pat');
  const patApp = await client(pers.token);
  assert.strictEqual((await call(patApp, 'bot:get', {})).code, 'business_required');
  assert.strictEqual((await call(patApp, 'bot:set', SETUP)).code, 'business_required');
});

test('try it: what the assistant would say, for the saved setup or one still on screen; nothing is sent', async (t) => {
  const { shop, thread, cust } = await setup(t);
  assert.strictEqual((await call(shop, 'bot:test', { text: 'price' })).code, 'invalid_request', 'nothing saved yet');
  const onScreen = await call(shop, 'bot:test', { text: 'price', config: SETUP });
  assert.deepStrictEqual(onScreen.reply, { kind: 'rule', text: 'Our price list: https://example.com/prices' });
  assert.strictEqual((await call(shop, 'bot:test', { text: '2', afterMenu: true, config: SETUP })).reply.text, 'We deliver in 2 days');
  assert.strictEqual((await call(shop, 'bot:test', { text: 'zzz', config: SETUP })).reply, null);
  assert.strictEqual((await call(shop, 'bot:test', { text: 'x', config: { rules: [{ keywords: [], reply: 'x' }] } })).code, 'invalid_request');
  const ann = await cust('ann');
  assert.strictEqual((await thread(ann)).length, 0);
});

test('REST: get, save and try the assistant over HTTP', async (t) => {
  const { base, shopToken, store } = await setup(t);
  const api = async (method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${shopToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  assert.strictEqual((await api('GET', '/me/business/bot')).body.bot.enabled, false);
  const put = await api('PUT', '/me/business/bot', SETUP);
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  assert.strictEqual(put.body.user.business.assistant, true);
  assert.strictEqual((await api('PUT', '/me/business/bot', { enabled: true })).status, 400);
  const tried = await api('POST', '/me/business/bot/test', { text: 'cost' });
  assert.deepStrictEqual([tried.status, tried.body.reply.kind], [200, 'rule']);
  assert.strictEqual(store.getBusiness('shop').bot.rules.length, 2);
});
