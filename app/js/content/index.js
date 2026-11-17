import { makeRng, hashStr, clamp } from '../util.js';
import { getContent } from '../contentStore.js';
import * as math from './math.js';
import * as words from './words.js';
import * as logic from './logic.js';
import * as science from './science.js';
import * as geo from './geo.js';
import * as history from './history.js';
import * as space from './space.js';
import * as money from './money.js';

export const TIERS = [
  { id: 'beginner', name: 'Beginner', stars: 1 }, { id: 'easy', name: 'Easy' }, { id: 'medium', name: 'Medium' },
  { id: 'hard', name: 'Hard' }, { id: 'expert', name: 'Expert' },
];
const W = (id, name, tagline, emoji, c, unlockLevel, mod, extra = {}) => ({ id, name, tagline, emoji, colors: c, unlockLevel, mod, cats: mod.cats, base: { name, tagline }, ...extra });
export const WORLDS = [
  W('math', 'Math Kingdom', 'Open castle gates with the power of numbers', '🏰', ['#6d28d9', '#a855f7', '#fbbf24'], 1, math, { mascot: '🧙', quest: 'Break the number spell' }),
  W('word', 'Word Kingdom', 'Restore the enchanted library and its magic books', '📚', ['#15803d', '#4ade80', '#fcd34d'], 1, words, { mascot: '🦉', quest: 'Restore the library' }),
  W('logic', 'Logic Castle', 'Escape rooms, riddles and secret chambers', '🗝️', ['#334155', '#8b5cf6', '#e2e8f0'], 1, logic, { mascot: '🦇', quest: 'Unlock the final chamber' }),
  W('science', 'Science Planet', 'Run experiments in a futuristic lab', '🔬', ['#0369a1', '#22d3ee', '#a5f3fc'], 2, science, { mascot: '🤖', quest: 'Power up the planet' }),
  W('geo', 'Geography World', 'Explore a colourful global map', '🌍', ['#047857', '#38bdf8', '#bef264'], 3, geo, { mascot: '🧭', quest: 'Unlock every territory' }),
  W('history', 'History Land', 'Solve mysteries of ancient civilizations', '🏛️', ['#b45309', '#e9c46a', '#7c2d12'], 4, history, { mascot: '🐫', quest: 'Solve the Pharaoh’s riddle' }),
  W('space', 'Space Galaxy', 'Blast off across planets, stars and galaxies', '🚀', ['#1e1b4b', '#ec4899', '#67e8f9'], 5, space, { mascot: '👩‍🚀', quest: 'Reach the Nebula Nexus' }),
  W('money', 'Money City', 'Budget, shop and save in a colourful city', '🏙️', ['#c2410c', '#14b8a6', '#fde68a'], 6, money, { mascot: '🦊', quest: 'Master your money' }),
];
export const worldById = (id) => WORLDS.find((w) => w.id === id);
// Admin overrides for world display text and extra categories (applied at load and when content changes).
export function applyWorldMeta() {
  const meta = getContent().worldMeta || {};
  for (const w of WORLDS) { const m = meta[w.id] || {}; w.name = m.name || w.base.name; w.tagline = m.tagline || w.base.tagline; w.cats = [...w.mod.cats, ...(m.catsExtra || [])]; }
}

// ---- Question building -------------------------------------------------------------------
export const qKey = (b) => `${b.type}|${b.q}|${b.a ?? b.answer ?? (b.pairs ? JSON.stringify(b.pairs) : b.items ? b.items.join('>') : '')}`.toLowerCase();
export const qId = (world, b) => `${world}-${hashStr(qKey(b)).toString(36)}`;

let bankCache = null;
export function invalidateBank() { bankCache = null; applyWorldMeta(); }
export function allBank() {
  if (bankCache) return bankCache;
  const c = getContent(); const out = [];
  for (const w of WORLDS) {
    for (const b of w.mod.bank || []) {
      const id = qId(w.id, b); const patch = c.edits[id] || {};
      out.push({ ...b, ...patch, id, world: w.id, builtin: true, enabled: !c.disabled.includes(id), flagged: c.flags[id] || null });
    }
  }
  for (const q of c.custom) out.push({ ...q, builtin: false, enabled: !c.disabled.includes(q.id) && q.enabled !== false, flagged: c.flags[q.id] || null });
  bankCache = out; return out;
}
export const bankFor = (world) => allBank().filter((q) => q.world === world && q.enabled && !q.flagged);

