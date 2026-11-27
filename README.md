# Mutual App Testing Platform

Implements the *Mutual App Testing Platform – Product & Technical Spec*: free Android app where developers get
18 testers for a 16-day closed test by testing others' apps. Flutter + Firebase + AdMob.

- `functions/` – Cloud Functions (TypeScript). All platform rules run here in Firestore transactions.
  - `src/logic.ts` pure rules (join checks, state machine, drop/reward) – unit tested: `cd functions && npm test`
  - `src/index.ts` callables (`ensureUser`, `createPool`, `joinPool`, `leavePool`, `cancelPool`, `confirmInstalled`,
    `dailyCheckIn`, `submitFeedback`, `updateChecklist`, `claimRewardedAd`, `fileReport`), `dailySweep` schedule,
    `processGroupQueue` (Directory API group add/remove with retries)
- `firestore.rules` – clients read-only for balances/pools/members; opt-in links in owner-only `appSecrets`
- `app/` – Flutter app (browse, pool detail/join, my tests with check-in/feedback, my apps + setup checklist, credits)

## Setup
1. `firebase init`-link a project; enable Google sign-in, Firestore, Functions (Blaze).
2. Copy `functions/.env.example` to `functions/.env` with the platform Google Group and a Workspace admin to impersonate
   (service account needs domain-wide delegation for `admin.directory.group.member`).
3. Optionally seed `config/limits` with `{rewardedAdCredits, rewardedAdDailyCap}`.
4. `cd app && flutterfire configure && flutter run`; replace AdMob test IDs before release.

## Decisions where the spec was ambiguous
- Credit is **deducted at pool creation** and refunded on cancel/fail (spec says both "when created" and "when it opens").
- Replacements may join a running pool only until day 2 (later joiners could not stay opted in long enough).
- A tester earns credit with ≥12 check-ins and both feedback forms; dropped after 3 consecutive missed days.
- Not verified here: Flutter app (no SDK in this environment), rules emulator tests, live Directory API.

## Run locally (Firebase Emulator Suite, no cloud)
Needs Java 21+ for the emulators (Android Studio's bundled JBR works).
```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
npm --prefix functions install; npm --prefix functions run build
firebase emulators:start --import=./emulator-data --export-on-exit=./emulator-data
npm --prefix functions run seed        # second terminal: demo developers, apps, pools
cd app; flutter run                    # debug builds talk to the emulators at 10.0.2.2
```
Sign in with any email and password `password` (dev1/dev2/dev3@test.local own the demo apps).
Emulator UI: http://127.0.0.1:4000. Build with `--dart-define=USE_EMULATOR=false` to use the real project.

## Install period (no opt-in link)
Pool states: `filling` → `installing` → `running` / `at_risk` → `complete` / `failed`.
- When a pool has 18 testers (and the developer's checklist is done), it enters `installing` with a buffer timer:
  `installDeadline = now + config/limits.installBufferHours` (default 24 h).
- The app checks the phone for the package (Android `getLaunchIntentForPackage`) when My tests opens, every 20 s
  while it is open, and when the tester returns from the Play Store. If found, it calls `confirmInstalled`; the
  backend stores the install status (`poolMembers.status = installed`, `installedAt`, `pools.installedCount`).
- Day 1 starts as soon as all 18 have installed, or when the timer ends with at least 12 installed. Testers who
  never installed are released (no penalty). With fewer than 12 installed the pool reopens (`filling`) and the
  installed testers keep their place.
- Deadlines are settled by `installSweep` (every 10 min) and by `refreshPool`, which the app calls when it sees an
  expired timer (the emulator does not run scheduled functions).
- A replacement who joins a running pool also installs first; their 24-hour days count from their own install.

## Daily testing rules
- **Package limit per user:** a tester can be in `maxTesterPools` packages at once. The platform default lives in
  `config/limits.maxTesterPools` (2); setting `maxTesterPools` on a `users/{uid}` doc overrides it for that user
  (edit it in the Emulator UI or Firebase console).
- **24-hour days:** each tester's Day 1 starts at the pool start, or at their own install if they joined later;
  Day N+1 starts exactly 24 h after Day N. One recorded test per day.
- **30-second test:** "Test app" calls `startTestSession` (server-stamped start), opens the app by package name,
  and on return `finishTestSession` records the day only if 30 s or more have passed. Shorter tries keep the
  session open so the tester can continue.
