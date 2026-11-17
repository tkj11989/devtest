// Core game rules: levels, unlocks, mission building, scoring, rewards (idempotent), streaks, adaptive difficulty, daily challenge.
import { store } from './store.js';
import { WORLDS, worldById, missionsFor, missionById, pickQuestion, allMissions, bankFor, qId } from './content/index.js';
import { getContent } from './contentStore.js';
import { makeRng, dateKey, daysBetween, clamp, hashStr } from './util.js';

export const levelThreshold = (L) => 50 * L * (L - 1);
export function levelOf(xp) { let L = 1; while (levelThreshold(L + 1) <= xp) L++; return L; }
export function xpProgress(xp) { const L = levelOf(xp), a = levelThreshold(L), b = levelThreshold(L + 1); return { level: L, into: xp - a, need: b - a, pct: ((xp - a) / (b - a)) * 100 }; }
export const today = () => dateKey(store.now());

// ---- unlocks / status ----
export function worldUnlocked(s, wid) { const w = worldById(wid); return levelOf(s.xp) >= w.unlockLevel && !getContent().unpublishedWorlds.includes(wid); }
export function worldProgress(s, wid) {
  const ms = missionsFor(wid).filter((m) => m.published); const done = ms.filter((m) => (s.progress[m.id]?.stars || 0) >= 1).length;
  const stars = ms.reduce((a, m) => a + (s.progress[m.id]?.stars || 0), 0);
  return { done, total: ms.length, stars, maxStars: ms.length * 3, pct: ms.length ? (done / ms.length) * 100 : 0, complete: done === ms.length, bossDone: (s.progress[`${wid}-boss`]?.stars || 0) >= 1 };
}
export function missionStatus(s, m) {
  if (!worldUnlocked(s, m.world)) return 'locked';
  const list = missionsFor(m.world).filter((x) => x.published); const idx = list.findIndex((x) => x.id === m.id);
  if (idx > 0) { const prev = list[idx - 1]; const need = m.boss ? list.filter((x) => !x.boss) : [prev]; if (!need.every((x) => (s.progress[x.id]?.stars || 0) >= 1)) return 'locked'; }
  return (s.progress[m.id]?.stars || 0) >= 1 ? 'done' : 'open';
}
export function unlockHint(s, m) {
  if (!worldUnlocked(s, m.world)) return `Reach player level ${worldById(m.world).unlockLevel} to unlock this world`;
  const list = missionsFor(m.world).filter((x) => x.published);
  if (m.boss) return 'Pass all 10 missions to face the boss'; const prev = list[list.findIndex((x) => x.id === m.id) - 1]; return `Pass “${prev?.title}” first`;
}
export function worldUnlockText(s, wid) { const w = worldById(wid); const lv = levelOf(s.xp); if (lv >= w.unlockLevel) return 'Unlocked'; const need = levelThreshold(w.unlockLevel) - s.xp; return `Reach level ${w.unlockLevel} (${need} XP to go)`; }

// ---- adaptive difficulty ----
export function skill(s, world, cat) { const p = s.perf[`${world}:${cat}`]; if (!p || !p.recent?.length) return { n: 0, acc: null }; const a = p.recent.reduce((x, y) => x + (y ? 1 : 0), 0); return { n: p.recent.length, acc: a / p.recent.length }; }
export function targetDifficulty(s, world, cat, base, { noAdapt = false } = {}) {
  let d = base; const cfg = getContent().difficulty;
  if (!noAdapt) {
    if (cfg.adaptive) { const k = skill(s, world, cat); if (k.n >= 4 && k.acc <= cfg.struggleBelow) d -= 1; else if (k.n >= 5 && k.acc >= cfg.masteryAbove) d += 1; }
    const pref = s.profile?.difficulty; if (pref === 'easy') d -= 1; else if (pref === 'hard') d += 1;
  }
  const step = getContent().difficulty.maxStep || 1;
  return clamp(d, Math.max(1, base - step), Math.min(5, base + step));
}
export function struggling(s, world, cat) { const k = skill(s, world, cat); return k.n >= 4 && k.acc <= getContent().difficulty.struggleBelow; }
export function weakestCat(s, wid) { let best = null; for (const c of worldById(wid).cats) { const k = skill(s, wid, c.id); if (k.n >= 3 && (best === null || k.acc < best.acc)) best = { cat: c, acc: k.acc }; } return best && best.acc < 0.7 ? best : null; }

