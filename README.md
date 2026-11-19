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
