'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { Store } = require('../server/store');
const legal = require('../server/legal');

const EIGHTH_SCHEDULE = ['as', 'bn', 'brx', 'doi', 'gu', 'hi', 'kn', 'ks', 'kok', 'mai', 'ml', 'mni', 'mr', 'ne', 'or', 'pa', 'sa', 'sat', 'sd', 'ta', 'te', 'ur'];
const PLACEHOLDER = /\{[A-Za-z]+\}/g;

async function setup(t, opts = {}) {
  const store = new Store({ file: null });
  const sms = [];
  const app = createApp({ store, otp: { sender: async (m) => { sms.push(m); }, resendMs: 0 }, translate: { sandbox: true }, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  t.after(() => { app.io.close(); app.server.close(); });
  const api = async (method, p, { token, body, raw } = {}) => {
    const res = await fetch(`${base}${raw ? '' : '/api/v1'}${p}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* html */ }
    return { status: res.status, body: parsed, text };
  };
  return { api, store, sms };
}

test('legal i18n: all 22 Eighth Schedule languages are offered and complete', () => {
  assert.deepStrictEqual(legal.LANGUAGES.filter((l) => l.code !== 'en').map((l) => l.code).sort(), [...EIGHTH_SCHEDULE].sort());
  const source = legal.sourceStrings();
  assert.ok(source.length > 250);
  for (const code of EIGHTH_SCHEDULE) {
    const dict = legal.dictionary(code);
    assert.ok(dict, `${code} has a translation file`);
    for (const text of source) {
      const out = dict.strings[legal.keyOf(text)];
      assert.ok(out && /\S/.test(out), `${code}: missing translation of "${text.slice(0, 40)}"`);
      assert.deepStrictEqual((out.match(PLACEHOLDER) || []).sort(), (text.match(PLACEHOLDER) || []).sort(), `${code}: placeholders changed in "${text.slice(0, 40)}"`);
    }
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'server', 'legal-i18n', `${code}.json`), 'utf8').includes('�'), `${code}: broken characters`);
  }
});

test('legal i18n: pages and data are served per language, right-to-left where needed, with the review note', async (t) => {
  const { api, store } = await setup(t);
  for (const code of EIGHTH_SCHEDULE) {
    const page = await api('GET', `/legal/privacy?lang=${code}`, { raw: true });
    assert.strictEqual(page.status, 200, code);
    assert.match(page.text, new RegExp(`<html lang="${code}" dir="${['ks', 'sd', 'ur'].includes(code) ? 'rtl' : 'ltr'}"`), code);
    assert.ok(!/\{[A-Za-z]+\}/.test(page.text), `${code}: a placeholder was left unfilled`);
    assert.ok(page.text.includes(legal.tr(legal.UI_TEXT.translationNote, code)), `${code}: shows the "not yet checked" note`);
  }
  const hi = (await api('GET', '/legal/privacy?lang=hi')).body;
  assert.strictEqual(hi.language, 'hi');
  assert.notStrictEqual(hi.title, 'Privacy Notice');
  assert.strictEqual((await api('GET', '/legal/privacy?lang=xx')).body.language, 'en', 'unknown language falls back to English');
  const en = await api('GET', '/legal/privacy', { raw: true });
  assert.ok(!en.text.includes(legal.UI_TEXT.translationNote));

  const summary = (await api('GET', '/legal?lang=ta')).body;
  assert.strictEqual(summary.language, 'ta');
  assert.strictEqual(summary.version, legal.VERSION);
  assert.strictEqual(summary.languages.length, 23);
  assert.ok(summary.consents.every((c) => !/\{[A-Za-z]+\}/.test(c.text)));
  assert.notStrictEqual(summary.consents[0].text, (await api('GET', '/legal')).body.consents[0].text);
  assert.ok(summary.documents[0].url.endsWith('?lang=ta'));

  // The operator can mark a language as checked: the note goes away.
  store.updateSettings({ legal: { reviewedLanguages: 'hi' } });
  const checked = await api('GET', '/legal/privacy?lang=hi', { raw: true });
  assert.ok(!checked.text.includes(legal.tr(legal.UI_TEXT.translationNote, 'hi')));
  assert.ok((await api('GET', '/legal/privacy?lang=bn', { raw: true })).text.includes(legal.tr(legal.UI_TEXT.translationNote, 'bn')));
});

test('legal i18n: the language a person read is recorded with their acceptance', async (t) => {
  const { api, store, sms } = await setup(t);
  const phone = '+919876500111';
  const sent = (await api('POST', '/auth/otp', { body: { purpose: 'register', phone } })).body;
  const proof = { requestId: sent.requestId, code: sms.filter((m) => m.purpose === 'register').pop().code };
  const res = await api('POST', '/auth/register', { body: { birthDate: '1990-05-17', displayName: 'Meera', phone, phoneOtp: proof, consent: { terms: true, version: legal.VERSION, lang: 'hi' } } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const c = store.consentOf(res.body.user.username);
  assert.strictEqual(c.lang, 'hi');
  assert.strictEqual(c.history[0].lang, 'hi');
  assert.ok(c.accepted.includes('terms'));
});

test('legal i18n: admin can only list real language codes as reviewed', async (t) => {
  const { store } = await setup(t);
  assert.throws(() => store.updateSettings({ legal: { reviewedLanguages: 'hi,zz' } }), /unknown language code zz/);
  store.updateSettings({ legal: { reviewedLanguages: 'hi, ta' } });
  assert.deepStrictEqual(legal.details(store.getSettings()).reviewedLanguages, ['hi', 'ta']);
});