// ---- question building ----
export function buildQuestions(s, m, seed = null, { noAdapt = false } = {}) {
  const rng = makeRng(seed ?? (Date.now() ^ hashStr(m.id) ^ Math.floor(Math.random() * 1e9)));
  const used = new Set(); const qs = []; const types = [];
  // spaced review of previously missed bank questions
  const missed = (s.mistakes[m.world] || []).filter((id) => bankFor(m.world).some((q) => q.id === id && m.cats.includes(q.cat))).slice(0, struggling(s, m.world, m.cats[0]) ? 2 : 1);
  if (!noAdapt && !m.boss) for (const id of missed) { const b = bankFor(m.world).find((q) => q.id === id); if (b && !used.has(id)) { used.add(id); qs.push({ ...(pickBy(b, rng)), review: true }); } }
  if (m.mystery) { const my = rng.shuffle(bankFor(m.world).filter((q) => q.clues && !used.has(q.id))); for (const b of my) { if (qs.length >= m.count) break; used.add(b.id); qs.push(pickBy(b, rng)); } }
  let i = 0;
  while (qs.length < m.count) {
    const cat = m.cats[i++ % m.cats.length]; const base = m.boss ? m.d + (i % 2 ? 0 : 1) : m.d;
    const d = m.boss ? clamp(base, 1, 5) : targetDifficulty(s, m.world, cat, m.d, { noAdapt });
    const q = pickQuestion(m.world, cat, d, rng, used, { types: m.types, avoidTypes: types.slice(-2) });
    if (q.id) used.add(q.id); types.push(q.type); qs.push(q);
  }
  return mixReview(qs, rng);
}
function mixReview(qs, rng) { const rev = qs.filter((q) => q.review); const rest = rng.shuffle(qs.filter((q) => !q.review)); rev.forEach((r, i) => rest.splice(Math.min(rest.length, 1 + i * 2), 0, r)); return rest; }
import { realise } from './content/index.js';
function pickBy(b, rng) { return realise(b, rng); }

// ---- scoring ----
export function starsFor(pct, boss = false) { if (boss) return pct >= 95 ? 3 : pct >= 82 ? 2 : pct >= 70 ? 1 : 0; return pct >= 95 ? 3 : pct >= 80 ? 2 : pct >= 60 ? 1 : 0; }
const CUM = [0, 0.6, 0.85, 1];

// ---- rewards (idempotent) ----
export function grant(s, key, { xp = 0, coins = 0 }) { if (s.claimed[key]) return false; s.claimed[key] = Date.now(); s.xp += Math.max(0, Math.floor(xp)); s.coins += Math.max(0, Math.floor(coins)); return true; }
export function addCoins(s, n) { s.coins = Math.max(0, s.coins + Math.floor(n)); }
export function touchStreak(s) {
  const t = today(); const st = s.streak; if (st.last === t) return;
  if (st.last && daysBetween(st.last, t) === 1) st.count++; else { st.count = 1; st.start = t; }
  if (!st.start) st.start = t; st.last = t; st.best = Math.max(st.best, st.count);
  const cfg = getContent().rewards.streak; const gained = [];
  for (const [n, coins] of Object.entries(cfg)) if (st.count >= Number(n) && grant(s, `streak:${n}:${st.start}`, { coins: Number(coins), xp: Number(coins) / 2 })) gained.push({ n: Number(n), coins: Number(coins) });
  return gained;
}
export function streakAlive(s) { const t = today(); return s.streak.last && daysBetween(s.streak.last, t) <= 1 ? s.streak.count : 0; }
export function loginRewardState(s) {
  const t = today(); const cycle = getContent().rewards.loginCycle; const claimedToday = s.login.last === t;
  let nextDay = s.login.day; if (!claimedToday) nextDay = s.login.last && daysBetween(s.login.last, t) === 1 ? (s.login.day % cycle.length) + 1 : 1;
  return { claimedToday, day: claimedToday ? s.login.day : nextDay, cycle, amount: cycle[(claimedToday ? s.login.day : nextDay) - 1] };
}
export function claimLogin(s) { const st = loginRewardState(s); if (st.claimedToday) return null; s.login.last = today(); s.login.day = st.day; grant(s, `login:${today()}`, { coins: st.amount }); return st; }

