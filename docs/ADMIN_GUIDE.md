# KnowledgeVerse — Administrator Guide

Open `/admin/` on the same origin as the game. First run: create the administrator account (username + passphrase ≥ 8 chars; stored as a SHA-256 hash). Roles:

| Role | Sections |
|---|---|
| Administrator | everything |
| Content manager | Overview, Worlds, Missions, Questions, Quality & Reports, Daily Challenges |

> **Security note.** This build has no server. Sign-in is a browser-side gate suitable for local/demo use. For production, deploy `/admin/` behind real authentication (SSO / reverse-proxy auth) and move the content store to a database API with the same JSON shape (`app/js/contentStore.js`).

## Content workflow
1. **Questions → New**: choose world, category, difficulty, type (mcq, input, order, match; sort/lab/multi via JSON), text, instructions, answer(s), **explanation**, educational objective, optional image (≤150 KB) / audio URL, and *Debated* certainty for facts that experts disagree on.
2. The editor validates structure, requires an explanation, and **blocks duplicates** (same text + answer).
3. Built-in questions can be edited (saved as an override) or unpublished. Custom ones can be deleted.
4. **Quality & Reports** lists player reports, flagged/outdated questions (hidden from play until fixed), exact and near-duplicates, validation problems and a difficulty-coverage matrix.
5. **Daily Challenges**: schedule question IDs per date and slot, or leave empty for automatic seeded questions.
6. **Missions & Levels**: rename, change size (3–15), XP/coin rewards, publish/unpublish. **Worlds**: rename, taglines, extra categories, publish/unpublish. **Rewards**, **Difficulty** (adaptive thresholds, step cap).
7. **Publishing to players**: *Settings & Backup → Export content-overrides.json* and deploy it next to `index.html`. The game loads it at start without a rebuild. Translations follow the same path (`lang/<code>.json` UI strings).

## Advertising
Test mode ON by default with Google’s official test unit IDs. To go live: create AdMob app/units, paste IDs, turn test mode off, add App IDs to the native projects. Frequency caps (every N missions, min seconds) are enforced in-app. Import an AdMob CSV report to see revenue by format/country, eCPM and fill rate; nothing is estimated.

## Analytics & users
Counters (sessions, missions, answers, play time, popular worlds, feedback, reports, ad events) are measured **on-device**. Aggregating across players needs a backend that receives the same anonymous counters.

## Moderation
Hide leaderboard entries by nickname/score. Remove admin accounts under Users.

## Adding a brand-new world
Create `app/js/content/<world>.js` exporting `cats`, `bank`, optional `gen`, `alt`, `boss`, `titles`; register it in `app/js/content/index.js` (`WORLDS`). Run `npm test` — the validator checks every mission builds valid questions.
