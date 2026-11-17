// Gameplay screen + results. A run is persisted after every answer so interrupted sessions can resume.
import { store, isChild } from './store.js';
import { esc } from './util.js';
import { worldById, missionById, missionsFor } from './content/index.js';
import * as G from './game.js';
import { view, go, setCleanup } from './router.js';
import { $, $$, modal, closeModal, toast, stars, themeStyle, celebrate, confirmBox, gate } from './ui.js';
import { mountQuestion, correctAnswerText } from './qtypes.js';
import { sound, haptic } from './audio.js';
import { showRewarded, grantRewardCoins, adsAllowedByParent, maybeInterstitial, bannerVisible } from './ads.js';
import { track } from './analytics.js';
import { getContent } from './contentStore.js';

let run = null, timer = null, qStart = 0, handle = null, answered = false, hintUsed = false, retried = false, pausedAt = 0;
const HINT_COST = 5;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function limitReached() {
  const p = store.state.parental; if (!p.dailyLimitMin) return false; const t = G.today();
  return p.usedToday.date === t && p.usedToday.sec >= p.dailyLimitMin * 60;
}
function tickUsage() { const p = store.state.parental; const t = G.today(); if (p.usedToday.date !== t) p.usedToday = { date: t, sec: 0 }; p.usedToday.sec++; }

function begin(r) {
  if (limitReached()) { toast('😴 Today’s play-time limit has been reached'); go('/home'); return; }
  run = { ...r, id: r.id || uid(), idx: 0, answers: [], elapsed: 0, timeLeft: r.time || 0 };
  persist(); track('session', {}); go('/play');
}
// Save the run; a question that is already answered counts as done so a resume never re-asks it.
const persist = () => { const idx = run.idx + (answered && run.answers[run.idx] ? 1 : 0); store.state.session = { ...run, idx }; store.save(); };
export function startMission(mid) {
  const m = missionById(mid); const s = store.state; const qs = G.buildQuestions(s, m);
  begin({ kind: 'mission', missionId: mid, world: m.world, title: m.title, qs, time: m.time, boss: m.boss });
}
export function startDaily(slot) {
  const s = store.state; const d = G.ensureDaily(s); const { world, qs } = G.dailyQuestions(s, slot); const sl = G.SLOTS.find((x) => x.id === slot);
  begin({ kind: 'daily', slot, world, title: sl.name, qs, time: 0, id: `daily:${d.date}:${slot}:${uid()}` });
}
export function startKC(mode, { seed = null, code = null } = {}) {
  const s = store.state; const sd = seed ?? Math.floor(Math.random() * 2 ** 31); const friend = !!code; const qs = G.kcQuestions(s, mode, sd, friend);
  begin({ kind: friend ? 'friend' : 'kc', mode, seed: sd, code: code || G.friendCode(mode, sd), world: 'math', title: G.KC_MODES[mode].name, qs, time: G.KC_MODES[mode].time });
}
export function resumeSession() { const sess = store.state.session; if (!sess) return; run = { ...sess }; go('/play'); }
export async function abandonSession() { store.state.session = null; run = null; store.save(); }

