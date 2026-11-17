// Daily, Knowledge Challenge, Leaderboard, Profile, Statistics, Rewards, Settings, Parental controls, Help.
import { store, isChild, newState } from './store.js';
import { esc } from './util.js';
import { WORLDS, worldById } from './content/index.js';
import * as G from './game.js';
import { view, go } from './router.js';
import { $, $$, modal, closeModal, toast, stars, themeStyle, celebrate, confirmBox, gate } from './ui.js';
import { startDaily, startKC, limitReached } from './play.js';
import { syncMusic, sound } from './audio.js';
import { AVATARS, nameError } from './screens_home.js';
import { LANGUAGES } from './i18n.js';
import { getContent } from './contentStore.js';
import { track, readAnalytics } from './analytics.js';
import { showRewarded, grantRewardCoins, adsAllowedByParent, bannerVisible } from './ads.js';
import { storage } from './contentStore.js';
import { SAVE_KEY, BACKUP_KEY } from './store.js';

const socialOn = () => { const p = store.state.parental; return p.social === null ? !isChild() : !!p.social; };
const header = (title, sub = '', back = '/me') => `<div class="top" style="padding-bottom:18px"><div class="row"><button class="back" data-go="${back}" aria-label="Back">‹</button><div><h2>${title}</h2>${sub ? `<div class="small" style="opacity:.9">${sub}</div>` : ''}</div></div></div>`;

// ---------- Daily ----------
export function daily() {
  const s = store.state; const d = G.ensureDaily(s); const login = G.loginRewardState(s); const done = Object.keys(d.done).length;
  const rw = getContent().rewards; const streak = G.streakAlive(s);
  const html = `<div class="top"><h2>📅 Daily Challenges</h2><p class="small" style="opacity:.9">Fresh every day · ${d.date}</p><div class="row wrap" style="margin-top:8px"><span class="chip">🔥 ${streak}-day streak</span><span class="chip">Best ${s.streak.best}</span><span class="chip">${done}/4 done</span></div></div>
  <div class="section stack">
  <div class="card"><div class="row between"><b>🎁 Daily login reward</b><span class="small muted">Day ${login.day}/${login.cycle.length}</span></div><div class="row" style="margin:10px 0;gap:6px;overflow-x:auto">${login.cycle.map((c, i) => `<div class="ach ${i + 1 <= (login.claimedToday ? login.day : login.day - 1) ? '' : ''}" style="min-width:48px;${i + 1 === login.day ? 'outline:3px solid #f59e0b;' : ''}${i + 1 < login.day || (login.claimedToday && i + 1 === login.day) ? 'background:#dcfce7' : ''}"><span class="em" style="font-size:1.2rem">${i + 1 < login.day || (login.claimedToday && i + 1 === login.day) ? '✅' : '🪙'}</span><b>${c}</b></div>`).join('')}</div>${login.claimedToday ? '<p class="small muted center">Claimed today — come back tomorrow!</p>' : '<button class="btn gold block" id="claim">Claim +' + login.amount + ' 🪙</button>'}</div>
  ${G.SLOTS.map((sl) => { const wid = G.dailySlotWorld(sl.id, d.date); const w = worldById(wid); const dn = d.done[sl.id]; return `<div class="card row" style="${themeStyle(w)}"><div class="big" aria-hidden="true">${sl.emoji}</div><div class="grow"><b>${sl.name}</b><div class="small muted">${w.emoji} ${w.name} · 3 questions${sl.id === 'rotate' ? ' · rotates daily' : ''}</div>${dn ? `<div class="small" style="color:var(--good)"><b>✓ ${dn.correct}/${dn.total} correct</b></div>` : `<div class="small muted">Up to +${15 + 15} XP, +${10 + 15} 🪙</div>`}</div>${dn ? '<span class="pill good">Done</span>' : `<button class="btn small" data-slot="${sl.id}">Play</button>`}</div>`; }).join('')}
  <div class="card flat center small ${done === 4 ? '' : 'muted'}">${done === 4 ? `🎉 All four done — bonus +${rw.dailyAll.coins} 🪙 earned!` : `Finish all four today for a bonus of +${rw.dailyAll.xp} XP and +${rw.dailyAll.coins} 🪙. Streak rewards at ${Object.keys(rw.streak).join(', ')} days.`}</div>
  <div class="card flat small muted"><b>Streaks:</b> play any mission or challenge each day to keep your streak. Missing a day restarts it at 1 — your best streak stays on your profile.</div></div>`;
  view(html);
  $('#claim')?.addEventListener('click', () => { const r = G.claimLogin(store.state); store.save(); if (r) { celebrate('reward'); toast(`🎁 +${r.amount} coins!`); daily(); } });
  $$('[data-slot]').forEach((b) => b.addEventListener('click', () => startDaily(b.dataset.slot)));
}

