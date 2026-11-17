// Splash, onboarding, home, world map, world dashboard, mission briefing.
import { store, isChild } from './store.js';
import { esc } from './util.js';
import { WORLDS, worldById, missionsFor, missionById, TIERS } from './content/index.js';
import * as G from './game.js';
import { view, go, bindGo, setCleanup } from './router.js';
import { $, $$, modal, closeModal, toast, scene, stars, themeStyle, celebrate, gate } from './ui.js';
import { LANGUAGES } from './i18n.js';
import { sound, syncMusic } from './audio.js';
import { startMission, resumeSession, limitReached } from './play.js';
import { initAds } from './ads.js';

export const AVATARS = ['🦊', '🐼', '🦁', '🐸', '🦄', '🐙', '🐧', '🦉', '🐯', '🤖', '👩‍🚀', '🧙'];
const AGES = [['5-8', '5–8 years', '🧒'], ['9-12', '9–12 years', '🧑‍🎓'], ['13-15', '13–15 years', '🧑'], ['16-18', '16–18 years', '🎓'], ['adult', 'Adult', '🧑‍💼']];

export function splash() {
  view(`<div class="splash"><div><div class="orb">🌌</div><div class="logo">KnowledgeVerse</div><p style="opacity:.85">One Game. Multiple Learning Worlds.</p></div></div>`, { nav: false });
  const to = setTimeout(() => { store.state.profile ? go('/home') : go('/welcome'); }, 1100); setCleanup(() => clearTimeout(to));
}