export function playScreen() {
  if (!run) { if (store.state.session) run = { ...store.state.session }; else return go('/home'); }
  const w = worldById(run.world); const kcMulti = run.kind === 'kc' || run.kind === 'friend';
  if (run.idx >= run.qs.length) return finish();
  const q = run.qs[run.idx]; const qw = kcMulti || run.kind === 'daily' ? worldById(q.world) || w : w;
  const html = `<div class="play-top" style="${themeStyle(qw)}"><button class="back" id="exit" aria-label="Exit mission">✕</button><div class="grow"><div class="small" style="opacity:.9">${qw.emoji} ${esc(kcMulti ? `${qw.name} · ${run.title}` : run.title)}</div><div class="bar" role="progressbar" aria-valuenow="${run.idx}" aria-valuemax="${run.qs.length}" aria-label="Progress"><i style="width:${(run.idx / run.qs.length) * 100}%"></i></div></div><span class="chip" style="color:var(--ink)" id="count">${run.idx + 1}/${run.qs.length}</span>${run.time ? `<span class="chip" style="color:var(--ink)" id="tm" aria-label="Time left">⏱ ${fmt(run.timeLeft)}</span>` : ''}</div>
  <div class="qcard" id="qcard" style="${themeStyle(qw)}">${q.review ? '<span class="pill warn" style="margin-bottom:8px">🔁 Review of an earlier question</span>' : ''}<div id="qbox"></div></div>
  <div id="fb"></div>
  <div class="row" style="margin:12px 14px" id="tools"><button class="btn ghost small" id="hint">💡 Hint <span class="pill warn">${HINT_COST} 🪙</span></button><span class="grow"></span><span class="chip" id="coins">🪙 ${store.state.coins}</span></div>`;
  view(html, { nav: false, banner: false, world: qw.id });
  answered = false; hintUsed = false; retried = false; qStart = Date.now();
  mountQ(q);
  $('#exit').addEventListener('click', onExit); $('#hint').addEventListener('click', onHint);
  startTimer(); setCleanup(() => { clearInterval(timer); timer = null; });
}
const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
function mountQ(q) {
  const box = $('#qbox'); handle = mountQuestion(q, box, { fast: false, done: (res) => onAnswered(q, res) });
}
function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (document.hidden) return; run.elapsed++; tickUsage();
    if (run.time) { run.timeLeft--; const el = $('#tm'); if (el) { el.textContent = '⏱ ' + fmt(run.timeLeft); if (run.timeLeft <= 10) el.style.background = '#fecaca'; } if (run.timeLeft <= 0) { timeUp(); } }
    if (limitReached()) { clearInterval(timer); persist(); modal('<div class="center"><div class="big">😴</div><h2>Time for a break</h2><p class="muted">Today’s play-time limit is reached. Your progress is saved — you can resume tomorrow.</p><button class="btn block" data-close="">OK</button></div>').then(() => go('/home')); }
  }, 1000);
}
function timeUp() {
  clearInterval(timer); sound.wrong(); toast('⏰ Time’s up!');
  const q = run.qs[run.idx]; if (!answered) { run.answers.push(ans(q, false, 0, null, true)); }
  for (let i = run.answers.length; i < run.qs.length; i++) run.answers.push(ans(run.qs[i], false, 0, null, true));
  run.idx = run.qs.length; run.timedOut = true; finish();
}
const ans = (q, correct, ms, given, skipped = false) => ({ qid: q.id || null, world: q.world, cat: q.cat, type: q.type, correct, ms, hint: hintUsed, skipped, q: q.q, given });

async function onHint() {
  if (answered || hintUsed || !handle) return; const s = store.state;
  if (s.coins >= HINT_COST) { if (handle.hint()) { hintUsed = true; s.coins -= HINT_COST; store.save(); $('#coins').textContent = `🪙 ${s.coins}`; $('#hint').disabled = true; sound.tap(); } return; }
  if (!adsAllowedByParent() || !(bannerVisible() || getContent().ads.rewardedEnabled)) { toast('Not enough coins for a hint yet — keep playing!'); return; }
  const ok = await confirmBox('Need a hint?', `You need ${HINT_COST} coins. You can watch an optional ad to get a free hint.`, '📺 Watch ad', 'No thanks');
  if (!ok) return; if (isChild() && !(await gate('A grown-up needs to say OK to watch an ad.'))) return;
  const r = await showRewarded('hint'); if (r.status === 'rewarded') { if (handle.hint()) { hintUsed = true; store.state.ads.hintsFromAds++; grantRewardCoins(r.token, 0); $('#hint').disabled = true; } } else toast(r.status === 'dismissed' ? 'Ad closed — no hint this time.' : 'No ad available right now. Try again later!');
}