// ---------- Knowledge Challenge ----------
export function challenge() {
  const s = store.state; const open = WORLDS.filter((w) => G.worldUnlocked(s, w.id));
  const html = `${header('🌠 Knowledge Challenge', 'Questions from many worlds', '/home')}<div class="section stack"><p class="muted">Mix of ${open.length} open worlds. See your score and subject-by-subject performance at the end.</p>
  ${Object.entries(G.KC_MODES).map(([id, m]) => `<div class="card row"><div class="big" aria-hidden="true">${m.emoji}</div><div class="grow"><b>${m.name}</b><div class="small muted">${m.desc}${m.time ? ' · ⏱ ' + m.time / 60 + ' min' : ''}</div><div class="small">Personal best: <b>${s.bests['kc:' + id] || '—'}</b></div></div><button class="btn small" data-mode="${id}">Play</button></div>`).join('')}
  <div class="card flat small muted">Open more worlds by levelling up to add more subjects to the mix. Expert Challenge uses harder questions and a timer.</div></div>`;
  view(html);
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => startKC(b.dataset.mode)));
}

// ---------- Leaderboard ----------
export function rank() {
  const s = store.state; const mod = getContent().moderation.hiddenBoardEntries; let tab = sessionStorage.getItem('kv_rank_tab') || 'best';
  const draw = () => {
    const wk = G.weekOf(); const code = G.friendCode('standard', 700000 + wk); const social = socialOn();
    const boards = s.boards.filter((b) => !mod.includes(b.ts));
    const tabs = [['best', 'Personal bests'], ['subject', 'Subjects'], ['week', 'Weekly'], ['friends', 'Friends']];
    let body = '';
    if (tab === 'best') body = `<div class="card">${Object.entries(G.KC_MODES).map(([id, m]) => `<div class="row" style="margin:8px 0"><span class="big" aria-hidden="true" style="font-size:1.6rem">${m.emoji}</span><b class="grow">${m.name}</b><b>${s.bests['kc:' + id] || '—'}</b></div>`).join('')}</div><h3 style="margin:14px 0 6px">Your recent runs</h3>${boards.length ? `<div class="card"><table class="tbl"><tr><th>Mode</th><th>Score</th><th>Accuracy</th></tr>${boards.slice(0, 10).map((b) => `<tr><td>${esc(b.mode)}${b.code ? ' · ' + esc(b.code) : ''}</td><td><b>${b.score}</b></td><td>${b.pct}%</td></tr>`).join('')}</table></div>` : '<div class="card flat center muted">Play a Knowledge Challenge to set your first score!</div>'}<p class="small muted center">Scores are stored on this device only.</p>`;
    if (tab === 'subject') { const rows = WORLDS.map((w) => ({ w, st: s.stats.byWorld[w.id] })).filter((x) => x.st?.a).map((x) => ({ ...x, acc: x.st.c / x.st.a })).sort((a, b) => b.acc - a.acc); body = rows.length ? `<div class="card">${rows.map((r, i) => `<div class="row" style="margin:8px 0"><b style="width:24px">${['🥇', '🥈', '🥉'][i] || i + 1}</b><span aria-hidden="true">${r.w.emoji}</span><span class="grow">${r.w.name}</span><div class="bar" style="width:80px"><i style="width:${r.acc * 100}%"></i></div><b>${Math.round(r.acc * 100)}%</b></div>`).join('')}</div><p class="small muted center">Your strongest subjects, ranked by accuracy.</p>` : '<div class="card flat center muted">Answer some questions to see which subjects are your strongest.</div>'; }
    if (tab === 'week') { const wb = boards.filter((b) => b.code === code); const best = s.friendScores[code] || 0; body = `<div class="card center"><div class="big">🗓️</div><h3>This week’s challenge</h3><p class="muted small">Same questions for everyone with code <b>${code}</b>. Beat your own best — or compare with friends!</p><p>Best this week: <b>${best || '—'}</b></p>${socialOn() || true ? '<button class="btn block" id="wkplay">Play weekly challenge</button>' : ''}</div>${wb.length ? `<div class="card"><table class="tbl">${wb.slice(0, 5).map((b) => `<tr><td>${new Date(b.ts).toLocaleDateString()}</td><td><b>${b.score}</b></td></tr>`).join('')}</table></div>` : ''}`; }
    if (tab === 'friends') body = !social ? `<div class="card center"><div class="big">🔒</div><h3>Friend challenges are off</h3><p class="muted small">${isChild() ? 'For young players, a grown-up decides whether friend challenges are on. There is never chat or messaging — only shared question codes.' : 'You turned this off in Settings.'}</p><button class="btn block" id="enable">Ask a grown-up to turn on</button></div>` : `<div class="card stack"><h3>Challenge a friend</h3><p class="small muted">Friend challenges use a short code. Friends play the <b>same questions</b> and compare scores. No personal info is shared and there is no chat.</p><div class="row"><button class="btn grow" id="mk">Create challenge</button></div><label class="field"><span>Have a code?</span><input id="cd" type="text" placeholder="KV-S-XXXX" autocapitalize="characters"></label><button class="btn ghost block" id="pl">Play friend’s code</button></div>${Object.keys(s.friendScores).length ? `<div class="card"><h3>Your friend-code scores</h3><table class="tbl">${Object.entries(s.friendScores).slice(-8).map(([c, v]) => `<tr><td>${esc(c)}</td><td><b>${v}</b></td></tr>`).join('')}</table></div>` : ''}`;
    view(`${header('🏆 Leaderboard', 'Optional · personal-best focused', '/home')}<div class="section"><div class="row" style="overflow-x:auto;gap:6px;margin-bottom:12px">${tabs.map(([id, n]) => `<button class="choice" aria-pressed="${tab === id}" data-tab="${id}">${n}</button>`).join('')}</div>${body}</div>`);
    $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; sessionStorage.setItem('kv_rank_tab', tab); draw(); }));
    $('#wkplay')?.addEventListener('click', () => startKC('standard', { seed: 700000 + wk, code }));
    $('#enable')?.addEventListener('click', async () => { if (await gate('Friend challenges let players share question codes. There is no chat.')) { store.state.parental.social = true; store.save(); draw(); } });
    $('#mk')?.addEventListener('click', () => { const mode = 'standard', seed = Math.floor(Math.random() * 1e9); const c = G.friendCode(mode, seed); modal(`<div class="center"><h2>Challenge ready!</h2><p class="muted small">Share this code. Play it yourself first to set the score to beat.</p><div class="card" style="font-size:1.6rem;font-weight:900;letter-spacing:2px">${c}</div><div class="row" style="margin-top:12px"><button class="btn ghost grow" id="cp">Copy</button><button class="btn grow" data-close="play">Play now</button></div></div>`).then((v) => { if (v === 'play') startKC(mode, { seed, code: c }); }); $('#cp')?.addEventListener('click', () => { navigator.clipboard?.writeText(c); toast('Copied!'); }); });
    $('#pl')?.addEventListener('click', () => { const p = G.parseFriendCode($('#cd').value); if (!p) { toast('That code doesn’t look right (e.g. KV-S-1A2B3C)'); return; } startKC(p.mode, { seed: p.seed, code: G.friendCode(p.mode, p.seed) }); });
  };
  draw();
}