function bumpPerf(s, a) { const k = `${a.world}:${a.cat}`; const p = (s.perf[k] ||= { c: 0, w: 0, ms: 0, recent: [] }); if (a.correct) p.c++; else p.w++; p.ms += a.ms || 0; p.recent.push(a.correct ? 1 : 0); if (p.recent.length > 8) p.recent.shift(); }
function bumpMistakes(s, a) { if (!a.qid) return; const arr = (s.mistakes[a.world] ||= []); const i = arr.indexOf(a.qid); if (a.correct) { if (i >= 0) arr.splice(i, 1); } else if (i < 0) { arr.push(a.qid); if (arr.length > 30) arr.shift(); } }

// Apply a finished run. run = { id, kind, missionId?, slot?, mode?, answers[], elapsed, timedOut? }
export function finishRun(run) {
  const s = store.state; const res = { dup: false, levelUp: null, xp: 0, coins: 0, newAch: [], streakRewards: [], stars: 0, pct: 0, passed: false, worldComplete: false };
  if (s.claimed[`run:${run.id}`]) { res.dup = true; return res; }
  s.claimed[`run:${run.id}`] = Date.now();
  const before = levelOf(s.xp); const total = run.answers.length; const correct = run.answers.filter((a) => a.correct).length; const pct = total ? (correct / total) * 100 : 0;
  res.correct = correct; res.total = total; res.pct = pct;
  for (const a of run.answers) { bumpPerf(s, a); bumpMistakes(s, a); s.stats.answered++; if (a.correct) s.stats.correct++; const bw = (s.stats.byWorld[a.world] ||= { a: 0, c: 0 }); bw.a++; if (a.correct) bw.c++; }
  s.stats.playSec += Math.round(run.elapsed || 0);
  let xp = 0, coins = 0;
  if (run.kind === 'mission') {
    const m = missionById(run.missionId); const p = (s.progress[m.id] ||= { stars: 0, best: 0, plays: 0, paid: 0 });
    const stars = starsFor(pct, m.boss);
    res.stars = stars; res.passed = stars >= 1; p.plays++; p.best = Math.max(p.best, Math.round(pct));
    if (stars > p.paid) { xp = Math.round(m.xp * (CUM[stars] - CUM[p.paid])); coins = Math.round(m.coins * (CUM[stars] - CUM[p.paid])); p.paid = stars; } else if (res.passed) { xp = 5; }
    else xp = Math.round(correct * 2);
    p.stars = Math.max(p.stars, stars);
    if (stars === 3) s.stats.perfect++;
    s.stats.missions++; s.ads.missionsSince++;
    s.recent.unshift({ id: m.id, title: m.title, world: m.world, stars, ts: Date.now() }); s.recent = s.recent.slice(0, 8);
    const wp = worldProgress(s, m.world); if (wp.complete && wp.bossDone && grant(s, `world:${m.world}`, { xp: 200, coins: 150 })) { res.worldComplete = true; xp += 200; coins += 150; }
  } else if (run.kind === 'daily') {
    const d = s.daily; const key = `daily:${d.date}:${run.slot}`;
    if (grant(s, key, { xp: 15 + correct * 5, coins: 10 + correct * 5 })) { xp = 15 + correct * 5; coins = 10 + correct * 5; d.done[run.slot] = { correct, total }; }
    if (['math', 'lang', 'logic', 'rotate'].every((k) => d.done[k]) && grant(s, `dailyall:${d.date}`, getContent().rewards.dailyAll)) { xp += getContent().rewards.dailyAll.xp; coins += getContent().rewards.dailyAll.coins; res.dailyAll = true; }
    res.stars = starsFor(pct); res.passed = true;
  } else {
    const score = scoreRun(run); res.score = score; xp = Math.round(correct * 6); coins = Math.round(correct * 3); grant(s, `kc:${run.id}`, { xp: 0 });
    const bkey = run.kind === 'friend' ? `friend:${run.code}` : `kc:${run.mode}`; s.bests[bkey] = Math.max(s.bests[bkey] || 0, score);
    s.boards.unshift({ mode: run.kind === 'friend' ? 'friend' : run.mode, code: run.code || null, score, pct: Math.round(pct), ts: Date.now(), name: s.profile?.name || 'Player', week: weekOf() }); s.boards = s.boards.slice(0, 60);
    if (run.kind === 'friend') s.friendScores[run.code] = Math.max(s.friendScores[run.code] || 0, score);
    res.stars = starsFor(pct); res.passed = true;
  }
  s.xp += xp; s.coins += coins; res.xp = xp; res.coins = coins;
  res.streakRewards = touchStreak(s) || [];
  for (const g of res.streakRewards) { res.xp += g.coins / 2; res.coins += g.coins; }
  res.newAch = checkAchievements(s);
  for (const a of res.newAch) { res.coins += a.coins; }
  const after = levelOf(s.xp); if (after > before) res.levelUp = after;
  store.save(); return res;
}
export const weekOf = () => { const n = Math.floor(store.now().getTime() / 86400000); return Math.floor((n + 3) / 7); };
export function scoreRun(run) { return run.answers.reduce((t, a) => t + (a.correct ? 100 + (a.hint ? 0 : Math.max(0, 30 - Math.floor((a.ms || 0) / 1000))) : 0), 0); }

