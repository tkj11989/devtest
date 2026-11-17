# KnowledgeVerse – Product Analysis, Plan & Checklist

> One Game. Multiple Learning Worlds.

## 0. Technology decision

| Concern | Decision | Why |
|---|---|---|
| Client | **Offline-first Progressive Web App**: vanilla ES modules, CSS and SVG, no build step | Runs in any mobile browser, installable, instantly testable, nothing to compile |
| Android / iOS | **Capacitor** wrapper (`capacitor.config.json`, `package.json` included) | One codebase → signed AAB / IPA; native AdMob via `@capacitor-community/admob` |
| Persistence | `localStorage` with versioned, validated save + atomic write + backup slot | Works offline; progress survives interruption |
| Content | JS content modules + generators, plus **content overrides** edited by the admin tool | Content changes without rebuilding the game code |
| Admin | Separate `/admin` app, role-based (admin / content manager) | Separate entry point, shares the same content store |
| Sounds | WebAudio synthesis (no asset downloads) | Tiny, offline, separate music/SFX toggles |

**Honest limitation:** there is no server in this repository. Players, analytics and the admin store are
per-device (`localStorage`). Cross-device accounts, global leaderboards, multi-user admin and AdMob revenue
reporting need a backend – see *Dependencies & risks* and `docs/ADMIN_GUIDE.md`. Nothing in the UI invents
numbers: every statistic shown is measured from real play on the device, and revenue shows "not connected".

## 1. Requirements analysis (summary)

Eight worlds × (5 difficulty tiers × 2 missions + 1 boss) = 88 missions; 14 interaction mechanics; XP / coins /
stars / achievements / streaks; daily challenge (4 slots); Knowledge Challenge (mixed); optional competition;
adaptive difficulty; content management; admin dashboard; AdMob with strict ethics; child safety & privacy;
accessibility; sounds; i18n; offline/reliability.

## 2. Sitemap

```
Splash → (first run) Onboarding[name → age → language → interests → difficulty → avatar] → Home
Home (tab bar: Home · Map · Daily · Rank · Me)
├─ Home Dashboard: avatar/level/XP/coins/streak, Continue, Daily mission, Recommended world,
│                  mini-map, recent missions, achievements preview, Knowledge Challenge entry
├─ World Map ─ World Dashboard ─ Mission Select (tiers, stars, boss) ─ Gameplay ─ Results ─ (Rewards)
├─ Daily Challenges (4 slots, streak, login reward) ─ Gameplay ─ Results
├─ Knowledge Challenge (Quick / Standard / Expert) ─ Gameplay ─ Subject breakdown results
├─ Leaderboard (personal bests, subject ranks, weekly, friend-challenge codes)
├─ Me: Profile · Statistics · Rewards & Achievements · Settings (audio, motion, text size, difficulty,
│      language, currency, parental controls, privacy, delete data) · Help & Support
└─ Parental gate (PIN) guards: social, rewarded ads, settings lock, time limit
Admin (separate URL): Login → Overview · Worlds · Missions · Questions (+reports, quality, duplicates)
      · Daily schedule · Rewards · Difficulty · Users · Leaderboard moderation · Ads · Analytics · Settings
```

## 3. Player journey

First launch → 5-step onboarding (guest allowed, nickname only) → Home with a clear "next step" card
(Continue / first mission) → pick an unlocked world → complete missions in order (stars, XP, coins) →
level up unlocks further worlds → daily challenge + streak creates a reason to return → bosses finish a world →
Knowledge Challenge + friend codes for replay value. Struggle → easier practice + explanations; mastery → gradual
increase.

## 4. Gameplay loop per world

| World | Loop (mission → challenge → reward) | Mechanics used | Boss |
|---|---|---|---|
| Math Kingdom | open castle gates → repair bridges → calculation missions | number input, sequence ("bridge"), MCQ, matching, ordering, algebra | 8 hard puzzles in a row |
| Word Kingdom | find hidden words → unscramble → build sentences → fix grammar | word hunt, letter arrangement, sentence arrangement, fill blank, correction | correct 6 sentences |
| Science Planet | identify → match function → run experiment | image ID, matching, sorting (drag), lab experiment, ordering | experiment challenge |
| Geography World | locate on map → flags → capitals → landmarks | map tap, flag/image ID, matching, sorting, timed | 8 map locations under time limit |
| History Land | identify people → order events → solve mystery | chronological ordering, MCQ, mystery clues, matching | multi-clue mystery |
| Space Galaxy | identify bodies → missions → astronomy | image ID, ordering, lab "mission builder", MCQ | planetary exploration mission |
| Logic Castle | memory → patterns → deduction → locks | memory, sequence, matrix, deduction, combination lock | lock + deduction chamber |
| Money City | change → discounts → budget → decisions | number input, multi-select budget, MCQ, sorting needs/wants | budget management |

