// Persistent player state: versioned, validated, written to a primary slot and a backup slot.
import { storage } from './contentStore.js';
export const SAVE_KEY = 'kv_save_v1'; export const BACKUP_KEY = 'kv_save_v1_bak';
export const newState = () => ({
  v: 1, createdAt: Date.now(), profile: null, xp: 0, coins: 0,
  streak: { count: 0, last: null, best: 0, start: null }, progress: {}, ach: {}, claimed: {},
  daily: { date: null, done: {}, diff: 2 }, login: { last: null, day: 0 },
  perf: {}, mistakes: {}, recent: [], bests: {}, boards: [], friendScores: {},
  session: null, ads: { lastInterstitial: 0, missionsSince: 0, impressions: {}, rewarded: { requested: 0, completed: 0 }, hintsFromAds: 0 },
  settings: { music: false, sfx: true, reduceMotion: false, textSize: 1, currency: '$', haptics: true },
  parental: { pin: null, social: null, rewardedAds: true, dailyLimitMin: 0, lockSettings: false, usedToday: { date: null, sec: 0 } },
  privacy: { personalisedAds: false, analytics: true },
  stats: { answered: 0, correct: 0, missions: 0, playSec: 0, sessions: 0, perfect: 0, byWorld: {} },
});
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
export function sanitize(s) {
  const base = newState(); if (!s || typeof s !== 'object') return base;
  const o = { ...base, ...s };
  for (const k of ['settings', 'parental', 'privacy', 'stats', 'streak', 'daily', 'login', 'ads']) o[k] = { ...base[k], ...(s[k] || {}) };
  o.xp = Math.max(0, Math.floor(num(o.xp))); o.coins = Math.max(0, Math.floor(num(o.coins)));
  for (const k of ['progress', 'ach', 'claimed', 'perf', 'mistakes', 'bests', 'friendScores']) if (typeof o[k] !== 'object' || !o[k] || Array.isArray(o[k])) o[k] = {};
  if (!Array.isArray(o.recent)) o.recent = []; if (!Array.isArray(o.boards)) o.boards = [];
  for (const [id, p] of Object.entries(o.progress)) o.progress[id] = { stars: Math.min(3, Math.max(0, num(p?.stars))), best: num(p?.best), plays: num(p?.plays), paid: Math.min(3, Math.max(0, num(p?.paid))) };
  if (o.profile && typeof o.profile !== 'object') o.profile = null;
  return o;
}
export const store = {
  state: newState(), listeners: new Set(), now: () => new Date(), ok: true,
  load() {
    for (const key of [SAVE_KEY, BACKUP_KEY]) { const raw = storage.get(key); if (!raw) continue; try { this.state = sanitize(JSON.parse(raw)); return true; } catch { /* try backup */ } }
    this.state = newState(); return false;
  },
  save() {
    const raw = JSON.stringify(this.state); const prev = storage.get(SAVE_KEY);
    if (prev) storage.set(BACKUP_KEY, prev);
    this.ok = storage.set(SAVE_KEY, raw); this.listeners.forEach((f) => f(this.state)); return this.ok;
  },
  reset() { this.state = newState(); storage.set(SAVE_KEY, ''); storage.set(BACKUP_KEY, ''); this.listeners.forEach((f) => f(this.state)); },
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); },
};
export const isChild = (s = store.state) => ['5-8', '9-12'].includes(s.profile?.age);
