# Translation review pack (DPDP, Eighth Schedule languages)

One sheet per language: `review-<code>.csv` (opens in Excel or Google Sheets; UTF-8).

## For the translator
Columns: **No**, **English (original)**, **Current translation** (AI-prepared, not yet checked), **Corrected translation**, **Comment**.

1. Read the English and the current translation side by side. Check meaning first, legal accuracy second, wording third.
2. Fill **Corrected translation** only on rows that need a change. Leave it empty if the current text is right.
3. Keep every `{placeholder}` (for example `{company}`, `{brand}`, `{contactEmail}`) exactly as written, in Latin letters; the app fills them in. Keep numbers, ages and day counts the same as the English.
4. Use the script of the language that is customary for it (for Manipuri, Meitei Mayek; for Santali, Ol Chiki).
5. Use the Comment column for doubts.

Review first: brx, doi, ks, kok, mai, mni, sat, sd, sa. These are the weakest.

## For the operator
1. Apply a returned sheet: `node scripts/legal-i18n.js import <code> review-<code>.csv` (rows whose placeholders changed are skipped and listed).
2. Run `npm test`, commit `server/legal-i18n/<code>.json`.
3. When the translator has signed the whole language off, add its code to Admin → Settings → Legal → Reviewed languages (or `LEGAL_REVIEWED_LANGUAGES`). The "not yet checked" note disappears for that language.
4. If the English text changes, the changed sentences show in English until re-translated (`node scripts/legal-i18n.js missing`); re-export the sheet with `node scripts/legal-i18n.js export <code> docs/translation-review`.