// ---------- Me / Profile ----------
export function me() {
  const s = store.state; const p = s.profile; const xp = G.xpProgress(s.xp);
  view(`<div class="top"><div class="row"><div class="avatar" style="width:72px;height:72px;font-size:2.6rem">${p.avatar}</div><div class="grow"><h2>${esc(p.name)}</h2><div class="small" style="opacity:.9">Level ${xp.level} · ${s.xp} XP ${p.guest ? '· Guest' : ''}</div></div></div></div>
  <div class="section stack"><div class="grid2"><div class="card stat"><b>${s.coins}</b>🪙 coins</div><div class="card stat"><b>${G.totalStars(s)}</b>★ stars</div></div>
  ${[['/stats', '📊', 'Statistics', 'Accuracy, skills, play time'], ['/rewards', '🏅', 'Rewards & Achievements', `${Object.keys(s.ach).length}/${G.ACHIEVEMENTS.length} unlocked`], ['/challenge', '🌠', 'Knowledge Challenge', 'Mixed worlds'], ['/settings', '⚙️', 'Settings', 'Sound, difficulty, privacy'], ['/parental', '👨‍👩‍👧', 'Parental controls', 'PIN, time limit, social'], ['/help', '❓', 'Help & Support', 'How to play, report a problem']].map(([r, e, n, d]) => `<button class="card row" data-go="${r}" style="width:100%;border:0;font:inherit;text-align:left;cursor:pointer"><span class="big" style="font-size:1.8rem" aria-hidden="true">${e}</span><div class="grow"><b>${n}</b><div class="small muted">${d}</div></div><span>›</span></button>`).join('')}
  <button class="btn ghost block" id="edit">✏️ Edit profile</button></div>`);
  $('#edit').addEventListener('click', editProfile);
}
async function editProfile() {
  const p = store.state.profile; let av = p.avatar;
  const pr = modal(`<h2>Edit profile</h2><label class="field"><span>Nickname</span><input id="nm" type="text" maxlength="16" value="${esc(p.name)}"></label><p class="small" id="err" style="color:var(--bad)"></p><div class="choices">${AVATARS.map((a) => `<button class="choice" data-av="${a}" aria-pressed="${a === av}">${a}</button>`).join('')}</div><div class="row" style="margin-top:14px"><button class="btn ghost grow" data-close="">Cancel</button><button class="btn grow" id="sv">Save</button></div>`);
  $$('[data-av]', $('#overlay')).forEach((b) => b.addEventListener('click', () => { av = b.dataset.av; $$('[data-av]', $('#overlay')).forEach((x) => x.setAttribute('aria-pressed', x === b)); }));
  $('#sv').addEventListener('click', () => { const n = $('#nm').value.trim(); const e = nameError(n); if (e) { $('#err').textContent = e; return; } p.name = n; p.avatar = av; p.guest = false; store.save(); closeModal('ok'); });
  if ((await pr) === 'ok') me();
}