function onAnswered(q, res) {
  if (answered) return; answered = true; const ms = Date.now() - qStart; const ok = !!res.correct;
  run.answers[run.idx] = ans(q, ok, ms, res.given); ok ? sound.correct() : sound.wrong(); haptic(ok ? 15 : 40);
  persist();
  const last = run.idx === run.qs.length - 1; const cert = q.certainty === 'debated';
  const canRetry = !ok && !run.time && !retried && ['mcq', 'input'].includes(q.type) && adsAllowedByParent() && getContent().ads.rewardedEnabled && (bannerVisible());
  $('#hint').disabled = true;
  $('#fb').innerHTML = `<div class="fb ${ok ? 'good' : 'bad'}" role="status"><h3>${ok ? '✓ Correct!' : '✗ Not quite'}</h3>${!ok ? `<p><b>Answer:</b> ${esc(res.reveal || correctAnswerText(q))}</p>` : ''}${q.explain ? `<p>${esc(q.explain)}</p>` : ''}${cert ? '<p class="small"><span class="pill warn">Historians/experts debate details here</span></p>' : ''}${res.given && q.type === 'map' ? `<p class="small muted">${esc(res.given)}</p>` : ''}
  <div class="row" style="margin-top:10px">${q.id ? '<button class="btn ghost small" id="rep" aria-label="Report a problem with this question">⚑ Report</button>' : ''}${canRetry ? '<button class="btn ghost small" id="retry">📺 Try again</button>' : ''}<span class="grow"></span><button class="btn ${ok ? 'green' : ''}" id="next">${last ? 'See results' : 'Next ›'}</button></div></div>`;
  $('#next').focus({ preventScroll: false }); $('#fb').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#next').addEventListener('click', next);
  $('#rep')?.addEventListener('click', () => report(q));
  $('#retry')?.addEventListener('click', async () => {
    if (isChild() && !(await gate('A grown-up needs to say OK to watch an ad.'))) return;
    const r = await showRewarded('retry'); if (r.status !== 'rewarded') { toast('No ad available right now.'); return; }
    retried = true; answered = false; $('#fb').innerHTML = ''; $('#hint').disabled = true; qStart = Date.now(); mountQ(q); toast('Second chance!');
  });
}
function next() { run.idx++; persist(); if (run.idx >= run.qs.length) return finish(); playScreen(); }
async function report(q) {
  const p = modal(`<h2>⚑ Report this question</h2><p class="muted small">Tell us what’s wrong (outdated, incorrect, unclear). Please don’t include personal details.</p><label class="field"><span>What’s wrong?</span><input id="rr" type="text" maxlength="160"></label><div class="row"><button class="btn ghost grow" data-close="">Cancel</button><button class="btn grow" id="rs">Send</button></div>`);
  $('#rs').addEventListener('click', () => { const v = $('#rr').value.trim(); if (!v) return; track('report', { qid: q.id, reason: v }); closeModal('sent'); });
  if ((await p) === 'sent') toast('Thanks! A content reviewer will take a look.');
}
async function onExit() {
  const ok = await confirmBox('Leave mission?', 'Your progress is saved — you can resume from Home. Rewards are given when you finish.', 'Leave', 'Keep playing'); if (!ok) return;
  clearInterval(timer); persist(); go('/home');
}
document.addEventListener('visibilitychange', () => { if (document.hidden && run && store.state.session) { try { persist(); } catch { /* ignore */ } } });

function finish() {
  clearInterval(timer); const r = run; run = null; store.state.session = null;
  const res = G.finishRun({ id: r.id, kind: r.kind, missionId: r.missionId, slot: r.slot, mode: r.mode, code: r.code, answers: r.answers, elapsed: r.elapsed, timedOut: r.timedOut });
  track('answers', { n: r.answers.length, c: r.answers.filter((a) => a.correct).length, sec: r.elapsed }); if (r.kind === 'mission') track('mission', { world: r.world });
  syncAfter(); results(r, res);
}
const syncAfter = () => { store.save(); };

