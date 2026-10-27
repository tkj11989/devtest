'use strict';

/**
 * Helper for the translations of the Privacy Notice, Terms, deletion page and sign-up notice (server/legal-i18n/<code>.json).
 *
 *   node scripts/legal-i18n.js source                 prints every English text with its number
 *   node scripts/legal-i18n.js build <code> <draft>   draft = JSON { "1": "translation of text 1", ... } -> legal-i18n/<code>.json
 *   node scripts/legal-i18n.js missing                lists texts that have no translation, per language
 *
 * Translations are stored by a hash of the exact English wording, so when a sentence changes its old translation is not used.
 */
const fs = require('fs');
const path = require('path');
const legal = require('../server/legal');

const src = legal.sourceStrings();
const dir = path.join(__dirname, '..', 'server', 'legal-i18n');
const [cmd, code, draftFile] = process.argv.slice(2);

if (cmd === 'source') {
  src.forEach((s, i) => console.log(`${i + 1}\t${s.replace(/\n/g, '\\n')}`));
} else if (cmd === 'build') {
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  const strings = {};
  const problems = [];
  const holes = (t) => (String(t).match(/\{[A-Za-z]+\}/g) || []).sort().join(',');
  src.forEach((en, i) => {
    const t = draft[String(i + 1)];
    if (typeof t !== 'string' || !t.trim()) { problems.push(`${i + 1}: missing`); return; }
    if (holes(t) !== holes(en)) problems.push(`${i + 1}: placeholders differ (${holes(en)} vs ${holes(t)})`);
    strings[legal.keyOf(en)] = t.replace(/\\n/g, '\n');
  });
  const extra = Object.keys(draft).filter((k) => !(Number(k) >= 1 && Number(k) <= src.length));
  if (extra.length) problems.push(`unknown ids: ${extra.join(', ')}`);
  console.log(`${code}: ${Object.keys(strings).length}/${src.length} texts` + (problems.length ? `, PROBLEMS:\n  ${problems.join('\n  ')}` : ''));
  if (problems.length) process.exit(1);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${code}.json`), `${JSON.stringify({ language: code, reviewed: false, strings }, null, 1)}\n`);
} else if (cmd === 'missing') {
  for (const l of legal.LANGUAGES.filter((x) => x.code !== 'en')) {
    const d = legal.dictionary(l.code);
    const miss = src.filter((s) => !d?.strings?.[legal.keyOf(s)]);
    console.log(`${l.code}\t${miss.length ? `${miss.length} missing` : 'complete'}`);
  }
} else {
  console.log('usage: node scripts/legal-i18n.js source | build <code> <draft.json> | missing');
}