// ---------- Statistics ----------
export function stats() {
  const s = store.state; const st = s.stats; const acc = st.answered ? Math.round((st.correct / st.answered) * 100) : 0; const mins = Math.round(st.playSec / 60);
  const skills = Object.entries(s.perf).filter(([, p]) => p.recent?.length >= 3).map(([k, p]) => { const [w, c] = k.split(':'); const wd = worldById(w); const cat = wd?.cats.find((x) => x.id === c); return { wd, cat, acc: p.recent.reduce((a, b) => a + b, 0) / p.recent.length, n: p.c + p.w }; }).filter((x) => x.wd && x.cat).sort((a, b) => a.acc - b.acc);
  view(`${header('📊 Statistics', 'Measured from your own play')}<div class="section stack"><div class="grid2"><div class="card stat"><b>${st.answered}</b>questions answered</div><div class="card stat"><b>${acc}%</b>accuracy</div><div class="card stat"><b>${st.missions}</b>missions played</div><div class="card stat"><b>${mins}</b>minutes played</div><div class="card stat"><b>${s.streak.best}</b>best streak</div><div class="card stat"><b>${G.totalStars(s)}</b>stars earned</div></div>
  <div class="card"><h3>By world</h3>${WORLDS.map((w) => { const x = st.byWorld[w.id]; const a = x?.a ? x.c / x.a : null; return `<div class="row" style="margin:7px 0"><span aria-hidden="true">${w.emoji}</span><span class="grow small">${w.name}</span><div class="bar" style="width:90px"><i style="width:${(a || 0) * 100}%"></i></div><span class="small muted" style="width:70px;text-align:right">${x?.a ? Math.round(a * 100) + '% · ' + x.a : '—'}</span></div>`; }).join('')}</div>
  <div class="card"><h3>Skills to practise</h3>${skills.length ? skills.slice(0, 4).map((x) => `<div class="row" style="margin:6px 0"><span>${x.cat.emoji}</span><span class="grow small">${x.cat.name} <span class="muted">(${x.wd.name})</span></span><span class="pill ${x.acc < 0.6 ? 'warn' : 'good'}">${Math.round(x.acc * 100)}%</span></div>`).join('') : '<p class="muted small">Play a few missions and your strongest and weakest skills will show up here.</p>'}</div></div>`);
}

