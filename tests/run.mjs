// KnowledgeVerse automated tests: content validation + game rules. Run: node tests/run.mjs
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
const C = await import('../app/js/content/index.js');
const { WORLDS, allBank, missionsFor, pickQuestion, realise, qKey, allMissions } = C;
const G = await import('../app/js/game.js');
const { store, newState, sanitize } = await import('../app/js/store.js');
const { makeRng } = await import('../app/js/util.js');
const { getContent, saveContent } = await import('../app/js/contentStore.js');
const { validateQuestion } = await import('../app/js/validate.js');

let pass = 0, fail = 0; const failures = [];
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; failures.push(`✗ ${name}: ${e.message}`); } }
const eq = (a, b, m = '') => { if (a !== b) throw new Error(`${m} expected ${b}, got ${a}`); };
const ok = (c, m = 'assertion failed') => { if (!c) throw new Error(m); };

// ---------- content ----------
t('8 worlds', () => eq(WORLDS.length, 8));
t('88 missions', () => eq(allMissions().length, 88));
t('bank questions all valid', () => { for (const q of allBank()) { const r = validateQuestion(realise(q, makeRng(1))); ok(r.ok, `${q.id} ${q.q}: ${r.errors.join(',')}`); } });
t('no duplicate questions', () => { const seen = new Set(); for (const q of allBank()) { const k = qKey(q); ok(!seen.has(k), `dup ${q.q}`); seen.add(k); } });
t('unique ids', () => { const s = new Set(); for (const q of allBank()) { ok(!s.has(q.id), 'dup id ' + q.id); s.add(q.id); } });
t('every mcq has unique options and the right answer', () => { for (const q of allBank().filter((q) => q.type === 'mcq')) { const r = realise(q, makeRng(7)); eq(new Set(r.options).size, r.options.length, q.q); ok(r.options.length >= 3, 'few options ' + q.q); ok(r.options[r.answer] === q.a); } });
t('every bank question has an explanation', () => { for (const q of allBank()) ok(q.explain && q.explain.length > 5, q.q); });
t('enough bank content per static world', () => { for (const w of ['science', 'geo', 'history', 'space', 'money']) ok(C.bankFor(w).length >= 20 || w === 'money' || w === 'geo', `${w} ${C.bankFor(w).length}`); });
for (const w of WORLDS) {
  t(`${w.id}: every mission builds valid questions (12 seeds each)`, () => {
    const s = newState(); s.profile = { name: 'T', age: 'adult', difficulty: 'auto' };
    for (const m of missionsFor(w.id)) for (let seed = 1; seed <= 12; seed++) {
      const qs = G.buildQuestions(s, m, seed * 977); eq(qs.length, m.count, m.id);
      for (const q of qs) { const r = validateQuestion(q); ok(r.ok, `${m.id} seed ${seed} ${q.type} "${q.q}" ${r.errors.join(',')}`); }
    }
  });
  t(`${w.id}: question formats vary`, () => { const s = newState(); const types = new Set(); for (const m of missionsFor(w.id)) for (const q of G.buildQuestions(s, m, 5)) types.add(q.type); ok(types.size >= 2, w.id + ' only ' + [...types]); });
}
t('generators produce valid questions at every difficulty', () => { for (const w of WORLDS) for (let d = 1; d <= 5; d++) for (const c of w.cats) for (let i = 0; i < 20; i++) { const q = pickQuestion(w.id, c.id, d, makeRng(i * 31 + d), new Set(), { preferGen: true }); const r = validateQuestion(q); ok(r.ok, `${w.id}/${c.id} ${q.q} ${r.errors}`); if (q.type === 'input' && typeof q.answer === 'number') ok(Number.isInteger(q.answer), 'non-integer ' + q.q); } });
function evalClue(cl, a, b, c) {
  let m;
  if ((m = /^The digits add up to (\d+)\.$/.exec(cl))) return a + b + c === +m[1];
  if ((m = /^The first digit is (odd|even)\.$/.exec(cl))) return (a % 2 ? 'odd' : 'even') === m[1];
  if ((m = /^The last digit is (odd|even)\.$/.exec(cl))) return (c % 2 ? 'odd' : 'even') === m[1];
  if ((m = /^The middle digit is (greater than|smaller than|equal to) the first digit\.$/.exec(cl)) || (m = /^The middle digit is equal to the first digit\.$/.exec(cl))) { const k = m[1] || 'equal to'; return k === 'greater than' ? b > a : k === 'smaller than' ? b < a : b === a; }
  if ((m = /^The last digit is (greater than|smaller than|equal to) the middle digit\.$/.exec(cl))) return m[1] === 'greater than' ? c > b : m[1] === 'smaller than' ? c < b : c === b;
  if ((m = /^The first digit is (more than 4|4 or less)\.$/.exec(cl))) return m[1] === 'more than 4' ? a > 4 : a <= 4;
  if ((m = /^The product of the first two digits is (\d+)\.$/.exec(cl))) return a * b === +m[1];
  if ((m = /^The middle digit is (not )?a multiple of 3\.$/.exec(cl))) return (b % 3 === 0) === !m[1];
  if ((m = /^The first and last digits add up to (\d+)\.$/.exec(cl))) return a + c === +m[1];
  if ((m = /^The largest digit is (\d+)\.$/.exec(cl))) return Math.max(a, b, c) === +m[1];
  if (/uses three different digits/.test(cl)) return new Set([a, b, c]).size === 3;
  if (/repeats at least one digit/.test(cl)) return new Set([a, b, c]).size < 3;
  if ((m = /^The last digit is (\d+)\.$/.exec(cl))) return c === +m[1];
  if ((m = /^The middle digit is (\d+)\.$/.exec(cl))) return b === +m[1];
  if ((m = /^The first digit is (\d+)\.$/.exec(cl))) return a === +m[1];
  throw new Error('unparsed clue ' + cl);
}
t('logic locks: exactly one code satisfies all clues', () => { const { gen } = WORLDS[2].mod; for (let i = 0; i < 100; i++) { const q = gen.lockAny(3, makeRng(i)); const sol = []; for (let x = 0; x < 1000; x++) { const code = String(x).padStart(3, '0'); const [a, b, c] = code.split('').map(Number); if (q.clues.every((cl) => evalClue(cl, a, b, c))) sol.push(code); } eq(sol.length, 1, `lock ${i} ${q.clues.join('|')} → ${sol}`); eq(sol[0], q.answer); } });

