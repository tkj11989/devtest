# 🌌 KnowledgeVerse — One Game. Multiple Learning Worlds.

An educational adventure game with **8 learning worlds** (Math Kingdom, Word Kingdom, Logic Castle, Science Planet,
Geography World, History Land, Space Galaxy, Money City), 88 missions with boss challenges, XP/coins/stars,
achievements, daily challenges + streaks, a mixed *Knowledge Challenge*, adaptive difficulty, optional friend
challenges, parental controls, AdMob-ready monetisation and a role-based admin dashboard.

## Run it
```bash
npm run serve            # http://localhost:8123  (game)   /admin/  (admin dashboard)
npm test                 # 49 rule + content tests (no dependencies)
npm run test:browser     # Playwright UI tests (needs playwright + a running server)
```
No build step. Android/iOS: wrap with Capacitor — see `docs/RELEASE_CHECKLIST.md`.

## Layout
| Path | What |
|---|---|
| `app/` | The game (PWA). `js/content/*` worlds, `js/game.js` rules, `js/qtypes.js` 11 interactive renderers |
| `app/admin/` | Admin / content-management dashboard (admin & content-manager roles) |
| `docs/` | `PLAN.md` (sitemap, journeys, checklist, risks), `USER_GUIDE.md`, `ADMIN_GUIDE.md`, `TESTING.md`, `RELEASE_CHECKLIST.md` |
| `tests/` | Node tests and Playwright smoke tests |
| `capacitor.config.json` | Native wrapper config (Android + iOS) |

## Honest status
Everything in `docs/PLAN.md` marked ✅ is implemented and covered by tests. Items marked 🟡 need things that cannot be
done inside this repository: a backend (global leaderboards, multi-user admin, AdMob revenue API), native builds on a
Mac/Android SDK, real AdMob unit IDs and store submission.