export function onboarding() {
  const d = { step: 0, name: '', age: null, lang: 'en', interests: [], difficulty: 'auto', avatar: '🦊', guest: false };
  const steps = 5;
  const draw = () => {
    const dots = `<div class="steps">${Array.from({ length: steps }, (_, i) => `<i class="${i <= d.step ? 'on' : ''}"></i>`).join('')}</div>`;
    let body = '';
    if (d.step === 0) body = `<div class="center"><div class="big">👋</div><h2>Welcome, explorer!</h2><p class="muted">Pick a nickname. Please <b>don’t use your real name</b> or any contact details.</p></div><label class="field"><span>Nickname</span><input id="nm" type="text" maxlength="16" autocomplete="off" value="${esc(d.name)}" placeholder="e.g. StarFox"></label><p class="small" id="err" style="color:var(--bad)"></p><div class="center"><span class="muted small">Pick your hero:</span></div><div class="choices" style="justify-content:center;margin-top:6px">${AVATARS.map((a) => `<button class="choice" aria-pressed="${d.avatar === a}" data-av="${a}" aria-label="Avatar ${a}">${a}</button>`).join('')}</div>`;
    if (d.step === 1) body = `<h2 class="center">How old are you?</h2><p class="muted center">This keeps content and settings age-appropriate. We never ask for your birthday.</p><div class="opts" style="margin-top:12px">${AGES.map(([id, n, e]) => `<button class="opt ${d.age === id ? 'sel' : ''}" data-age="${id}"><span>${e}</span><span>${n}</span></button>`).join('')}</div>`;
    if (d.step === 2) body = `<h2 class="center">Language</h2><div class="opts" style="margin-top:12px">${LANGUAGES.map((l) => `<button class="opt ${d.lang === l.code ? 'sel' : ''}" data-lang="${l.code}" ${l.ready ? '' : 'disabled'}><span>${l.name}</span>${l.ready ? '' : '<span class="tag pill">coming soon</span>'}</button>`).join('')}</div>`;
    if (d.step === 3) body = `<h2 class="center">What do you love?</h2><p class="muted center">Pick any — we’ll recommend worlds. (Optional)</p><div class="choices" style="justify-content:center;margin-top:10px">${WORLDS.map((w) => `<button class="choice" aria-pressed="${d.interests.includes(w.id)}" data-int="${w.id}">${w.emoji} ${w.name.split(' ')[0]}</button>`).join('')}</div>`;
    if (d.step === 4) body = `<h2 class="center">Challenge level</h2><p class="muted center">You can change this any time in Settings.</p><div class="opts" style="margin-top:12px">${[['auto', '🎯 Just right', 'Adapts to how you play (recommended)'], ['easy', '🌱 Relaxed', 'Gentler questions and more practice'], ['normal', '⚖️ Balanced', 'Standard difficulty'], ['hard', '🔥 Challenging', 'Tougher questions sooner']].map(([id, n, s]) => `<button class="opt ${d.difficulty === id ? 'sel' : ''}" data-df="${id}"><span><b>${n}</b><br><small class="muted">${s}</small></span></button>`).join('')}</div>`;
    view(`<div class="pad" style="padding-top:22px">${dots}${body}<div class="row" style="margin-top:18px">${d.step > 0 ? '<button class="btn ghost" id="bk">Back</button>' : ''}<button class="btn grow" id="nx">${d.step === steps - 1 ? 'Start adventure 🚀' : 'Next'}</button></div>${d.step === 0 ? '<p class="center small muted" style="margin-top:12px"><a href="#" id="guest">Skip — play as guest</a></p>' : ''}<p class="center small muted" style="margin-top:14px">🔒 Your progress stays on this device. No account needed.</p></div>`, { nav: false });
    const app = $('#app');
    app.querySelectorAll('[data-av]').forEach((b) => b.addEventListener('click', () => { d.name = $('#nm').value; d.avatar = b.dataset.av; draw(); }));
    app.querySelectorAll('[data-age]').forEach((b) => b.addEventListener('click', () => { d.age = b.dataset.age; draw(); }));
    app.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => { d.lang = b.dataset.lang; draw(); }));
    app.querySelectorAll('[data-int]').forEach((b) => b.addEventListener('click', () => { const i = d.interests.indexOf(b.dataset.int); i >= 0 ? d.interests.splice(i, 1) : d.interests.push(b.dataset.int); draw(); }));
    app.querySelectorAll('[data-df]').forEach((b) => b.addEventListener('click', () => { d.difficulty = b.dataset.df; draw(); }));
    $('#bk')?.addEventListener('click', () => { if (d.step === 0) return; if (d.step === 1) d.name = d.name; d.step--; draw(); });
    $('#guest')?.addEventListener('click', (e) => { e.preventDefault(); d.name = 'Guest'; d.guest = true; d.step = 1; draw(); });
    $('#nx').addEventListener('click', () => {
      if (d.step === 0) { const n = ($('#nm').value || '').trim(); const err = nameError(n); if (err) { $('#err').textContent = err; return; } d.name = n; }
      if (d.step === 1 && !d.age) { toast('Please choose an age group'); return; }
      if (d.step < steps - 1) { d.step++; draw(); return; }
      finish();
    });
  };
  const finish = () => {
    const s = store.state; s.profile = { name: d.name || 'Guest', age: d.age, lang: d.lang, interests: d.interests, difficulty: d.difficulty, avatar: d.avatar, guest: d.guest, createdAt: Date.now() };
    s.parental.social = isChild(s) ? false : true; s.privacy.personalisedAds = false; store.save(); initAds(); go('/home'); setTimeout(() => G.claimLogin && toastLogin(), 400);
  };
  draw();
}
export function nameError(n) {
  if (n.length < 2) return 'Nickname needs at least 2 characters.'; if (n.length > 16) return 'Nickname is too long.';
  if (/@|https?:|www\./i.test(n) || (n.match(/\d/g) || []).length >= 6) return 'Please don’t use emails, links or phone numbers.';
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(n)) return 'Use letters, numbers and simple symbols only.'; return '';
}
function toastLogin() { /* login reward is claimed from the Daily screen or Home card */ }