// ---------- Rewards ----------
export function rewards() {
  const s = store.state; const n = Object.keys(s.ach).length;
  view(`${header('🏅 Rewards & Achievements', `${n}/${G.ACHIEVEMENTS.length} unlocked`)}<div class="section stack"><div class="grid3 center"><div class="card stat"><b>${s.coins}</b>🪙</div><div class="card stat"><b>${s.xp}</b>XP</div><div class="card stat"><b>${G.totalStars(s)}</b>★</div></div>
  <div class="grid3">${G.ACHIEVEMENTS.map((a) => `<div class="ach ${s.ach[a.id] ? '' : 'locked'}" title="${esc(a.desc)}"><span class="em" aria-hidden="true">${a.emoji}</span><b>${a.name}</b><span class="muted">${a.desc}</span>${s.ach[a.id] ? '<span class="pill good">Unlocked</span>' : `<span class="pill">+${a.coins} 🪙</span>`}</div>`).join('')}</div>
  <div class="card"><h3>World completion rewards</h3>${WORLDS.map((w) => { const p = G.worldProgress(s, w.id); const got = s.claimed[`world:${w.id}`]; return `<div class="row" style="margin:6px 0"><span aria-hidden="true">${w.emoji}</span><span class="grow small">${w.name}</span>${got ? '<span class="pill good">Claimed</span>' : `<span class="small muted">${p.done}/${p.total}${p.bossDone ? '' : ' + boss'}</span>`}</div>`; }).join('')}<p class="small muted">Completing all 10 missions and the boss earns +200 XP and +150 🪙.</p></div></div>`);
}