function results(r, res) {
  const s = store.state; const w = worldById(r.world); const m = r.kind === 'mission' ? missionById(r.missionId) : null; const pct = Math.round(res.pct);
  const worlds = [...new Set(r.answers.map((a) => a.world))];
  const by = worlds.map((id) => { const a = r.answers.filter((x) => x.world === id); return { w: worldById(id), c: a.filter((x) => x.correct).length, n: a.length }; });
  const title = r.kind === 'mission' ? (res.passed ? (m.boss ? '👑 Boss defeated!' : 'Mission complete!') : 'Keep going!') : r.kind === 'daily' ? 'Daily challenge done!' : 'Challenge finished!';
  const nextM = m && res.passed ? missionsFor(m.world).filter((x) => x.published).find((x) => G.missionStatus(s, x) === 'open' && x.id !== m.id) : null;
  const html = `<div class="world-hero" style="${themeStyle(w)};text-align:center"><div class="big" style="font-size:3rem">${res.passed ? '🎉' : '💪'}</div><h1>${title}</h1><p style="max-width:none">${esc(r.title)}</p></div>
  <div class="section stack"><div class="card center"><div class="starrow" aria-label="${res.stars} stars">${[0, 1, 2].map((i) => `<span class="${i < res.stars ? 'on' : ''}" style="animation-delay:${i * 0.25}s">★</span>`).join('')}</div><h2>${res.correct}/${res.total} correct · ${pct}%</h2>${res.score !== undefined ? `<p><b>Score: ${res.score}</b>${s.bests[r.kind === 'friend' ? 'friend:' + r.code : 'kc:' + r.mode] === res.score ? ' 🏅 Personal best!' : ''}</p>` : ''}${!res.passed && r.kind === 'mission' ? '<p class="muted">You need 60% for a star. Review the answers below and try again!</p>' : ''}${res.dup ? '<p class="muted small">Rewards for this run were already counted.</p>' : ''}</div>
  ${res.dup ? '' : `<div class="card"><div class="grid3 center"><div class="stat"><b>+${Math.round(res.xp)}</b><span class="small muted">XP</span></div><div class="stat"><b>+${res.coins}</b><span class="small muted">🪙 coins</span></div><div class="stat"><b>${G.streakAlive(s)}🔥</b><span class="small muted">day streak</span></div></div>${res.dailyAll ? '<p class="center pill good">🎁 All four daily challenges done: bonus!</p>' : ''}${res.worldComplete ? '<p class="center pill good">🏆 World complete bonus!</p>' : ''}${res.streakRewards.map((g) => `<p class="center pill good">🔥 ${g.n}-day streak reward +${g.coins} 🪙</p>`).join('')}</div>`}
  ${res.newAch.length ? `<div class="card" style="background:#fff7d6"><h3>🏅 New achievement${res.newAch.length > 1 ? 's' : ''}!</h3>${res.newAch.map((a) => `<div class="row" style="margin-top:6px"><span class="big" aria-hidden="true">${a.emoji}</span><div><b>${a.name}</b><div class="small muted">${a.desc} · +${a.coins} 🪙</div></div></div>`).join('')}</div>` : ''}
  ${by.length > 1 || r.kind !== 'mission' ? `<div class="card"><h3>Subject performance</h3>${by.map((b) => `<div class="row" style="margin:6px 0"><span aria-hidden="true">${b.w.emoji}</span><span class="grow small">${b.w.name}</span><div class="bar" style="width:100px"><i style="width:${(b.c / b.n) * 100}%"></i></div><span class="small">${b.c}/${b.n}</span></div>`).join('')}</div>` : ''}
  ${!res.dup && res.coins > 0 && adsAllowedByParent() && getContent().ads.rewardedEnabled && bannerVisible() ? `<div class="card flat row"><div class="grow"><b>Bonus coins?</b><div class="small muted">Optional: watch an ad for +${res.coins} extra 🪙</div></div><button class="btn gold small" id="bonus">📺 Bonus</button></div>` : ''}
  <div class="card"><h3>Review</h3>${r.answers.map((a, i) => `<details style="margin:6px 0"><summary>${a.correct ? '✅' : '❌'} ${esc((a.q || '').slice(0, 70))}${a.skipped ? ' (time up)' : ''}</summary><div class="small muted" style="padding:6px 0 0 22px">${esc(correctExplain(r.qs[i], a))}</div></details>`).join('')}</div>
  <div class="row wrap" style="gap:10px">${r.kind === 'mission' ? `<button class="btn ghost grow" id="again">↻ ${res.passed ? 'Replay' : 'Try again'}</button>${nextM ? '<button class="btn green grow" id="nextm">Next mission ▶</button>' : '<button class="btn grow" id="back">Back</button>'}` : '<button class="btn ghost grow" id="back">Home</button>' + (r.kind !== 'daily' ? '<button class="btn grow" id="again">↻ Play again</button>' : '<button class="btn grow" id="daily">Daily list</button>')}</div>
  ${r.kind === 'kc' || r.kind === 'friend' ? `<div class="card flat center small">Challenge a friend: share code <b>${esc(r.code)}</b> — they get the same questions.</div>` : ''}</div>`;
  view(html, { nav: false, banner: false, world: r.world });
  if (res.passed && !res.dup) celebrate(res.stars === 3 || m?.boss ? 'reward' : 'correct');
  if (res.levelUp) setTimeout(() => levelUp(res.levelUp), 700);
  else if (res.newAch.length) setTimeout(() => { celebrate('achievement'); }, 600);
  const leave = async (dest) => { await maybeInterstitial(); dest(); };
  $('#again')?.addEventListener('click', () => leave(() => (r.kind === 'mission' ? startMission(r.missionId) : startKC(r.mode))));
  $('#nextm')?.addEventListener('click', () => leave(() => go(`/world/${m.world}`)));
  $('#back')?.addEventListener('click', () => leave(() => go(r.kind === 'mission' ? `/world/${m.world}` : '/home')));
  $('#daily')?.addEventListener('click', () => leave(() => go('/daily')));
  $('#bonus')?.addEventListener('click', async (e) => { const b = e.currentTarget; if (isChild() && !(await gate('A grown-up needs to say OK to watch an ad.'))) return; b.disabled = true; const rr = await showRewarded('bonus'); if (rr.status === 'rewarded') { grantRewardCoins(rr.token, res.coins); celebrate('reward'); toast(`+${res.coins} bonus coins!`); b.closest('.card').innerHTML = '<p class="center">✅ Bonus coins added!</p>'; } else { b.disabled = false; toast('No ad available right now.'); } });
}
function correctExplain(q, a) { if (!q) return ''; return `${a.correct ? '' : 'Answer: ' + correctAnswerText(q) + '. '}${q.explain || ''}`; }
async function levelUp(L) {
  const newly = (await import('./content/index.js')).WORLDS.filter((w) => w.unlockLevel === L);
  celebrate('unlock'); await modal(`<div class="center"><div class="big" style="font-size:3.4rem">🎉</div><h2>Level ${L}!</h2><p class="muted">You’re getting stronger.</p>${newly.map((w) => `<div class="card" style="${themeStyle(w)};margin-top:10px;background:linear-gradient(150deg,var(--w1),var(--w2));color:#fff"><div class="big">${w.emoji}</div><b>New world unlocked: ${w.name}!</b><div class="small">${esc(w.tagline)}</div></div>`).join('')}<button class="btn block" style="margin-top:14px" data-close="">Awesome!</button></div>`);
}