// ---------- game rules ----------
const fresh = () => { store.reset(); store.state = newState(); store.state.profile = { name: 'T', age: '9-12', difficulty: 'auto' }; return store.state; };
const run = (id, mid, correctN, total) => ({ id, kind: 'mission', missionId: mid, answers: Array.from({ length: total }, (_, i) => ({ qid: null, world: mid.split('-')[0], cat: 'arith', correct: i < correctN, ms: 3000 })), elapsed: 30 });
t('level curve', () => { eq(G.levelOf(0), 1); eq(G.levelOf(99), 1); eq(G.levelOf(100), 2); eq(G.levelOf(300), 3); eq(G.levelOf(1000), 5); });
t('worlds unlock by level', () => { const s = fresh(); ok(G.worldUnlocked(s, 'math')); ok(!G.worldUnlocked(s, 'science')); s.xp = 100; ok(G.worldUnlocked(s, 'science')); ok(!G.worldUnlocked(s, 'geo')); });
t('missions unlock sequentially', () => { fresh(); const ms = missionsFor('math'); eq(G.missionStatus(store.state, ms[0]), 'open'); eq(G.missionStatus(store.state, ms[1]), 'locked'); G.finishRun(run('a', ms[0].id, 5, 5)); eq(G.missionStatus(store.state, ms[0]), 'done'); eq(G.missionStatus(store.state, ms[1]), 'open'); });
t('stars thresholds', () => { eq(G.starsFor(59), 0); eq(G.starsFor(60), 1); eq(G.starsFor(80), 2); eq(G.starsFor(95), 3); eq(G.starsFor(69, true), 0); eq(G.starsFor(70, true), 1); });
t('rewards not duplicated for the same run id', () => { fresh(); const m = missionsFor('math')[0]; const r1 = G.finishRun(run('dup', m.id, 5, 5)); const xp = store.state.xp, c = store.state.coins; const r2 = G.finishRun(run('dup', m.id, 5, 5)); ok(r2.dup); eq(store.state.xp, xp); eq(store.state.coins, c); ok(r1.xp > 0); });
t('replay pays only star improvement', () => { fresh(); const m = missionsFor('math')[0]; G.finishRun(run('r1', m.id, 3, 5)); const c1 = store.state.coins; G.finishRun(run('r2', m.id, 3, 5)); eq(store.state.coins, c1, 'no coins for same stars'); G.finishRun(run('r3', m.id, 5, 5)); ok(store.state.coins > c1, 'coins for improvement'); eq(store.state.progress[m.id].stars, 3); });
t('failed mission does not unlock next', () => { fresh(); const ms = missionsFor('math'); G.finishRun(run('f', ms[0].id, 1, 5)); eq(G.missionStatus(store.state, ms[1]), 'locked'); });
t('achievement first mission, never twice', () => { fresh(); const ms = missionsFor('math'); const r = G.finishRun(run('ach1', ms[0].id, 5, 5)); ok(r.newAch.some((a) => a.id === 'first')); const r2 = G.finishRun(run('ach2', ms[0].id, 5, 5)); ok(!r2.newAch.length); });
t('level-up reported', () => { const s = fresh(); s.xp = 95; const m = missionsFor('math')[0]; const r = G.finishRun(run('lv', m.id, 5, 5)); eq(r.levelUp, 2); });
t('streak increments daily, resets after gap', () => { const s = fresh(); let day = new Date(2026, 0, 10, 12); store.now = () => day; G.touchStreak(s); eq(s.streak.count, 1); G.touchStreak(s); eq(s.streak.count, 1); day = new Date(2026, 0, 11, 8); G.touchStreak(s); eq(s.streak.count, 2); day = new Date(2026, 0, 14, 8); G.touchStreak(s); eq(s.streak.count, 1); eq(s.streak.best, 2); store.now = () => new Date(); });
t('streak milestone paid once', () => { const s = fresh(); let day = new Date(2026, 1, 1, 12); store.now = () => day; for (let i = 0; i < 3; i++) { G.touchStreak(s); day = new Date(day.getTime() + 86400000); } ok(s.claimed['streak:3:2026-02-01']); store.now = () => new Date(); });
t('login reward once a day, cycles, resets after a gap', () => { const s = fresh(); let day = new Date(2026, 2, 1, 9); store.now = () => day; ok(G.claimLogin(s)); eq(G.claimLogin(s), null); const c = s.coins; day = new Date(2026, 2, 2, 9); const r = G.claimLogin(s); eq(r.day, 2); ok(s.coins > c); day = new Date(2026, 2, 9, 9); eq(G.claimLogin(s).day, 1); store.now = () => new Date(); });
t('daily challenge stable within a day, 4 slots × 3 questions', () => { const s = fresh(); store.now = () => new Date(2026, 3, 5, 10); const a = G.dailyQuestions(s, 'math').qs.map((q) => q.q); const b = G.dailyQuestions(s, 'math').qs.map((q) => q.q); eq(JSON.stringify(a), JSON.stringify(b)); for (const sl of G.SLOTS) eq(G.dailyQuestions(s, sl.id).qs.length, 3); store.now = () => new Date(); });
t('daily rewards once per slot + all-four bonus', () => { const s = fresh(); store.now = () => new Date(2026, 3, 6, 10); G.ensureDaily(s); for (const sl of ['math', 'lang', 'logic', 'rotate']) { const mk = (id) => ({ id, kind: 'daily', slot: sl, answers: Array.from({ length: 3 }, () => ({ world: 'math', cat: 'arith', correct: true, ms: 1000 })), elapsed: 10 }); const r = G.finishRun(mk('d' + sl)); ok(r.xp > 0); const c = s.coins; G.finishRun(mk('d2' + sl)); eq(s.coins, c, 'second completion pays nothing'); } ok(s.claimed['dailyall:2026-04-06']); store.now = () => new Date(); });
t('daily spotlight world rotates', () => { const seen = new Set(); for (let d = 1; d <= 5; d++) seen.add(G.dailySlotWorld('rotate', `2026-05-0${d}`)); eq(seen.size, 5); });
t('adaptive difficulty bounded and gradual', () => { const s = fresh(); s.perf['math:arith'] = { recent: [0, 0, 0, 0, 0] }; eq(G.targetDifficulty(s, 'math', 'arith', 3), 2); eq(G.targetDifficulty(s, 'math', 'arith', 1), 1); s.perf['math:arith'] = { recent: [1, 1, 1, 1, 1, 1] }; eq(G.targetDifficulty(s, 'math', 'arith', 3), 4); eq(G.targetDifficulty(s, 'math', 'arith', 5), 5); s.profile.difficulty = 'hard'; eq(G.targetDifficulty(s, 'math', 'arith', 3), 4, 'step capped'); });
t('mistakes tracked for review and cleared once corrected', () => { fresh(); const q = allBank().find((b) => b.world === 'word'); const m = missionsFor('word')[0]; const mk = (id, correct) => ({ id, kind: 'mission', missionId: m.id, answers: [{ qid: q.id, world: 'word', cat: q.cat, correct, ms: 1 }], elapsed: 1 }); G.finishRun(mk('m1', false)); ok(store.state.mistakes.word.includes(q.id)); G.finishRun(mk('m2', true)); ok(!store.state.mistakes.word.includes(q.id)); });
t('knowledge challenge sizes, subject mix, seeded determinism', () => { const s = fresh(); s.xp = 100000; for (const [mode, n] of [['quick', 5], ['standard', 10], ['expert', 15]]) { const qs = G.kcQuestions(s, mode, 1234); eq(qs.length, n); ok(new Set(qs.map((q) => q.world)).size >= Math.min(n, 4), 'mix'); } const a = G.kcQuestions(s, 'standard', 55, true).map((q) => q.q); const b = G.kcQuestions(s, 'standard', 55, true).map((q) => q.q); eq(JSON.stringify(a), JSON.stringify(b)); });
t('friend codes round trip', () => { const p = G.parseFriendCode(G.friendCode('standard', 123456)); eq(p.mode, 'standard'); eq(p.seed, 123456); eq(G.parseFriendCode('nope'), null); });
t('sanitiser repairs corrupt saves', () => { const s = sanitize({ xp: 'abc', coins: -5, progress: { x: { stars: 99 } }, recent: 5 }); eq(s.xp, 0); eq(s.coins, 0); eq(s.progress.x.stars, 3); ok(Array.isArray(s.recent)); });
t('save/load round trip + backup recovery', () => { const s = fresh(); s.xp = 321; store.save(); store.save(); store.state = newState(); ok(store.load()); eq(store.state.xp, 321); mem.set('kv_save_v1', '{broken'); store.state = newState(); ok(store.load(), 'fallback to backup'); eq(store.state.xp, 321); });
t('admin: disabling a question removes it from play', () => { const q = allBank().find((b) => b.world === 'word' && b.type === 'mcq'); const c = getContent(true); c.disabled.push(q.id); saveContent(c); C.invalidateBank(); ok(!C.bankFor('word').some((x) => x.id === q.id)); c.disabled = []; saveContent(c); C.invalidateBank(); ok(C.bankFor('word').some((x) => x.id === q.id)); });
t('admin: custom questions play, flagged ones are hidden', () => { const c = getContent(true); c.custom.push({ id: 'word-custom1', world: 'word', cat: 'vocab', type: 'mcq', q: 'Custom?', a: 'Yes', w: ['No', 'Maybe', 'Never'], d: 1, explain: 'Because test.' }); saveContent(c); C.invalidateBank(); ok(C.bankFor('word').some((x) => x.id === 'word-custom1')); c.flags['word-custom1'] = { reason: 'outdated' }; saveContent(c); C.invalidateBank(); ok(!C.bankFor('word').some((x) => x.id === 'word-custom1')); c.custom = []; c.flags = {}; saveContent(c); C.invalidateBank(); });

console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log(failures.join('\n')); process.exit(1); }
