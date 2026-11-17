// Admin-managed content overrides, shared between the game and the admin app (same origin → same localStorage).
const KEY = 'kv_content_v1';
export const defaults = () => ({
  custom: [],          // admin-authored questions (full question objects incl. id, world)
  disabled: [],        // ids of unpublished questions
  edits: {},           // id -> partial patch for bank questions
  flags: {},           // id -> { reason, by, at } ("outdated / incorrect" reports)
  unpublishedWorlds: [],
  missions: {},        // missionId -> { title, desc, xp, coins, count, published }
  rewards: { loginCycle: [10, 15, 20, 25, 30, 40, 75], dailyAll: { xp: 50, coins: 50 }, streak: { 3: 30, 7: 100, 14: 200, 30: 500 } },
  difficulty: { adaptive: true, maxStep: 1, struggleBelow: 0.5, masteryAbove: 0.85 },
  daily: {},           // 'YYYY-MM-DD' -> { math:[ids], lang:[ids], logic:[ids], rotate:{world, ids:[]} }
  ads: { testMode: true, bannerEnabled: true, interstitialEnabled: true, rewardedEnabled: true, interstitialEveryMissions: 3, interstitialMinSeconds: 180,
         units: { android: { banner: 'ca-app-pub-3940256099942544/6300978111', interstitial: 'ca-app-pub-3940256099942544/1033173712', rewarded: 'ca-app-pub-3940256099942544/5224354917' },
                  ios: { banner: 'ca-app-pub-3940256099942544/2934735716', interstitial: 'ca-app-pub-3940256099942544/4411468910', rewarded: 'ca-app-pub-3940256099942544/1712485313' } } },
  worldMeta: {},       // worldId -> { name, tagline, catsExtra:[{id,name,emoji}] }
  settings: { appName: 'KnowledgeVerse', supportEmail: 'support@example.com', currency: '$', maintenance: false },
  moderation: { hiddenBoardEntries: [] },
  reviewed: {},        // id -> { by, at } content reviewed
});
let mem = null;
export const storage = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } } };
const deep = (a, b) => { // merge b into defaults a
  if (Array.isArray(a) || typeof a !== 'object' || a === null) return b === undefined ? a : b;
  const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = k in a ? deep(a[k], b[k]) : b[k]; return o;
};
let remote = {};
const union = (a = [], b = []) => [...new Set([...(a || []), ...(b || [])])];
export function getContent(force = false) {
  if (mem && !force) return mem;
  let saved = {}; try { saved = JSON.parse(storage.get(KEY) || '{}') || {}; } catch { saved = {}; }
  const base = deep(defaults(), remote); mem = deep(base, saved);
  // published (remote) content is extended — not replaced — by local admin edits
  mem.custom = [...(remote.custom || []).filter((q) => !(saved.custom || []).some((x) => x.id === q.id)), ...(saved.custom || [])];
  mem.disabled = union(remote.disabled, saved.disabled); mem.unpublishedWorlds = union(remote.unpublishedWorlds, saved.unpublishedWorlds);
  return mem;
}
// Optional: content-overrides.json next to index.html lets admins ship content/translation updates without a rebuild.
export async function loadRemoteContent(url = 'content-overrides.json') {
  try { const r = await fetch(url, { cache: 'no-cache' }); if (r.ok) { const j = await r.json(); if (j && typeof j === 'object') { remote = j; mem = null; } } } catch { /* offline or none published */ }
}
export function saveContent(c) { mem = c; return storage.set(KEY, JSON.stringify(c)); }
export const getLocalOnly = () => { try { return JSON.parse(storage.get(KEY) || '{}') || {}; } catch { return {}; } };
export function updateContent(fn) { const c = getContent(true); fn(c); return saveContent(c); }
export function resetContentCache() { mem = null; }