// ---- achievements ----
const worldStars = (s, wid) => missionsFor(wid).reduce((a, m) => a + (s.progress[m.id]?.stars || 0), 0);
export const ACHIEVEMENTS = [
  { id: 'first', name: 'First Mission', emoji: '🎯', desc: 'Complete your first mission', check: (s) => s.stats.missions >= 1, coins: 20 },
  { id: 'math', name: 'Math Master', emoji: '🧮', desc: 'Defeat the Number Dragon', check: (s) => (s.progress['math-boss']?.stars || 0) >= 1, coins: 60 },
  { id: 'word', name: 'Word Explorer', emoji: '📖', desc: 'Pass 5 Word Kingdom missions', check: (s) => missionsFor('word').filter((m) => (s.progress[m.id]?.stars || 0) >= 1).length >= 5, coins: 40 },
  { id: 'science', name: 'Science Genius', emoji: '🧪', desc: 'Pass 5 Science Planet missions', check: (s) => missionsFor('science').filter((m) => (s.progress[m.id]?.stars || 0) >= 1).length >= 5, coins: 40 },
  { id: 'geo', name: 'Geography Expert', emoji: '🧭', desc: 'Pass 5 Geography World missions', check: (s) => missionsFor('geo').filter((m) => (s.progress[m.id]?.stars || 0) >= 1).length >= 5, coins: 40 },
  { id: 'logic', name: 'Logic Champion', emoji: '🗝️', desc: 'Defeat the Riddle Sphinx', check: (s) => (s.progress['logic-boss']?.stars || 0) >= 1, coins: 60 },
  { id: 'history', name: 'Time Traveller', emoji: '🏺', desc: 'Pass 5 History Land missions', check: (s) => missionsFor('history').filter((m) => (s.progress[m.id]?.stars || 0) >= 1).length >= 5, coins: 40 },
  { id: 'space', name: 'Star Pilot', emoji: '🚀', desc: 'Pass 5 Space Galaxy missions', check: (s) => missionsFor('space').filter((m) => (s.progress[m.id]?.stars || 0) >= 1).length >= 5, coins: 40 },
  { id: 'money', name: 'Money Whiz', emoji: '💰', desc: 'Pass 5 Money City missions', check: (s) => missionsFor('money').filter((m) => (s.progress[m.id]?.stars || 0) >= 1).length >= 5, coins: 40 },
  { id: 'streak7', name: 'Seven-Day Streak', emoji: '🔥', desc: 'Play 7 days in a row', check: (s) => s.streak.best >= 7, coins: 70 },
  { id: 'explorer', name: 'World Explorer', emoji: '🗺️', desc: 'Complete a mission in 5 different worlds', check: (s) => WORLDS.filter((w) => missionsFor(w.id).some((m) => (s.progress[m.id]?.stars || 0) >= 1)).length >= 5, coins: 60 },
  { id: 'perfect', name: 'Flawless', emoji: '⭐', desc: 'Earn 3 stars on a mission', check: (s) => s.stats.perfect >= 1, coins: 25 },
  { id: 'level5', name: 'Rising Hero', emoji: '🛡️', desc: 'Reach player level 5', check: (s) => levelOf(s.xp) >= 5, coins: 50 },
  { id: 'champion', name: 'KnowledgeVerse Champion', emoji: '🏆', desc: 'Defeat all eight world bosses', check: (s) => WORLDS.every((w) => (s.progress[`${w.id}-boss`]?.stars || 0) >= 1), coins: 300 },
];
export function checkAchievements(s) { const out = []; for (const a of ACHIEVEMENTS) if (!s.ach[a.id] && a.check(s)) { s.ach[a.id] = Date.now(); grant(s, `ach:${a.id}`, { coins: a.coins }); out.push(a); } return out; }
export const totalStars = (s) => Object.values(s.progress).reduce((a, p) => a + (p.stars || 0), 0);