// ---------- Home ----------
export function home() {
  const s = store.state; const p = s.profile; const xp = G.xpProgress(s.xp); const streak = G.streakAlive(s); const daily = G.ensureDaily(s);
  const next = G.nextMission(s); const rec = G.recommend(s); const login = G.loginRewardState(s); const sess = s.session;
  const doneSlots = Object.keys(daily.done).length;
  const limit = limitReached();
  const html = `
  <div class="top"><div class="row"><div class="avatar" aria-hidden="true">${p.avatar}</div><div class="grow"><div class="row between"><b style="font-size:1.1rem">${esc(p.name)}</b><span class="chip" title="Player level">⭐ Lv ${xp.level}</span></div>
    <div class="xpbar" role="progressbar" aria-valuenow="${Math.round(xp.pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="XP progress"><i style="width:${xp.pct}%"></i></div><div class="small" style="opacity:.9">${xp.into} / ${xp.need} XP to level ${xp.level + 1}</div></div></div>
    <div class="row wrap" style="margin-top:10px"><span class="chip">🪙 ${s.coins}</span><span class="chip">🔥 ${streak} day${streak === 1 ? '' : 's'}</span><span class="chip">★ ${G.totalStars(s)}</span></div></div>
  <div class="section stack" style="margin-top:-10px">
    ${limit ? `<div class="card" style="border:2px solid #fca5a5"><h3>😴 Time for a break!</h3><p class="muted">You’ve reached today’s play-time limit set by a grown-up. See you tomorrow!</p></div>` : ''}
    ${sess ? `<div class="card themed" style="${themeStyle(worldById(sess.world))}"><div class="small" style="opacity:.9">${G.KC_MODES[sess.mode]?.name || (sess.kind === 'daily' ? 'Daily challenge' : 'Mission in progress')}</div><h3>${esc(sess.title)}</h3><p class="small">Question ${sess.idx + 1} of ${sess.qs.length}</p><button class="btn gold block" id="resume">▶ Resume</button></div>`
      : next ? `<div class="card themed" style="${themeStyle(worldById(next.world))}"><div class="small" style="opacity:.9">${worldById(next.world).emoji} ${worldById(next.world).name} · ${home_s(next)}</div><h3>${home_continueLabel(s, next)}: ${esc(next.title)}</h3><p class="small" style="opacity:.92">${esc(next.desc)}</p><button class="btn gold block" id="cont" style="margin-top:8px">▶ ${s.stats.missions ? 'Continue playing' : 'Play your first mission'}</button></div>` : `<div class="card"><h3>🎉 You’ve cleared every open mission!</h3><p class="muted">Replay missions for more stars, or take a Knowledge Challenge.</p></div>`}
    ${login.claimedToday ? '' : `<div class="card row" style="background:#fff7d6"><div class="big" aria-hidden="true">🎁</div><div class="grow"><b>Daily login reward</b><div class="small muted">Day ${login.day}: +${login.amount} coins</div></div><button class="btn gold small" id="claim">Claim</button></div>`}
    <div class="card row" data-go="/daily" role="button" tabindex="0" style="cursor:pointer"><div class="big" aria-hidden="true">📅</div><div class="grow"><b>Daily mission</b><div class="small muted">${doneSlots}/4 challenges done today${G.ensureDaily(s) && doneSlots === 4 ? ' 🎉' : ''}</div><div class="bar" style="margin-top:6px"><i style="width:${doneSlots * 25}%"></i></div></div><span aria-hidden="true">›</span></div>
    <div class="card row" data-go="/world/${rec.world.id}" role="button" tabindex="0" style="cursor:pointer;${themeStyle(rec.world)}"><div class="big" aria-hidden="true">${rec.world.emoji}</div><div class="grow"><div class="small muted">${esc(String(G.worldUnlockText(s, rec.world.id)))} · Recommended for you</div><b>${rec.world.name}</b><div class="small muted">${esc(rec.reason)}</div></div><span aria-hidden="true">›</span></div>
  </div>
  <div class="section"><div class="row between"><h3>World map</h3><a href="#/map" data-go="/map" class="small" style="color:var(--p);font-weight:800">See all ›</a></div></div>
  <div class="hscroll">${WORLDS.map((w) => worldCard(s, w)).join('')}</div>
  <div class="section"><button class="card row block" data-go="/challenge" style="width:100%;border:0;font:inherit;text-align:left;cursor:pointer;background:linear-gradient(120deg,#fde68a,#fbcfe8)"><div class="big" aria-hidden="true">🌠</div><div class="grow"><b>Knowledge Challenge</b><div class="small">Mixed questions from many worlds · Quick, Standard, Expert</div></div><span>›</span></button></div>
  <div class="section"><h3>Recently completed</h3>${s.recent.length ? s.recent.slice(0, 4).map((r) => `<div class="card flat row" style="margin-bottom:8px;${themeStyle(worldById(r.world))}"><span class="big" aria-hidden="true">${worldById(r.world).emoji}</span><div class="grow"><b>${esc(r.title)}</b><div class="small muted">${worldById(r.world).name}</div></div>${stars(r.stars)}</div>`).join('') : '<div class="card flat center muted">No missions completed yet — your adventure begins above! 🚀</div>'}</div>
  <div class="section"><div class="row between"><h3>Achievements</h3><a href="#/rewards" data-go="/rewards" class="small" style="color:var(--p);font-weight:800">All ›</a></div><div class="hscroll" style="padding:4px 0">${G.ACHIEVEMENTS.slice(0, 8).map((a) => `<div class="ach ${s.ach[a.id] ? '' : 'locked'}" style="width:92px"><span class="em" aria-hidden="true">${a.emoji}</span><b>${a.name}</b></div>`).join('')}</div></div>`;
  view(html);
  const app = $('#app');
  $('#resume')?.addEventListener('click', () => resumeSession());
  $('#cont')?.addEventListener('click', () => briefing(next.id));
  $('#claim')?.addEventListener('click', () => { const r = G.claimLogin(store.state); store.save(); if (r) { celebrate('reward'); toast(`🎁 +${r.amount} coins!`); home(); } });
  app.querySelectorAll('.wcard').forEach((c) => c.addEventListener('click', () => go(`/world/${c.dataset.w}`)));
  app.querySelectorAll('[role=button][data-go]').forEach((c) => c.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(c.dataset.go); }));
}
const home_s = (m) => `${m.tierName}`;
const home_continueLabel = (s, m) => (s.stats.missions ? 'Next up' : 'Start here');
function worldCard(s, w) {
  const open = G.worldUnlocked(s, w.id); const p = G.worldProgress(s, w.id);
  return `<button class="wcard ${open ? '' : 'locked'}" style="${themeStyle(w)}" data-w="${w.id}" aria-label="${w.name}${open ? '' : ', locked: ' + G.worldUnlockText(s, w.id)}"><span class="em" aria-hidden="true">${w.emoji}</span><b>${w.name}</b><small>${open ? `${p.done}/${p.total} missions` : '🔒 ' + G.worldUnlockText(s, w.id)}</small>${open ? '' : '<span class="lock">Locked</span>'}</button>`;
}