## 5. Screen inventory

Splash · Onboarding ×5 steps · Home · World Map · World Dashboard · Mission Select · Mission Briefing ·
Gameplay (13 question renderers) · Results · Level-up/reward overlay · Achievements · Daily Challenges ·
Login-reward overlay · Knowledge Challenge setup · Leaderboard · Statistics · Profile · Settings · Parental
controls · Privacy / delete data · Help & Support · Interstitial / rewarded ad overlays (test) · Parental gate ·
Admin: Login, Overview, Worlds, Missions, Questions, Question editor, Quality review, Daily schedule, Rewards,
Difficulty, Users, Moderation, Ads, Analytics, Settings.

## 6. Design language

* Modern cartoon-adventure: chunky rounded cards (radius 22 px), thick soft shadows, glossy gradient buttons.
* Typeface: system rounded stack (`ui-rounded, "Nunito", "Segoe UI", system-ui`), 18 px base, 3 text sizes.
* Each world has its own palette + SVG/emoji scenery: Math purple/gold, Word green/amber forest-library,
  Science blue/teal lab, Geography green/blue map, History sand/terracotta, Space indigo/pink nebula,
  Logic slate/violet castle, Money orange/teal city.
* Motion: springy transitions, confetti rewards; fully disabled by `prefers-reduced-motion` / setting.
* Accessibility: 44 px minimum targets, AA contrast on text, labels on icon buttons, focus rings,
  never colour-only feedback (✓ / ✗ icons), screen-reader live regions for feedback.

## 7. Phased checklist

Legend: ✅ done & tested · 🟡 done, needs native/backend to complete · ⬜ not started

### Phase 1 – Foundation
- ✅ App structure, router, design system, state store with validated/atomic saves
- ✅ Splash, onboarding (nickname, age, language, interests, difficulty, avatar), guest play
- ✅ Profile, Home dashboard, world map with unlock requirements

### Phase 2 – MVP worlds
- ✅ Math Kingdom, ✅ Word Kingdom, ✅ Logic Castle (all 11 missions each, boss included)

### Phase 3 – Core systems
- ✅ Mission engine (13 renderers), question engine (generators + banks, seeded), adaptive difficulty
- ✅ XP/levels/coins/stars, idempotent rewards, achievements, daily challenges + streak, login rewards
- ✅ Knowledge Challenge (Quick/Standard/Expert), resume interrupted mission

### Phase 4 – Additional worlds
- ✅ Science Planet, Geography World, History Land, Space Galaxy, Money City

### Phase 5 – Administration
- ✅ Role-based admin: question CRUD, import/export, duplicate & quality checks, flag outdated, world/mission/
  reward/difficulty config, daily schedule, users (local), moderation, analytics (measured)
- 🟡 Multi-admin, server auth and cross-device user data need a backend

### Phase 6 – Monetization
- ✅ Ad manager: test IDs, banner/interstitial/rewarded, frequency caps, verified rewards, child-directed flag
- 🟡 Native AdMob plugin binding (Capacitor) + real unit IDs + revenue report import need a device build / AdMob account

### Phase 7 – Quality & launch
- ✅ Automated tests (`node tests/run.mjs`), content validator, browser smoke test, docs
- 🟡 Real-device compatibility, store policy review, signing → `docs/RELEASE_CHECKLIST.md`

## 8. Dependencies & risks

| Risk | Mitigation |
|---|---|
| No backend → no global leaderboard/accounts/revenue | Local/optional features, friend codes (seeded challenges, no personal data), documented backend contract |
| Child-directed ad policy (COPPA, Play Families, Apple Kids) | Child-directed flag + max-content-rating G for under-13, no personalised ads, parental gate before external/rewarded features, no social chat |
| Educational accuracy | Bank questions authored with explanations, `debated` history flag, admin "flag outdated" workflow, validator in CI |
| Progress loss / duplicate rewards | Versioned save + backup slot, idempotent reward keys, resumable mission session |
| Flag emoji not rendered on some desktop OS | Always shown with country name option; mobile OSes render them |
| Native build can't be produced in this environment | Capacitor config + step-by-step in release checklist |
