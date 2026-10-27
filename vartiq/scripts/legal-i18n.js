'use strict';

/**
 * Helper for the translations of the Privacy Notice, Terms, deletion page and sign-up notice (server/legal-i18n/<code>.json).
 *
 *   node scripts/legal-i18n.js source                 prints every English text with its number
 *   node scripts/legal-i18n.js build <code> <draft>   draft = JSON { "1": "translation of text 1", ... } -> legal-i18n/<code>.json
 *   node scripts/legal-i18n.js missing                lists texts that have no translation, per language
 *   node scripts/legal-i18n.js export <code|all> [dir]  review sheet (CSV, opens in Excel) for a translator: English, current text, a column for corrections
 *   node scripts/legal-i18n.js import <code> <sheet.csv> applies the corrections a translator typed in the "Corrected translation" column (placeholders checked)
 *
 * Translations are stored by a hash of the exact English wording, so when a sentence changes its old translation is not used.
 */
const fs = require('fs');
const path = require('path');
const legal = require('../server/legal');

const src = legal.sourceStrings();
const dir = path.join(__dirname, '..', 'server', 'legal-i18n');
const [cmd, code, draftFile] = process.argv.slice(2);

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const holesOf = (t) => (String(t).match(/\{[A-Za-z]+\}/g) || []).sort().join(',');

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
} else if (cmd === 'export') {
  const out = draftFile || path.join(__dirname, '..', 'legal-review');
  const list = code === 'all' ? legal.LANGUAGES.filter((x) => x.code !== 'en') : legal.LANGUAGES.filter((x) => x.code === code);
  if (!list.length) { console.log('unknown language code'); process.exit(1); }
  fs.mkdirSync(out, { recursive: true });
  for (const l of list) {
    const d = legal.dictionary(l.code);
    const lines = [['No', 'English (original)', `Current translation (${l.name || l.code})`, 'Corrected translation (fill only where a change is needed)', 'Comment'].map(csvCell).join(',')];
    src.forEach((en, i) => lines.push([i + 1, en, d?.strings?.[legal.keyOf(en)] || '', '', ''].map(csvCell).join(',')));
    fs.writeFileSync(path.join(out, `review-${l.code}.csv`), `\uFEFF${lines.join('\r\n')}\r\n`);
    console.log(`${l.code}: ${path.join(out, `review-${l.code}.csv`)}`);
  }
} else if (cmd === 'import') {
  const file = path.join(dir, `${code}.json`);
  const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = parseCsv(fs.readFileSync(draftFile, 'utf8').replace(/^\uFEFF/, '')).slice(1);
  let changed = 0;
  const problems = [];
  for (const r of rows) {
    const n = Number(r[0]);
    const fixed = (r[3] || '').trim();
    if (!fixed) continue;
    const en = src[n - 1];
    if (!en) { problems.push(`${r[0]}: unknown number`); continue; }
    if (holesOf(fixed) !== holesOf(en)) { problems.push(`${n}: placeholders differ (${holesOf(en) || 'none'} vs ${holesOf(fixed) || 'none'})`); continue; }
    dict.strings[legal.keyOf(en)] = fixed;
    changed++;
  }
  console.log(`${code}: ${changed} corrections applied` + (problems.length ? `, SKIPPED:\n  ${problems.join('\n  ')}` : ''));
  fs.writeFileSync(file, `${JSON.stringify(dict, null, 1)}\n`);
  console.log('Now add the code to Reviewed languages once the translator has signed the whole text off.');
} else {
  console.log('usage: node scripts/legal-i18n.js source | build <code> <draft.json> | missing | export <code|all> [dir] | import <code> <sheet.csv>');
}