// ---------- World map ----------
export function map() {
  const s = store.state;
  const html = `<div class="pad" style="background:#fff"><h2>🗺️ KnowledgeVerse</h2><p class="muted small">Eight worlds to explore. Gain player levels to unlock new islands — every mission earns XP.</p></div>
  <div class="map" id="mp">${WORLDS.map((w) => { const open = G.worldUnlocked(s, w.id); const p = G.worldProgress(s, w.id); return `<button class="island ${open ? '' : 'locked'}" style="${themeStyle(w)}" data-w="${w.id}" aria-label="${w.name}${open ? '' : ' locked'}"><span class="em" aria-hidden="true">${w.emoji}</span><b>${w.name}</b><small>${open ? esc(w.tagline) : '🔒 ' + G.worldUnlockText(s, w.id)}</small>${open ? `<div class="bar" aria-hidden="true"><i style="width:${p.pct}%"></i></div><small>${p.done}/${p.total} missions${p.bossDone ? ' · 👑 boss defeated' : ''}</small>` : ''}</button>`; }).join('')}</div>`;
  view(html);
  $$('.island').forEach((c) => c.addEventListener('click', () => { const w = worldById(c.dataset.w); if (!G.worldUnlocked(store.state, w.id)) { sound.wrong(); modal(`<div class="center"><div class="big">🔒</div><h2>${w.name} is locked</h2><p class="muted">${esc(G.worldUnlockText(store.state, w.id))}</p><p class="small muted">Earn XP by completing missions in the open worlds — no purchases or ads needed.</p><button class="btn block" data-close="">Got it</button></div>`); } else go(`/world/${w.id}`); }));
}