// ---------- Settings ----------
export async function settings() {
  const s = store.state; const p = s.profile;
  if (s.parental.lockSettings) { const ok = await gate('Settings are locked by a grown-up.'); if (!ok) return go('/me'); }
  const sw = (id, label, val, sub = '') => `<label class="sw"><span><b>${label}</b>${sub ? `<br><small class="muted">${sub}</small>` : ''}</span><input type="checkbox" id="${id}" ${val ? 'checked' : ''}></label>`;
  view(`${header('⚙️ Settings', '', '/me')}<div class="section stack">
  <div class="card"><h3>Sound & motion</h3>${sw('mus', 'Background music', s.settings.music)}${sw('sfx', 'Sound effects', s.settings.sfx)}${sw('hap', 'Vibration feedback', s.settings.haptics)}${sw('rm', 'Reduce motion', s.settings.reduceMotion, 'Turns off confetti and most animations')}
  <label class="field"><span>Text size</span><select id="ts"><option value="0">Small</option><option value="1">Normal</option><option value="2">Large</option><option value="3">Extra large</option></select></label></div>
  <div class="card"><h3>Learning</h3><label class="field"><span>Difficulty preference</span><select id="df">${[['auto', 'Just right (adaptive)'], ['easy', 'Relaxed'], ['normal', 'Balanced'], ['hard', 'Challenging']].map(([v, n]) => `<option value="${v}" ${p.difficulty === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
  <label class="field"><span>Language</span><select id="lg">${LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === p.lang ? 'selected' : ''} ${l.ready ? '' : 'disabled'}>${l.name}${l.ready ? '' : ' — coming soon'}</option>`).join('')}</select></label>
  <label class="field"><span>Currency shown in Money City</span><select id="cu">${['$', '₹', '€', '£'].map((c) => `<option ${s.settings.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
  <div class="card"><h3>Privacy</h3><p class="small muted">KnowledgeVerse stores your progress on this device. It does not ask for your real name, email, location or contacts.</p>
  ${isChild() ? '<p class="small"><span class="pill good">Child-safe mode</span> Ads are child-directed and non-personalised. Social features need a grown-up.</p>' : sw('pad', 'Personalised ads', s.privacy.personalisedAds, 'Off by default. Applies in the installed app when ads are enabled.')}
  ${sw('ana', 'Anonymous usage statistics', s.privacy.analytics, 'Counts on this device only (never contains your name).')}
  <div class="row wrap" style="margin-top:8px"><button class="btn ghost small" id="exp">⬇ Download my data</button><button class="btn red small" id="del">🗑 Delete all my data</button></div></div>
  <div class="card flat small muted">Parental controls are in <a href="#/parental" data-go="/parental">Me › Parental controls</a>. Version 1.0.0</div></div>`);
  $('#ts').value = String(s.settings.textSize);
  const bind = (id, fn) => $('#' + id)?.addEventListener('change', (e) => { fn(e.target); store.save(); });
  bind('mus', (e) => { s.settings.music = e.checked; syncMusic(); }); bind('sfx', (e) => { s.settings.sfx = e.checked; sound.tap(); }); bind('hap', (e) => { s.settings.haptics = e.checked; });
  bind('rm', (e) => { s.settings.reduceMotion = e.checked; document.body.classList.toggle('rd-low', e.checked); });
  bind('ts', (e) => { s.settings.textSize = +e.value; document.documentElement.style.setProperty('--fs', [0.9, 1, 1.15, 1.3][+e.value]); });
  bind('df', (e) => { p.difficulty = e.value; toast('Difficulty updated'); }); bind('lg', (e) => { p.lang = e.value; }); bind('cu', (e) => { s.settings.currency = e.value; globalThis.__KV_CUR = e.value; });
  bind('pad', (e) => { s.privacy.personalisedAds = e.checked; }); bind('ana', (e) => { s.privacy.analytics = e.checked; });
  $('#exp').addEventListener('click', () => { const blob = new Blob([JSON.stringify({ player: s, analytics: readAnalytics() }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'knowledgeverse-my-data.json'; a.click(); toast('Data downloaded'); });
  $('#del').addEventListener('click', async () => {
    if (isChild() && !(await gate('Deleting all data needs a grown-up.'))) return;
    if (!(await confirmBox('Delete everything?', 'This permanently erases your profile, progress, coins and achievements from this device. It cannot be undone.', 'Delete', 'Keep'))) return;
    store.reset(); ['kv_analytics_v1', 'kv_save_v1', 'kv_save_v1_bak'].forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } }); location.hash = '/welcome'; location.reload();
  });
}

// ---------- Parental controls ----------
export async function parental(_p, skipGate = false) {
  const s = store.state; const pa = s.parental;
  if (!skipGate && !(await gate('Parental controls are for grown-ups.'))) return go('/me');
  const sw = (id, label, val, sub = '') => `<label class="sw"><span><b>${label}</b>${sub ? `<br><small class="muted">${sub}</small>` : ''}</span><input type="checkbox" id="${id}" ${val ? 'checked' : ''}></label>`;
  view(`${header('👨‍👩‍👧 Parental controls', 'For grown-ups', '/me')}<div class="section stack">
  <div class="card"><h3>Parent PIN</h3><p class="small muted">${pa.pin ? 'A PIN is set. It protects this page, ads for young players, and data deletion.' : 'Set a 4-digit PIN. Without one, a simple grown-up maths question is used.'}</p><div class="row"><input id="pin" type="password" inputmode="numeric" maxlength="4" placeholder="4 digits" style="max-width:140px"><button class="btn small" id="setpin">${pa.pin ? 'Change' : 'Set'} PIN</button>${pa.pin ? '<button class="btn ghost small" id="clrpin">Remove</button>' : ''}</div></div>
  <div class="card"><h3>Features</h3>${sw('soc', 'Friend challenges & leaderboard sharing', socialOn(), 'Share-code challenges only. There is no chat, no messaging, no profiles visible to strangers.')}${sw('rw', 'Allow optional rewarded ads', pa.rewardedAds !== false, 'Extra hints, second chances and bonus coins. Never required to progress.')}${sw('lk', 'Lock Settings with PIN / question', pa.lockSettings)}</div>
  <div class="card"><h3>Daily play-time limit</h3><label class="field"><span>Minutes per day (0 = no limit)</span><input id="lim" type="number" min="0" max="240" value="${pa.dailyLimitMin}"></label><p class="small muted">Used today: ${pa.usedToday.date === G.today() ? Math.round(pa.usedToday.sec / 60) : 0} min</p></div>
  <div class="card flat small muted"><b>About ads & children:</b> for players under 13 the app flags ads as child-directed, requests the lowest content rating and disables personalised ads.</div></div>`);
  $('#setpin').addEventListener('click', () => { const v = $('#pin').value; if (!/^\d{4}$/.test(v)) { toast('PIN must be 4 digits'); return; } pa.pin = v; store.save(); toast('PIN saved'); parental(null, true); });
  $('#clrpin')?.addEventListener('click', () => { pa.pin = null; store.save(); toast('PIN removed'); parental(null, true); });
  const b = (id, fn) => $('#' + id).addEventListener('change', (e) => { fn(e.target); store.save(); toast('Saved'); });
  b('soc', (e) => { pa.social = e.checked; }); b('rw', (e) => { pa.rewardedAds = e.checked; }); b('lk', (e) => { pa.lockSettings = e.checked; }); b('lim', (e) => { pa.dailyLimitMin = Math.max(0, Math.min(240, parseInt(e.value, 10) || 0)); });
}
// ---------- Help ----------
export function help() {
  const c = getContent().settings; const faq = [
    ['How do I unlock new worlds?', 'Complete missions to earn XP and raise your player level. Each world shows the level it needs. Nothing needs to be bought or watched.'],
    ['How do stars work?', 'Answer 60% correctly for ★, 80% for ★★ and 95% for ★★★. Boss challenges need 70% to win. You can replay any mission to earn more stars.'],
    ['What is the streak?', 'Play at least one mission or challenge each day to grow your streak. Streaks unlock bonus coins at 3, 7, 14 and 30 days.'],
    ['Do I have to watch ads?', 'No. Rewarded ads are always optional (for hints, second chances or bonus coins). Progress never depends on ads.'],
    ['Where is my progress saved?', 'On this device. Closing the app mid-mission is safe — resume from Home. Use Settings › Download my data to back it up.'],
    ['I think a question is wrong', 'Tap “⚑ Report” after answering. Reviewers check every report. Historians and scientists sometimes disagree, and we mark those cases.'],
    ['How do I delete my data?', 'Settings › Delete all my data erases everything stored on this device.'],
  ];
  view(`${header('❓ Help & Support', '', '/me')}<div class="section stack"><div class="card"><h3>How to play</h3><ol class="small" style="padding-left:18px;margin:6px 0"><li>Pick a world on the map.</li><li>Play missions in order — they get a little harder each time.</li><li>Earn XP, coins and stars. Level up to unlock more worlds.</li><li>Defeat the boss to finish a world.</li><li>Come back daily for challenges and streaks!</li></ol></div>
  <div class="card">${faq.map(([q, a]) => `<details style="margin:8px 0"><summary><b>${q}</b></summary><p class="small muted">${a}</p></details>`).join('')}</div>
  <div class="card"><h3>Send feedback</h3><label class="field"><span>Your message (no personal details please)</span><textarea id="fbt" rows="3" maxlength="500"></textarea></label><div class="choices" id="rt">${[1, 2, 3, 4, 5].map((n) => `<button class="choice" data-r="${n}" aria-pressed="false" aria-label="${n} stars">${'★'.repeat(n)}</button>`).join('')}</div><button class="btn block" id="sendfb" style="margin-top:10px">Send feedback</button><p class="small muted">Saved on this device for the admin team. Support: <a href="mailto:${esc(c.supportEmail)}" id="mail">${esc(c.supportEmail)}</a></p></div>
  <div class="card flat small muted"><b>Privacy summary:</b> no account, no real name, no location, no contacts. Ads (when enabled) follow child-directed rules for players under 13. You can delete everything in Settings.</div></div>`);
  let rating = 0; $$('[data-r]').forEach((b) => b.addEventListener('click', () => { rating = +b.dataset.r; $$('[data-r]').forEach((x) => x.setAttribute('aria-pressed', +x.dataset.r === rating)); }));
  $('#sendfb').addEventListener('click', () => { const t = $('#fbt').value.trim(); if (!t && !rating) { toast('Write a message or choose a rating'); return; } track('feedback', { text: t, rating }); $('#fbt').value = ''; toast('Thank you for your feedback! 💜'); });
}