// ---- daily challenge ----
export const SLOTS = [{ id: 'math', name: 'Math Challenge', emoji: '🧮', world: 'math' }, { id: 'lang', name: 'Language Challenge', emoji: '📖', world: 'word' }, { id: 'logic', name: 'Reasoning Challenge', emoji: '🧩', world: 'logic' }, { id: 'rotate', name: 'World Spotlight', emoji: '🌟', world: null }];
const ROTATE = ['science', 'geo', 'history', 'space', 'money'];
export function ensureDaily(s) {
  const t = today(); if (s.daily.date === t) return s.daily;
  const lv = levelOf(s.xp); s.daily = { date: t, done: {}, diff: clamp(1 + Math.floor(lv / 3), 1, 4) };
  // adapt to overall recent accuracy
  const rec = Object.values(s.perf).flatMap((p) => p.recent || []); if (rec.length >= 10) { const acc = rec.reduce((a, b) => a + b, 0) / rec.length; if (acc > 0.85) s.daily.diff = Math.min(5, s.daily.diff + 1); else if (acc < 0.5) s.daily.diff = Math.max(1, s.daily.diff - 1); }
  store.save(); return s.daily;
}
export function dailySlotWorld(slot, date = today()) { if (slot !== 'rotate') return SLOTS.find((x) => x.id === slot).world; const sched = getContent().daily[date]?.rotate?.world; if (sched && worldById(sched)) return sched; return ROTATE[((Math.floor(new Date(date + 'T00:00:00Z').getTime() / 86400000)) % ROTATE.length + ROTATE.length) % ROTATE.length]; }
export function dailyQuestions(s, slot) {
  const d = ensureDaily(s); const world = dailySlotWorld(slot, d.date); const rng = makeRng(`${d.date}:${slot}`);
  const sched = getContent().daily[d.date]?.[slot]; const ids = Array.isArray(sched) ? sched : sched?.ids || getContent().daily[d.date]?.rotate?.ids;
  const qs = [];
  if (ids?.length && (slot !== 'rotate' || getContent().daily[d.date]?.rotate?.ids?.length)) { for (const id of ids) { const b = bankFor(world).find((q) => q.id === id) || null; if (b) qs.push(realiseRef(b, rng)); } }
  const w = worldById(world); const used = new Set(qs.map((q) => q.id)); let i = 0;
  while (qs.length < 3) { const cat = w.cats[(hashStr(d.date + slot) + i++) % w.cats.length].id; qs.push(pickQuestion(world, cat, d.diff, rng, used, { avoidTypes: qs.slice(-1).map((q) => q.type) })); if (qs[qs.length - 1].id) used.add(qs[qs.length - 1].id); }
  return { world, qs: qs.slice(0, 3) };
}
import { realise as realiseRef } from './content/index.js';