// ---------- World dashboard ----------
export function world({ id }) {
  const w = worldById(id); if (!w) return go('/map'); const s = store.state;
  if (!G.worldUnlocked(s, id)) { go('/map'); toast(G.worldUnlockText(s, id)); return; }
  const wp = G.worldProgress(s, id); const ms = missionsFor(id).filter((m) => m.published);
  const weak = G.weakestCat(s, id);
  const tiers = TIERS.map((t, ti) => ({ t, list: ms.filter((m) => !m.boss && m.tier === ti) }));
  const row = (m) => { const st = G.missionStatus(s, m); const pr = s.progress[m.id]; return `<button class="mission ${st} ${m.boss ? 'boss' : ''}" data-m="${m.id}" aria-label="${esc(m.title)}, ${st}"><span class="num" aria-hidden="true">${m.boss ? '👑' : st === 'locked' ? '🔒' : st === 'done' ? '✓' : m.index + 1}</span><span class="grow"><b>${esc(m.title)}</b><br><small class="muted">${m.boss ? 'Boss challenge' : m.tierName} · ${m.count} challenges${m.time ? ' · ⏱ timed' : ''}</small></span>${stars(pr?.stars || 0)}</button>`; };
  const html = `<div class="world-hero"><button class="back" data-go="/map">‹ Worlds</button><h1 style="margin-top:8px">${w.emoji} ${w.name}</h1><p>${esc(w.tagline)}</p>${scene(id)}</div>
  <div class="section"><div class="card"><div class="row between"><b>World progress</b><span class="small muted">${wp.done}/${wp.total} missions · ★ ${wp.stars}/${wp.maxStars}</span></div><div class="bar" style="margin-top:8px"><i style="width:${wp.pct}%"></i></div>${wp.complete && wp.bossDone ? '<p class="pill good" style="margin-top:8px">🏆 World complete!</p>' : `<p class="small muted" style="margin-top:6px">Quest: ${esc(w.quest)}.</p>`}</div>
  ${weak ? `<div class="card flat" style="margin-top:10px;background:#fff7ed"><b>💡 Extra practice</b><p class="small muted">${weak.cat.emoji} ${weak.cat.name} needs a little work. Missions will include easier practice and explanations.</p></div>` : ''}</div>
  <div class="section">${tiers.map(({ t, list }) => `<div class="tier">${t.name}</div>${list.map(row).join('')}`).join('')}<div class="tier">Boss</div>${ms.filter((m) => m.boss).map(row).join('')}</div>
  <div class="section"><h3>Skills in this world</h3><div class="card">${w.cats.map((c) => { const k = G.skill(s, id, c.id); return `<div class="row" style="margin:6px 0"><span aria-hidden="true">${c.emoji}</span><span class="grow small">${c.name}</span><div class="bar" style="width:90px"><i style="width:${k.acc === null ? 0 : k.acc * 100}%"></i></div><span class="small muted" style="width:36px;text-align:right">${k.acc === null ? '–' : Math.round(k.acc * 100) + '%'}</span></div>`; }).join('')}</div></div>`;
  view(html, { world: id });
  $$('.mission').forEach((b) => b.addEventListener('click', () => { const m = missionById(b.dataset.m); const st = G.missionStatus(store.state, m); if (st === 'locked') { sound.wrong(); toast('🔒 ' + G.unlockHint(store.state, m)); } else briefing(m.id); }));
}

// ---------- Mission briefing ----------
export async function briefing(mid) {
  const m = missionById(mid); const w = worldById(m.world); const s = store.state; const pr = s.progress[m.id];
  const weak = G.struggling(s, m.world, m.cats[0]);
  const html = `<div style="${themeStyle(w)}"><div class="row"><div class="avatar" style="background:linear-gradient(150deg,var(--w1),var(--w2))" aria-hidden="true">${m.boss ? '👑' : w.emoji}</div><div class="grow"><div class="small muted">${w.name} · ${m.boss ? 'Boss' : m.tierName}</div><h2>${esc(m.title)}</h2></div>${stars(pr?.stars || 0)}</div>
  <p style="margin-top:10px">${esc(m.desc)}</p><div class="card flat" style="margin-top:8px"><b>🎯 Learning objective</b><p class="small muted">${esc(m.objective)}</p></div>
  <div class="grid3 center" style="margin:12px 0"><div class="stat"><b>${m.count}</b><span class="small muted">challenges</span></div><div class="stat"><b>${m.time ? Math.round(m.time / 60 * 10) / 10 + 'm' : '∞'}</b><span class="small muted">time limit</span></div><div class="stat"><b>${'●'.repeat(m.boss ? 5 : m.tier + 1)}</b><span class="small muted">difficulty</span></div></div>
  <div class="row wrap" style="margin-bottom:6px"><span class="pill">+${m.xp} XP</span><span class="pill warn">+${m.coins} 🪙</span>${m.boss ? '<span class="pill good">Special boss reward</span>' : ''}${m.time ? '<span class="pill bad">⏱ Timed</span>' : ''}</div>
  <p class="small muted">✅ ${esc(m.condition)}${m.time ? ' Unanswered questions count as incorrect when time runs out.' : ''}${weak ? ' We’ve added extra practice and explanations for you.' : ''}</p>
  <div class="row" style="margin-top:12px"><button class="btn ghost" data-close="">Not now</button><button class="btn green grow" data-close="go">${pr?.stars ? 'Play again' : 'Start mission'} ▶</button></div></div>`;
  const v = await modal(html, { sheet: true }); if (v === 'go') startMission(m.id);
}
