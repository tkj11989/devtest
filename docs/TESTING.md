# Testing documentation

## Automated
| Suite | Command | Covers |
|---|---|---|
| Rules & content | `npm test` (49 tests) | 8 worlds / 88 missions; every static question structurally valid, unique, has explanation; every mission builds valid questions across 12 seeds each; generators valid at all difficulties; math answers integral; logic locks have exactly one solution (brute-force verified); levels, unlocks, stars, rewards **idempotency**, replay payouts, streak/login/daily logic with injected clock, adaptive difficulty bounds, mistake review, Knowledge Challenge mixes & determinism, friend codes, save sanitiser & backup recovery, admin overrides |
| UI smoke | `npm run test:browser` | Onboarding validation; all 11 renderers solved through the real DOM; full mission through UI with 3 stars; reload mid-mission resumes without re-asking; all routes render; no console errors |
| Admin | `tests/admin_smoke.mjs` | Account creation/weak passphrase; all 13 tabs; question create/validate/duplicate block; custom question reaches the game; content-manager role restrictions |
| Ads | `tests/ads_flow.mjs` | Rewarded reward only after full view; skipped ad gives nothing; verified completion recorded once; no ad in gameplay; parental disable hides offers |

## Manual test matrix (to run before release)
| Area | Checks |
|---|---|
| Devices | Android 8+ (small & large phones, tablet), iOS 15+ (iPhone SE, Pro Max, iPad), landscape lock off |
| Interruption | Kill app mid-mission → Resume; airplane mode → offline play; incoming call/background 10 min |
| Ads (native) | Test ads show for banner/interstitial/rewarded; no banner in gameplay; reward only after completion; child profile flags |
| Accessibility | TalkBack/VoiceOver on Home → mission → answer; text size XL; reduced motion; contrast |
| Performance | Cold start < 3 s on a mid-range phone; 60 fps scrolling; memory stable after 30 missions |
| Privacy | Delete-data wipes storage; no network calls other than ad SDK; PIN gate on child flows |

## Known limitations
Native AdMob, store builds and real-device checks cannot run in this repository’s CI sandbox; they are listed in the release checklist. Flag emoji may show as letters on some desktop OSes (Android/iOS render them).