export function realise(b, rng) {
  const q = { ...b };
  q.d = clamp(q.d || 1, 1, 5);
  if (q.type === 'mcq' && q.a !== undefined) {
    const wrongs = [...new Set((q.w || []).filter((x) => x !== q.a))].slice(0, 3);
    const opts = rng.shuffle([q.a, ...wrongs]); q.options = opts; q.answer = opts.indexOf(q.a); delete q.a; delete q.w;
  }
  if (q.type === 'order') {
    let sh = q.shuffled; if (!sh) { sh = rng.shuffle(q.items); let t = 0; while (sh.join('\u0001') === q.items.join('\u0001') && t++ < 8) sh = rng.shuffle(q.items); }
    q.shuffled = sh;
  }
  if (q.type === 'match') q.right = rng.shuffle(q.pairs.map((p) => p[1]));
  if (q.type === 'sort') q.items = rng.shuffle(q.items);
  if (q.type === 'lab') q.slots = q.slots.map((s) => ({ ...s }));
  return q;
}

// Pick a question for (world, cat, difficulty) from bank and/or generator.
export function pickQuestion(worldId, cat, d, rng, used = new Set(), opts = {}) {
  const w = worldById(worldId); const mod = w.mod; const bank = bankFor(worldId);
  const types = opts.types; const okType = (q) => !types || types.includes(q.type);
  const avoid = opts.avoidTypes || [];
  let cands = bank.filter((q) => q.cat === cat && !used.has(q.id) && okType(q));
  const closeness = (q) => Math.abs(q.d - d) + (avoid.includes(q.type) ? 0.6 : 0) + rng() * 0.4;
  cands.sort((a, b) => closeness(a) - closeness(b));
  const near = cands.filter((q) => Math.abs(q.d - d) <= 1);
  const genKeys = mod.alt?.[cat] || (mod.gen?.[cat] ? [cat] : []);
  const useGen = genKeys.length && (!near.length || rng.chance(0.55) || opts.preferGen);
  if (useGen) {
    for (let t = 0; t < 12; t++) {
      const key = rng.pick(genKeys); const gq = mod.gen[key]?.(d, rng); if (!gq) continue;
      if (types && !types.includes(gq.type)) continue;
      if (t < 6 && avoid.includes(gq.type) && genKeys.length > 1) continue;
      return realise({ id: null, world: worldId, cat, d, ...gq, gen: true }, rng);
    }
  }
  if (near.length) return realise(near[0], rng);
  if (cands.length) return realise(cands[0], rng);
  // relax category within world
  const any = bank.filter((q) => !used.has(q.id) && okType(q)).sort((a, b) => Math.abs(a.d - d) - Math.abs(b.d - d) + (rng() - 0.5));
  if (any.length) return realise(any[0], rng);
  for (const key of Object.keys(mod.gen || {})) { const gq = mod.gen[key](d, rng); if (gq && okType(gq)) return realise({ id: null, world: worldId, cat, d, ...gq, gen: true }, rng); }
  // finally ignore used
  const again = bankFor(worldId).filter(okType); if (again.length) return realise(rng.pick(again), rng);
  throw new Error(`No content for ${worldId}/${cat}`);
}

// ---- Missions ------------------------------------------------------------------------------
const XP = [20, 30, 42, 56, 72]; const COINS = [10, 15, 20, 28, 38];
export function missionsFor(worldId) {
  const w = worldById(worldId); const c = getContent(); const n = w.cats.length; const out = [];
  for (let i = 0; i < 10; i++) {
    const tier = Math.floor(i / 2); const cats = [0, 1, 2].map((k) => w.cats[(i + k) % n]);
    const timed = i % 3 === 2; const count = tier < 2 ? 5 : tier < 3 ? 6 : 7;
    const id = `${worldId}-m${i + 1}`; const ov = c.missions[id] || {};
    out.push({ id, world: worldId, index: i, tier, tierName: TIERS[tier].name, title: ov.title || w.mod.titles[i], boss: false,
      desc: ov.desc || `${w.quest}: practise ${cats.map((x) => x.name).join(', ')}.`,
      objective: `Practise ${cats.map((x) => x.name.toLowerCase()).join(', ')} at ${TIERS[tier].name} level.`,
      cats: cats.map((x) => x.id), d: tier + 1, count: ov.count || count, time: timed ? (ov.count || count) * 35 : 0,
      xp: ov.xp ?? XP[tier], coins: ov.coins ?? COINS[tier], published: ov.published !== false, condition: 'Answer at least 60% correctly to pass (★), 80% for ★★, 95% for ★★★.' });
  }
  const b = w.mod.boss; const id = `${worldId}-boss`; const ov = c.missions[id] || {};
  out.push({ id, world: worldId, index: 10, tier: 4, tierName: 'Boss', title: ov.title || b.title, boss: true, desc: ov.desc || b.desc,
    objective: 'Prove your mastery of this world in a special challenge.', cats: b.cats, d: b.minD, count: ov.count || b.count, time: b.time || 0, types: b.types, mystery: b.mystery,
    xp: ov.xp ?? 150, coins: ov.coins ?? 100, published: ov.published !== false, condition: 'Pass with at least 70% correct to defeat the boss. Replay as often as you like.' });
  return out;
}
export const allMissions = () => WORLDS.flatMap((w) => missionsFor(w.id));
export const missionById = (id) => allMissions().find((m) => m.id === id);