// ---- knowledge challenge ----
export const KC_MODES = { quick: { name: 'Quick Challenge', count: 5, emoji: '⚡', time: 0, desc: '5 questions from different worlds' }, standard: { name: 'Standard Challenge', count: 10, emoji: '🎯', time: 0, desc: '10 questions across your worlds' }, expert: { name: 'Expert Challenge', count: 15, emoji: '👑', time: 15 * 30, desc: '15 hard questions with a time limit' } };
export function kcQuestions(s, mode, seed, noAdapt = false) {
  const cfg = KC_MODES[mode]; const rng = makeRng(seed); const worlds = WORLDS.filter((w) => noAdapt ? ['math', 'word', 'logic', 'science', 'geo', 'history', 'space', 'money'].includes(w.id) : worldUnlocked(s, w.id)); const order = rng.shuffle(worlds); const qs = []; const used = new Set();
  const base = mode === 'expert' ? 4 : mode === 'standard' ? 3 : 2;
  for (let i = 0; i < cfg.count; i++) { const w = order[i % order.length]; const cat = rng.pick(w.cats).id; const d = noAdapt ? base : targetDifficulty(s, w.id, cat, base); const q = pickQuestion(w.id, cat, d, rng, used, { avoidTypes: qs.slice(-2).map((x) => x.type) }); if (q.id) used.add(q.id); qs.push(q); }
  return qs;
}
export function friendCode(mode, seed) { return `KV-${mode[0].toUpperCase()}-${(seed >>> 0).toString(36).toUpperCase()}`; }
export function parseFriendCode(code) { const m = /^KV-([QSE])-([0-9A-Z]{1,8})$/.exec(String(code).trim().toUpperCase()); if (!m) return null; return { mode: { Q: 'quick', S: 'standard', E: 'expert' }[m[1]], seed: parseInt(m[2], 36) >>> 0 }; }

// ---- recommendations ----
export function recommend(s) {
  const open = WORLDS.filter((w) => worldUnlocked(s, w.id)); const weak = open.map((w) => ({ w, k: weakestCat(s, w.id) })).find((x) => x.k);
  if (weak) return { world: weak.w, reason: `Practise ${weak.k.cat.name} — a little extra help here`, cat: weak.k.cat };
  const unfinished = open.map((w) => ({ w, p: worldProgress(s, w.id) })).filter((x) => !x.p.complete).sort((a, b) => a.p.pct - b.p.pct)[0];
  if (unfinished) return { world: unfinished.w, reason: unfinished.p.done ? 'Keep exploring where you left progress' : 'A fresh world to explore' };
  return { world: open[0], reason: 'Replay for more stars' };
}
export function nextMission(s) {
  const lastW = s.recent[0]?.world; const order = lastW ? [worldById(lastW), ...WORLDS.filter((w) => w.id !== lastW)] : WORLDS;
  for (const w of order) { if (!worldUnlocked(s, w.id)) continue; const m = missionsFor(w.id).filter((x) => x.published).find((x) => missionStatus(s, x) === 'open'); if (m) return m; }
  return null;
}
