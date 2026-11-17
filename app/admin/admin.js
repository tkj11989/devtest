// KnowledgeVerse admin dashboard. Static, role-based, shares the game's content store (same origin).
// NOTE: authentication here is client-side only (suitable for local/demo use). For production, put this behind
// server-side authentication — see docs/ADMIN_GUIDE.md.
import { getContent, saveContent, updateContent, getLocalOnly, storage } from '../js/contentStore.js';
import { WORLDS, worldById, missionsFor, allBank, qId, qKey, invalidateBank, realise, TIERS } from '../js/content/index.js';
import { validateQuestion } from '../js/validate.js';
import { readAnalytics } from '../js/analytics.js';
import { SAVE_KEY, newState, sanitize } from '../js/store.js';
import { levelOf, ACHIEVEMENTS, totalStars } from '../js/game.js';
import { makeRng, esc, norm } from '../js/util.js';

const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ADMIN_KEY = 'kv_admin_v1';
const ROLES = { admin: ['overview', 'worlds', 'missions', 'questions', 'quality', 'daily', 'rewards', 'difficulty', 'users', 'moderation', 'ads', 'analytics', 'settings'], content: ['overview', 'worlds', 'missions', 'questions', 'quality', 'daily'] };
const TABS = { overview: 'Overview', worlds: 'Worlds', missions: 'Missions & Levels', questions: 'Questions', quality: 'Quality & Reports', daily: 'Daily Challenges', rewards: 'Rewards', difficulty: 'Difficulty', users: 'Users', moderation: 'Leaderboard Moderation', ads: 'Advertising', analytics: 'Analytics', settings: 'Settings & Backup' };
let session = null; try { session = JSON.parse(sessionStorage.getItem('kv_admin_session') || 'null'); } catch { /* none */ }
let tab = 'overview'; let qFilter = { world: '', cat: '', type: '', status: '', q: '' };
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); };
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kv|' + s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const loadAdmins = () => { try { return JSON.parse(storage.get(ADMIN_KEY) || 'null'); } catch { return null; } };
const saveAdmins = (a) => storage.set(ADMIN_KEY, JSON.stringify(a));
const can = (t) => session && ROLES[session.role].includes(t);
const commit = (fn) => { updateContent(fn); invalidateBank(); };
const loadPlayer = () => { try { const raw = storage.get(SAVE_KEY); return raw ? sanitize(JSON.parse(raw)) : null; } catch { return null; } };

// ---------------- login ----------------
function loginView() {
  const admins = loadAdmins(); const root = $('#root');
  root.innerHTML = `<div class="card login"><h2>KnowledgeVerse Admin</h2><p class="sub">${admins ? 'Sign in to continue' : 'First run: create the administrator account'}</p>
  <label class="f"><span>Username</span><input id="u" autocomplete="username" value="${admins ? '' : 'admin'}"></label><label class="f"><span>Passphrase ${admins ? '' : '(min 8 characters)'}</span><input id="p" type="password" autocomplete="current-password"></label><p class="err" id="e"></p><button class="btn" id="go">${admins ? 'Sign in' : 'Create admin account'}</button>
  <div class="note">Demo-grade protection: credentials live in this browser. Use server-side auth for production (see Admin Guide).</div></div>`;
  let fails = +(sessionStorage.getItem('kv_fails') || 0), lock = +(sessionStorage.getItem('kv_lock') || 0);
  const run = async () => {
    const u = $('#u').value.trim(), p = $('#p').value; const e = $('#e');
    if (Date.now() < lock) { e.textContent = `Too many attempts. Try again in ${Math.ceil((lock - Date.now()) / 1000)}s.`; return; }
    if (!admins) { if (u.length < 3 || p.length < 8) { e.textContent = 'Username ≥ 3 and passphrase ≥ 8 characters.'; return; } saveAdmins({ users: [{ name: u, role: 'admin', hash: await sha(p) }] }); }
    const a = loadAdmins(); const me = a.users.find((x) => x.name === u);
    if (!me || me.hash !== (await sha(p))) { fails++; sessionStorage.setItem('kv_fails', fails); if (fails >= 5) { lock = Date.now() + 30000; sessionStorage.setItem('kv_lock', lock); fails = 0; sessionStorage.setItem('kv_fails', 0); } e.textContent = 'Invalid username or passphrase.'; return; }
    session = { name: me.name, role: me.role }; sessionStorage.setItem('kv_admin_session', JSON.stringify(session)); shell();
  };
  $('#go').addEventListener('click', run); $('#p').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

function shell() {
  const root = $('#root'); const first = ROLES[session.role];
  root.innerHTML = `<aside><h1>🌌 KnowledgeVerse<br><small style="opacity:.7">Admin</small></h1>${first.map((t) => `<button data-t="${t}" ${t === tab ? 'aria-current="page"' : ''}>${TABS[t]}</button>`).join('')}<div class="who">${esc(session.name)} · ${session.role === 'admin' ? 'Administrator' : 'Content manager'}<br><a href="../index.html" style="color:#c4b5fd">Open game ↗</a><br><a href="#" id="lo" style="color:#c4b5fd">Sign out</a></div></aside><main id="main"></main>`;
  $$('aside [data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; shell(); }));
  $('#lo').addEventListener('click', (e) => { e.preventDefault(); sessionStorage.removeItem('kv_admin_session'); session = null; loginView(); });
  if (!can(tab)) tab = 'overview'; VIEWS[tab]($('#main'));
}
const head = (t, s) => `<h2>${t}</h2><p class="sub">${s}</p>`;
const NOTE_LOCAL = '<div class="note">Figures are measured on <b>this device</b> only (no backend). Aggregating across all players requires a server — see the Admin Guide.</div>';

const VIEWS = {
  overview(m) {
    const a = readAnalytics(); const days = Object.entries(a.days || {}); const pl = loadPlayer(); const sum = (f) => days.reduce((s, [, d]) => s + (d[f] || 0), 0);
    const today = new Date().toISOString().slice(0, 10); const dau = days.filter(([k, d]) => k === today && d.sessions).length; const act30 = days.filter(([k]) => Date.now() - new Date(k) < 30 * 864e5).length;
    const wr = {}; days.forEach(([, d]) => Object.entries(d.worlds || {}).forEach(([w, n]) => (wr[w] = (wr[w] || 0) + n)));
    const pop = Object.entries(wr).sort((x, y) => y[1] - x[1]); const content = allBank();
    const imp = {}; days.forEach(([, d]) => Object.entries(d.ads || {}).forEach(([k, n]) => (imp[k] = (imp[k] || 0) + n)));
    m.innerHTML = `${head('Overview', 'Live summary of content and measured activity')}${NOTE_LOCAL}
    <div class="grid">${[['Players on this device', pl?.profile ? 1 : 0], ['Daily active (today)', dau], ['Active days (30d)', act30], ['Missions completed', sum('missions')], ['Questions answered', sum('answers')], ['Avg session (min)', sum('sessions') ? (sum('playSec') / sum('sessions') / 60).toFixed(1) : '–'], ['Feedback messages', (a.feedback || []).length], ['Open content reports', (a.reports || []).length]].map(([k, v]) => `<div class="card kpi"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    <h3>Most popular worlds</h3><div class="card">${pop.length ? pop.map(([w, n]) => `<div class="row"><span style="width:160px">${worldById(w)?.name || w}</span><div class="bar grow"><i style="width:${(n / pop[0][1]) * 100}%"></i></div><b>${n}</b></div>`).join('') : '<span class="muted">No play recorded yet.</span>'}</div>
    <h3>Content</h3><div class="card"><table><tr><th>World</th><th>Questions (static)</th><th>Generators</th><th>Missions</th><th>Status</th></tr>${WORLDS.map((w) => `<tr><td>${w.emoji} ${w.name}</td><td>${content.filter((q) => q.world === w.id && q.enabled).length}</td><td>${Object.keys(w.mod.gen || {}).length}</td><td>${missionsFor(w.id).length}</td><td>${getContent().unpublishedWorlds.includes(w.id) ? '<span class="pill bad">Unpublished</span>' : '<span class="pill good">Published</span>'}</td></tr>`).join('')}</table></div>
    <h3>Ads (measured impressions on this device)</h3><div class="card">${Object.keys(imp).length ? Object.entries(imp).map(([k, n]) => `<span class="pill" style="margin-right:6px">${k}: ${n}</span>`).join('') : '<span class="muted">No ad events yet.</span>'}</div>`;
  },

  worlds(m) {
    const c = getContent();
    m.innerHTML = `${head('Worlds', 'Publish, rename and extend learning worlds')}<div class="note">Adding an entirely new world (new mechanics/theme) needs a content module in the codebase; here you can edit text, add categories and publish/unpublish.</div>
    ${WORLDS.map((w) => { const meta = c.worldMeta[w.id] || {}; return `<div class="card" data-w="${w.id}"><div class="row"><b style="font-size:1.1rem">${w.emoji}</b><label class="f grow"><span>Name</span><input class="wn" value="${esc(w.name)}"></label><label class="f grow"><span>Tagline</span><input class="wt" value="${esc(w.tagline)}"></label><label class="f" style="width:140px"><span>Status</span><select class="wp"><option value="1" ${c.unpublishedWorlds.includes(w.id) ? '' : 'selected'}>Published</option><option value="0" ${c.unpublishedWorlds.includes(w.id) ? 'selected' : ''}>Unpublished</option></select></label></div>
    <div class="muted">Categories: ${w.cats.map((x) => `${x.emoji} ${esc(x.name)}`).join(' · ')}</div><div class="row" style="margin-top:8px"><input class="cn" placeholder="New category name" style="max-width:240px"><input class="ce" placeholder="Emoji" style="width:70px"><button class="btn sm ghost addcat">Add category</button><span class="grow"></span><button class="btn sm save">Save world</button></div></div>`; }).join('')}`;
    $$('.card[data-w]', m).forEach((card) => { const id = card.dataset.w;
      $('.save', card).addEventListener('click', () => { commit((c) => { c.worldMeta[id] = { ...(c.worldMeta[id] || {}), name: $('.wn', card).value.trim() || worldById(id).base.name, tagline: $('.wt', card).value.trim() }; c.unpublishedWorlds = c.unpublishedWorlds.filter((x) => x !== id); if ($('.wp', card).value === '0') c.unpublishedWorlds.push(id); }); toast('World saved'); });
      $('.addcat', card).addEventListener('click', () => { const n = $('.cn', card).value.trim(); if (!n) return; commit((c) => { const meta = (c.worldMeta[id] ||= {}); (meta.catsExtra ||= []).push({ id: 'x-' + norm(n).replace(/ /g, '-'), name: n, emoji: $('.ce', card).value || '⭐' }); }); toast('Category added'); VIEWS.worlds(m); }); });
  },

  missions(m) {
    const c = getContent(); let wid = sessionStorage.getItem('kv_a_world') || 'math';
    const draw = () => { const ms = missionsFor(wid);
      m.innerHTML = `${head('Missions & Levels', 'Edit titles, rewards, size and visibility. 5 tiers × 2 missions + 1 boss per world.')}<label class="f" style="max-width:260px"><span>World</span><select id="mw">${WORLDS.map((w) => `<option value="${w.id}" ${w.id === wid ? 'selected' : ''}>${w.name}</option>`).join('')}</select></label>
      <div class="card"><table><tr><th>#</th><th>Tier</th><th>Title</th><th>Challenges</th><th>XP</th><th>Coins</th><th>Published</th><th></th></tr>${ms.map((x) => `<tr data-id="${x.id}"><td>${x.boss ? '👑' : x.index + 1}</td><td>${x.tierName}</td><td><input class="t" value="${esc(x.title)}"></td><td><input class="n" type="number" min="3" max="15" value="${x.count}" style="width:70px"></td><td><input class="xp" type="number" min="0" value="${x.xp}" style="width:80px"></td><td><input class="co" type="number" min="0" value="${x.coins}" style="width:80px"></td><td><input class="pb" type="checkbox" ${x.published ? 'checked' : ''} style="width:auto"></td><td><button class="btn sm sv">Save</button></td></tr>`).join('')}</table></div>`;
      $('#mw').addEventListener('change', (e) => { wid = e.target.value; sessionStorage.setItem('kv_a_world', wid); draw(); });
      $$('tr[data-id]', m).forEach((tr) => $('.sv', tr).addEventListener('click', () => { const n = +$('.n', tr).value, xp = +$('.xp', tr).value, co = +$('.co', tr).value; if (!(n >= 3 && n <= 15 && xp >= 0 && xp <= 1000 && co >= 0 && co <= 1000)) { toast('Check the numbers (3–15 challenges, rewards 0–1000)'); return; } commit((c) => { c.missions[tr.dataset.id] = { title: $('.t', tr).value.trim(), count: n, xp, coins: co, published: $('.pb', tr).checked }; }); toast('Mission saved'); }));
    }; draw();
  },

  questions(m) {
    const f = qFilter; const all = allBank(); const flagged = (q) => !!q.flagged;
    const rows = all.filter((q) => (!f.world || q.world === f.world) && (!f.cat || q.cat === f.cat) && (!f.type || q.type === f.type) && (!f.status || (f.status === 'off' ? !q.enabled : f.status === 'flag' ? flagged(q) : f.status === 'custom' ? !q.builtin : q.enabled)) && (!f.q || (q.q + ' ' + (q.a || '')).toLowerCase().includes(f.q.toLowerCase())));
    const w = f.world ? worldById(f.world) : null;
    m.innerHTML = `${head('Question Bank', `${all.length} questions · ${all.filter((q) => !q.builtin).length} custom · generators supply unlimited extra Math/Word/Logic/Money items`)}
    <div class="card row"><select id="fw" style="max-width:170px"><option value="">All worlds</option>${WORLDS.map((x) => `<option value="${x.id}" ${f.world === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select><select id="fc" style="max-width:190px"><option value="">All categories</option>${(w ? w.cats : []).map((x) => `<option value="${x.id}" ${f.cat === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select><select id="ft" style="max-width:130px"><option value="">All types</option>${['mcq', 'input', 'order', 'match', 'sort', 'lab', 'multi'].map((x) => `<option ${f.type === x ? 'selected' : ''}>${x}</option>`).join('')}</select><select id="fs" style="max-width:150px">${[['', 'Any status'], ['on', 'Published'], ['off', 'Unpublished'], ['flag', 'Flagged'], ['custom', 'Custom only']].map(([v, n]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${n}</option>`).join('')}</select><input id="fq" placeholder="Search text…" value="${esc(f.q)}" style="max-width:220px"><span class="grow"></span><button class="btn" id="new">+ New question</button></div>
    <div class="card"><table><tr><th>World / cat</th><th>Type</th><th>D</th><th>Question</th><th>Status</th><th></th></tr>${rows.slice(0, 120).map((q) => `<tr><td>${worldById(q.world)?.name.split(' ')[0]}<br><small class="muted">${esc(q.cat)}</small></td><td>${q.type}</td><td>${q.d}</td><td>${esc(q.q.slice(0, 110))}<br><small class="muted">${q.type === 'mcq' ? '✓ ' + esc(String(q.a ?? '')) : ''}</small></td><td>${!q.builtin ? '<span class="pill">custom</span> ' : ''}${q.enabled ? '<span class="pill good">live</span>' : '<span class="pill bad">off</span>'}${q.flagged ? ' <span class="pill warn">flagged</span>' : ''}${q.certainty ? ' <span class="pill warn">debated</span>' : ''}</td><td style="white-space:nowrap"><button class="btn sm ghost ed" data-id="${q.id}">Edit</button> <button class="btn sm ghost tg" data-id="${q.id}">${q.enabled ? 'Unpublish' : 'Publish'}</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No questions match.</td></tr>'}</table>${rows.length > 120 ? `<p class="muted">Showing 120 of ${rows.length}. Narrow the filter.</p>` : ''}</div>`;
    const re = () => { qFilter = { world: $('#fw').value, cat: $('#fc').value, type: $('#ft').value, status: $('#fs').value, q: $('#fq').value }; VIEWS.questions(m); };
    ['fw', 'fc', 'ft', 'fs'].forEach((id) => $('#' + id).addEventListener('change', () => { if (id === 'fw') $('#fc').value = ''; re(); })); $('#fq').addEventListener('change', re);
    $('#new').addEventListener('click', () => editor(null, () => VIEWS.questions(m)));
    $$('.ed', m).forEach((b) => b.addEventListener('click', () => editor(all.find((q) => q.id === b.dataset.id), () => VIEWS.questions(m))));
    $$('.tg', m).forEach((b) => b.addEventListener('click', () => { commit((c) => { const i = c.disabled.indexOf(b.dataset.id); i >= 0 ? c.disabled.splice(i, 1) : c.disabled.push(b.dataset.id); const cu = c.custom.find((x) => x.id === b.dataset.id); if (cu) cu.enabled = i >= 0; }); toast('Updated'); VIEWS.questions(m); }));
  },

  quality(m) {
    const all = allBank(); const a = readAnalytics(); const c = getContent();
    const dups = []; const seen = new Map(); for (const q of all) { const k = norm(q.q + (q.a ?? '')); if (seen.has(k)) dups.push([seen.get(k), q]); else seen.set(k, q); }
    const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 3)); const near = [];
    const list = all.filter((q) => q.type === 'mcq'); for (let i = 0; i < list.length && near.length < 15; i++) for (let j = i + 1; j < list.length; j++) { if (list[i].world !== list[j].world) continue; const A = toks(list[i].q), B = toks(list[j].q); if (A.size < 4) continue; const inter = [...A].filter((x) => B.has(x)).length; if (inter / Math.max(A.size, B.size) > 0.8 && list[i].a !== list[j].a) { near.push([list[i], list[j]]); break; } }
    const issues = []; for (const q of all) { const r = validateQuestion(realise(q, makeRng(1))); if (!r.ok) issues.push([q, r.errors.join(', ')]); else if (!q.explain || q.explain.length < 8) issues.push([q, 'missing explanation']); else if (!q.builtin && !q.objective) issues.push([q, 'missing educational objective']); }
    const cov = WORLDS.map((w) => ({ w, d: [1, 2, 3, 4, 5].map((d) => all.filter((q) => q.world === w.id && q.enabled && q.d === d).length) }));
    const flags = all.filter((q) => q.flagged);
    m.innerHTML = `${head('Quality & Reports', 'Find duplicates, incomplete or outdated questions, and handle player reports')}
    <h3>Player reports (${(a.reports || []).length})</h3><div class="card">${(a.reports || []).length ? `<table><tr><th>When</th><th>Question</th><th>Reason</th><th></th></tr>${a.reports.map((r, i) => { const q = all.find((x) => x.id === r.qid); return `<tr><td>${new Date(r.ts).toLocaleDateString()}</td><td>${q ? esc(q.q.slice(0, 90)) : esc(r.qid)}</td><td>${esc(r.reason)}</td><td style="white-space:nowrap"><button class="btn sm fl" data-id="${r.qid}" data-i="${i}">Flag outdated</button> <button class="btn sm ghost dm" data-i="${i}">Dismiss</button></td></tr>`; }).join('')}</table>` : '<span class="muted">No reports.</span>'}</div>
    <h3>Flagged as outdated / incorrect (${flags.length})</h3><div class="card">${flags.length ? `<table>${flags.map((q) => `<tr><td>${esc(q.q.slice(0, 100))}</td><td>${esc(q.flagged.reason || '')}</td><td><button class="btn sm ghost ed" data-id="${q.id}">Edit</button> <button class="btn sm uf" data-id="${q.id}">Mark fixed</button></td></tr>`).join('')}</table><p class="muted">Flagged questions are hidden from players until fixed.</p>` : '<span class="muted">None.</span>'}</div>
    <h3>Exact duplicates (${dups.length})</h3><div class="card">${dups.length ? dups.map(([x, y]) => `<div>${esc(x.q.slice(0, 90))} <span class="pill warn">${x.id}</span> ↔ <span class="pill warn">${y.id}</span></div>`).join('') : '<span class="pill good">No duplicates</span>'}</div>
    <h3>Possible near-duplicates (${near.length})</h3><div class="card">${near.length ? near.map(([x, y]) => `<div>${esc(x.q.slice(0, 80))}<br><span class="muted">↔ ${esc(y.q.slice(0, 80))}</span></div>`).join('<hr>') : '<span class="pill good">None found</span>'}</div>
    <h3>Validation issues (${issues.length})</h3><div class="card">${issues.length ? issues.slice(0, 40).map(([q, e]) => `<div>${esc(q.q.slice(0, 80))} — <span class="err">${esc(e)}</span></div>`).join('') : '<span class="pill good">All questions pass validation</span>'}</div>
    <h3>Coverage by difficulty</h3><div class="card"><table><tr><th>World</th>${[1, 2, 3, 4, 5].map((d) => `<th>D${d}</th>`).join('')}</tr>${cov.map(({ w, d }) => `<tr><td>${w.name}</td>${d.map((n) => `<td>${n < 2 && !Object.keys(w.mod.gen || {}).length ? `<span class="pill warn">${n}</span>` : n}</td>`).join('')}</tr>`).join('')}</table><p class="muted">Orange = thin coverage in a world without generators. Worlds with generators produce additional questions automatically.</p></div>`;
    $$('.fl', m).forEach((b) => b.addEventListener('click', () => { commit((c) => { c.flags[b.dataset.id] = { reason: 'Player report', by: session.name, at: Date.now() }; }); removeReport(+b.dataset.i); toast('Flagged'); VIEWS.quality(m); }));
    $$('.dm', m).forEach((b) => b.addEventListener('click', () => { removeReport(+b.dataset.i); VIEWS.quality(m); }));
    $$('.uf', m).forEach((b) => b.addEventListener('click', () => { commit((c) => { delete c.flags[b.dataset.id]; c.reviewed[b.dataset.id] = { by: session.name, at: Date.now() }; }); VIEWS.quality(m); }));
    $$('.ed', m).forEach((b) => b.addEventListener('click', () => editor(all.find((q) => q.id === b.dataset.id), () => VIEWS.quality(m))));
  },

  daily(m) {
    const c = getContent(); const date = sessionStorage.getItem('kv_a_date') || new Date().toISOString().slice(0, 10); const day = c.daily[date] || {};
    const slots = [['math', 'Math', 'math'], ['lang', 'Language', 'word'], ['logic', 'Reasoning', 'logic'], ['rotate', 'Spotlight', null]];
    m.innerHTML = `${head('Daily Challenges', 'Schedule specific questions; unscheduled slots are generated automatically from the seed so they never change during the day')}<div class="card row"><label class="f"><span>Date</span><input type="date" id="dt" value="${date}"></label><span class="muted">Scheduled days: ${Object.keys(c.daily).length}</span></div>
    ${slots.map(([id, name, wid]) => { const cur = id === 'rotate' ? day.rotate || {} : { ids: day[id] || [] }; const world = id === 'rotate' ? (cur.world || 'science') : wid; return `<div class="card" data-s="${id}"><b>${name}</b> ${id === 'rotate' ? `<label class="f" style="max-width:240px"><span>World</span><select class="rw">${['science', 'geo', 'history', 'space', 'money'].map((w) => `<option value="${w}" ${world === w ? 'selected' : ''}>${worldById(w).name}</option>`).join('')}</select></label>` : ''}
      <label class="f"><span>Question IDs (comma-separated, up to 3 — leave empty for automatic)</span><input class="ids" value="${esc((cur.ids || []).join(', '))}"></label><details><summary class="muted">Browse ${worldById(world).name} question IDs</summary><div style="max-height:160px;overflow:auto;font-size:.82rem">${allBank().filter((q) => q.world === world && q.enabled).map((q) => `<div><code>${q.id}</code> ${esc(q.q.slice(0, 70))}</div>`).join('') || 'This world has no static questions — it uses generators.'}</div></details></div>`; }).join('')}
    <div class="row"><button class="btn" id="sv">Save schedule</button><button class="btn ghost" id="cl">Clear this date</button></div>`;
    $('#dt').addEventListener('change', (e) => { sessionStorage.setItem('kv_a_date', e.target.value); VIEWS.daily(m); });
    $('#sv').addEventListener('click', () => { const ids = (el) => $('.ids', el).value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 3); const all = new Set(allBank().map((q) => q.id)); const out = {}; let bad = '';
      $$('.card[data-s]', m).forEach((el) => { const id = el.dataset.s; const list = ids(el); list.forEach((x) => { if (!all.has(x)) bad = x; }); if (id === 'rotate') { if (list.length) out.rotate = { world: $('.rw', el).value, ids: list }; else out.rotate = { world: $('.rw', el).value, ids: [] }; } else if (list.length) out[id] = list; });
      if (bad) { toast('Unknown question id: ' + bad); return; } commit((c) => { if (Object.keys(out).length) c.daily[date] = out; else delete c.daily[date]; }); toast('Schedule saved'); });
    $('#cl').addEventListener('click', () => { commit((c) => { delete c.daily[date]; }); VIEWS.daily(m); });
  },

  rewards(m) {
    const r = getContent().rewards;
    m.innerHTML = `${head('Rewards', 'Daily login, streak and bonus rewards')}<div class="card"><h3 style="margin-top:0">Login reward cycle (coins per day)</h3><div class="row">${r.loginCycle.map((v, i) => `<label class="f" style="width:78px"><span>Day ${i + 1}</span><input class="lc" type="number" min="0" value="${v}"></label>`).join('')}</div>
    <h3>All-four daily challenges bonus</h3><div class="row"><label class="f"><span>XP</span><input id="dx" type="number" min="0" value="${r.dailyAll.xp}"></label><label class="f"><span>Coins</span><input id="dc" type="number" min="0" value="${r.dailyAll.coins}"></label></div>
    <h3>Streak milestone rewards (coins)</h3><div class="row">${Object.entries(r.streak).map(([d, v]) => `<label class="f" style="width:110px"><span>${d} days</span><input class="sr" data-d="${d}" type="number" min="0" value="${v}"></label>`).join('')}</div><p class="muted">Mission, boss, world-completion and achievement rewards are edited in Missions & Levels.</p><button class="btn" id="sv">Save rewards</button></div>`;
    $('#sv').addEventListener('click', () => { const lc = $$('.lc').map((x) => +x.value); if (lc.some((n) => !(n >= 0 && n <= 1000))) { toast('Values must be 0–1000'); return; } commit((c) => { c.rewards.loginCycle = lc; c.rewards.dailyAll = { xp: +$('#dx').value, coins: +$('#dc').value }; $$('.sr').forEach((x) => (c.rewards.streak[x.dataset.d] = +x.value)); }); toast('Rewards saved'); });
  },

  difficulty(m) {
    const d = getContent().difficulty;
    m.innerHTML = `${head('Difficulty configuration', 'Controls adaptive difficulty for every player')}<div class="card"><label class="f"><span><input type="checkbox" id="ad" ${d.adaptive ? 'checked' : ''} style="width:auto"> Adaptive difficulty enabled</span></label><div class="row"><label class="f"><span>Struggle threshold (accuracy ≤)</span><input id="sb" type="number" step="0.05" min="0.1" max="0.9" value="${d.struggleBelow}"></label><label class="f"><span>Mastery threshold (accuracy ≥)</span><input id="ma" type="number" step="0.05" min="0.5" max="1" value="${d.masteryAbove}"></label><label class="f"><span>Max step vs mission tier</span><input id="ms" type="number" min="0" max="2" value="${d.maxStep}"></label></div><p class="muted">Signals used: recent correctness per category (last 8 answers), repeated mistakes (spaced review), player preference. Changes are gradual: difficulty never moves more than the max step from the mission’s tier.</p><button class="btn" id="sv">Save</button></div>`;
    $('#sv').addEventListener('click', () => { const sb = +$('#sb').value, ma = +$('#ma').value, ms = +$('#ms').value; if (!(sb < ma)) { toast('Struggle threshold must be lower than mastery'); return; } commit((c) => { c.difficulty = { adaptive: $('#ad').checked, struggleBelow: sb, masteryAbove: ma, maxStep: ms }; }); toast('Saved'); });
  },

  users(m) {
    const p = loadPlayer(); const adm = loadAdmins();
    m.innerHTML = `${head('Users', 'Player data is stored on each player’s device. This view shows the player profile on this device and the admin accounts.')}${NOTE_LOCAL}
    <h3>Player on this device</h3><div class="card">${p?.profile ? `<table><tr><td>Nickname</td><td>${esc(p.profile.name)} ${p.profile.guest ? '<span class="pill">guest</span>' : ''}</td></tr><tr><td>Age group</td><td>${p.profile.age}</td></tr><tr><td>Level / XP / coins</td><td>${levelOf(p.xp)} / ${p.xp} / ${p.coins}</td></tr><tr><td>Stars / achievements</td><td>${totalStars(p)} / ${Object.keys(p.ach).length}/${ACHIEVEMENTS.length}</td></tr><tr><td>Streak (best)</td><td>${p.streak.count} (${p.streak.best})</td></tr><tr><td>Parental controls</td><td>PIN ${p.parental.pin ? 'set' : 'not set'} · social ${p.parental.social ? 'on' : 'off'} · limit ${p.parental.dailyLimitMin || 'none'} min</td></tr></table><div class="row" style="margin-top:10px"><button class="btn ghost sm" id="ex">Export player JSON</button><button class="btn red sm" id="rs">Reset this player’s progress</button></div>` : '<span class="muted">No player profile on this device.</span>'}</div>
    <h3>Admin accounts</h3><div class="card"><table><tr><th>User</th><th>Role</th><th></th></tr>${(adm?.users || []).map((u) => `<tr><td>${esc(u.name)}</td><td>${u.role}</td><td>${u.name === session.name ? '<span class="muted">you</span>' : `<button class="btn sm red rm" data-n="${esc(u.name)}">Remove</button>`}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:12px"><input id="nu" placeholder="username" style="max-width:160px"><input id="np" type="password" placeholder="passphrase (8+)" style="max-width:180px"><select id="nr" style="max-width:170px"><option value="content">Content manager</option><option value="admin">Administrator</option></select><button class="btn sm" id="au">Add account</button></div></div>`;
    $('#ex')?.addEventListener('click', () => download('knowledgeverse-player.json', p)); $('#rs')?.addEventListener('click', () => { if (confirm('Reset all progress for the player on this device? This cannot be undone.')) { const n = newState(); n.profile = p.profile; storage.set(SAVE_KEY, JSON.stringify(n)); toast('Progress reset'); VIEWS.users(m); } });
    $('#au').addEventListener('click', async () => { const n = $('#nu').value.trim(), pw = $('#np').value; if (n.length < 3 || pw.length < 8 || adm.users.some((u) => u.name === n)) { toast('Unique username (3+) and passphrase (8+) required'); return; } adm.users.push({ name: n, role: $('#nr').value, hash: await sha(pw) }); saveAdmins(adm); VIEWS.users(m); });
    $$('.rm', m).forEach((b) => b.addEventListener('click', () => { adm.users = adm.users.filter((u) => u.name !== b.dataset.n); saveAdmins(adm); VIEWS.users(m); }));
  },

  moderation(m) {
    const p = loadPlayer(); const hid = getContent().moderation.hiddenBoardEntries; const boards = p?.boards || [];
    m.innerHTML = `${head('Leaderboard moderation', 'Hide inappropriate nicknames or suspicious scores from boards')}${NOTE_LOCAL}<div class="card">${boards.length ? `<table><tr><th>When</th><th>Nickname</th><th>Mode</th><th>Score</th><th></th></tr>${boards.map((b) => `<tr><td>${new Date(b.ts).toLocaleString()}</td><td>${esc(b.name)}</td><td>${esc(b.mode)}</td><td>${b.score}</td><td><button class="btn sm ${hid.includes(b.ts) ? 'ghost' : 'red'} hd" data-ts="${b.ts}">${hid.includes(b.ts) ? 'Unhide' : 'Hide'}</button></td></tr>`).join('')}</table>` : '<span class="muted">No leaderboard entries yet.</span>'}</div>`;
    $$('.hd', m).forEach((b) => b.addEventListener('click', () => { commit((c) => { const t = +b.dataset.ts; const i = c.moderation.hiddenBoardEntries.indexOf(t); i >= 0 ? c.moderation.hiddenBoardEntries.splice(i, 1) : c.moderation.hiddenBoardEntries.push(t); }); VIEWS.moderation(m); }));
  },

  ads(m) {
    const ad = getContent().ads; const a = readAnalytics(); const imp = {}; Object.values(a.days || {}).forEach((d) => Object.entries(d.ads || {}).forEach(([k, n]) => (imp[k] = (imp[k] || 0) + n))); const pl = loadPlayer(); const rw = pl?.ads?.rewarded || { requested: 0, completed: 0 };
    let rep = null; try { rep = JSON.parse(storage.get('kv_admob_import') || 'null'); } catch { /* none */ }
    m.innerHTML = `${head('Advertising (Google AdMob)', 'Free-to-play with ethical ads: banners on non-gameplay screens, interstitials at natural breaks, optional rewarded ads')}
    <div class="note"><b>Test mode is ${ad.testMode ? 'ON' : 'OFF'}.</b> Keep it on in development: Google’s official test unit IDs are pre-filled. Before release, create your AdMob app + ad units, paste the real IDs, turn test mode off, and set the platform App IDs in the native projects (see Release Checklist).</div>
    <div class="card"><div class="row">${[['testMode', 'Test mode'], ['bannerEnabled', 'Banner ads'], ['interstitialEnabled', 'Interstitial ads'], ['rewardedEnabled', 'Rewarded ads']].map(([k, n]) => `<label><input type="checkbox" class="ak" data-k="${k}" ${ad[k] ? 'checked' : ''} style="width:auto"> ${n}</label>`).join('')}</div>
    <div class="row"><label class="f"><span>Interstitial every N completed missions</span><input id="ev" type="number" min="2" max="20" value="${ad.interstitialEveryMissions}"></label><label class="f"><span>Minimum seconds between interstitials</span><input id="ms" type="number" min="30" value="${ad.interstitialMinSeconds}"></label></div>
    ${['android', 'ios'].map((pf) => `<h3>${pf === 'ios' ? 'iOS' : 'Android'} ad unit IDs</h3><div class="row">${['banner', 'interstitial', 'rewarded'].map((f) => `<label class="f grow"><span>${f}</span><input class="u" data-p="${pf}" data-f="${f}" value="${esc(ad.units[pf][f])}"></label>`).join('')}</div>`).join('')}<button class="btn" id="sv">Save ad configuration</button><p class="muted">Child safety: for players under 13 the app sets child-directed treatment, G content rating, non-personalised ads, and doubles the interstitial spacing. Rewards are granted only after the ad network reports a completed view, and each grant is idempotent.</p></div>
    <h3>Measured on this device</h3><div class="card">${Object.keys(imp).length ? Object.entries(imp).map(([k, n]) => `<span class="pill" style="margin-right:6px">${k}: ${n}</span>`).join('') : '<span class="muted">No ad events yet.</span>'}<p>Rewarded requests: <b>${rw.requested}</b> · completed: <b>${rw.completed}</b> · completion rate: <b>${rw.requested ? Math.round((rw.completed / rw.requested) * 100) + '%' : '–'}</b></p></div>
    <h3>Revenue analytics</h3><div class="card"><p class="muted">AdMob revenue is not available on-device. Export a report from AdMob (CSV with columns like <code>Date, Ad format, Country, Estimated earnings, Impressions, Ad requests</code>) and import it here. Nothing is estimated or invented.</p><input type="file" id="csv" accept=".csv" style="max-width:320px">${rep ? revenueTable(rep) : '<p><span class="pill warn">Revenue data: not connected</span></p>'}</div>`;
    $('#sv').addEventListener('click', () => { const ev = +$('#ev').value, ms = +$('#ms').value; if (!(ev >= 2 && ms >= 30)) { toast('Frequency too aggressive'); return; } commit((c) => { $$('.ak').forEach((x) => (c.ads[x.dataset.k] = x.checked)); c.ads.interstitialEveryMissions = ev; c.ads.interstitialMinSeconds = ms; $$('.u').forEach((x) => (c.ads.units[x.dataset.p][x.dataset.f] = x.value.trim())); }); toast('Saved'); });
    $('#csv').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; const rows = parseCsv(await f.text()); if (!rows.length) { toast('Could not read any rows'); return; } storage.set('kv_admob_import', JSON.stringify(rows)); VIEWS.ads(m); });
  },

  analytics(m) {
    const a = readAnalytics(); const days = Object.entries(a.days || {}).sort(); const pl = loadPlayer();
    const byWorld = {}; days.forEach(([, d]) => Object.entries(d.worlds || {}).forEach(([w, n]) => (byWorld[w] = (byWorld[w] || 0) + n)));
    const first = a.first ? new Date(a.first) : null; const ret = [1, 7, 30].map((n) => (first ? days.some(([k]) => Math.round((new Date(k) - first) / 864e5) === n) : false));
    m.innerHTML = `${head('Analytics', 'Aggregated, anonymous counters from this device')}${NOTE_LOCAL}
    <div class="grid"><div class="card kpi"><b>${days.length}</b><span>Active days</span></div><div class="card kpi"><b>${days.reduce((s, [, d]) => s + d.sessions, 0)}</b><span>Sessions</span></div><div class="card kpi"><b>${pl ? (pl.stats.answered ? Math.round((pl.stats.correct / pl.stats.answered) * 100) + '%' : '–') : '–'}</b><span>Answer accuracy</span></div><div class="card kpi"><b>${ret.map((x) => (x ? '✓' : '·')).join(' ')}</b><span>Returned on day 1 · 7 · 30</span></div></div>
    <h3>Daily activity</h3><div class="card"><table><tr><th>Date</th><th>Sessions</th><th>Missions</th><th>Answers</th><th>Accuracy</th><th>Minutes</th></tr>${days.slice(-14).reverse().map(([k, d]) => `<tr><td>${k}</td><td>${d.sessions}</td><td>${d.missions}</td><td>${d.answers}</td><td>${d.answers ? Math.round((d.correct / d.answers) * 100) + '%' : '–'}</td><td>${Math.round(d.playSec / 60)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No data yet.</td></tr>'}</table></div>
    <h3>Mission completions by world</h3><div class="card">${Object.entries(byWorld).map(([w, n]) => `<div>${worldById(w)?.name || w}: <b>${n}</b></div>`).join('') || '<span class="muted">None yet.</span>'}</div>
    <h3>User feedback (${(a.feedback || []).length})</h3><div class="card">${(a.feedback || []).map((f) => `<div style="margin:6px 0">${f.rating ? '★'.repeat(f.rating) + ' ' : ''}${esc(f.text)} <span class="muted">— ${new Date(f.ts).toLocaleDateString()}</span></div>`).join('') || '<span class="muted">No feedback yet.</span>'}</div>`;
  },

  settings(m) {
    const s = getContent().settings;
    m.innerHTML = `${head('Settings & Backup', 'Application settings, content export/import and account security')}
    <div class="card"><div class="row"><label class="f grow"><span>App name</span><input id="an" value="${esc(s.appName)}"></label><label class="f grow"><span>Support email</span><input id="se" value="${esc(s.supportEmail)}"></label><label class="f" style="width:90px"><span>Currency</span><select id="cu">${['$', '₹', '€', '£'].map((c) => `<option ${s.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div><button class="btn" id="sv">Save settings</button></div>
    <h3>Publish content to players</h3><div class="card"><p>Edits are saved in this browser. To ship them to every player <b>without rebuilding the app</b>, export the content file and publish it as <code>content-overrides.json</code> beside <code>index.html</code>. The game loads it on start (and caches it for offline play).</p><div class="row"><button class="btn" id="ex">Export content-overrides.json</button><label class="btn ghost" style="cursor:pointer">Import…<input type="file" id="im" accept=".json" hidden></label><button class="btn red" id="rs">Reset local content edits</button></div></div>
    <h3>Change my passphrase</h3><div class="card row"><input id="op" type="password" placeholder="current" style="max-width:200px"><input id="np" type="password" placeholder="new (8+)" style="max-width:200px"><button class="btn" id="cp">Change</button></div>`;
    $('#sv').addEventListener('click', () => { commit((c) => { c.settings = { ...c.settings, appName: $('#an').value, supportEmail: $('#se').value, currency: $('#cu').value }; }); toast('Saved'); });
    $('#ex').addEventListener('click', () => download('content-overrides.json', getLocalOnly()));
    $('#im').addEventListener('change', async (e) => { try { const j = JSON.parse(await e.target.files[0].text()); if (typeof j !== 'object') throw 0; saveContent({ ...getContent(), ...j }); invalidateBank(); toast('Imported'); } catch { toast('Invalid file'); } });
    $('#rs').addEventListener('click', () => { if (confirm('Discard all local content edits (custom questions, flags, schedules, rewards)?')) { storage.set('kv_content_v1', '{}'); location.reload(); } });
    $('#cp').addEventListener('click', async () => { const a = loadAdmins(); const me = a.users.find((u) => u.name === session.name); if (me.hash !== (await sha($('#op').value))) { toast('Current passphrase is wrong'); return; } if ($('#np').value.length < 8) { toast('New passphrase too short'); return; } me.hash = await sha($('#np').value); saveAdmins(a); toast('Passphrase changed'); });
  },
};

function removeReport(i) { const a = readAnalytics(); (a.reports || []).splice(i, 1); storage.set('kv_analytics_v1', JSON.stringify(a)); }
function download(name, data) { const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); }
function parseCsv(txt) {
  const lines = txt.trim().split(/\r?\n/).filter(Boolean); if (lines.length < 2) return []; const split = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')); const h = split(lines[0]).map((x) => x.trim().toLowerCase());
  const col = (...names) => h.findIndex((x) => names.some((n) => x.includes(n)));
  const ci = { fmt: col('format'), country: col('country'), earn: col('earnings', 'revenue'), imp: col('impressions'), req: col('requests'), date: col('date') };
  return lines.slice(1).map((l) => { const c = split(l); return { date: c[ci.date] || '', format: c[ci.fmt] || 'All', country: c[ci.country] || 'All', earnings: parseFloat((c[ci.earn] || '0').replace(/[^0-9.\-]/g, '')) || 0, impressions: parseInt((c[ci.imp] || '0').replace(/\D/g, ''), 10) || 0, requests: parseInt((c[ci.req] || '0').replace(/\D/g, ''), 10) || 0 }; });
}
function revenueTable(rows) {
  const agg = (key) => { const o = {}; rows.forEach((r) => { const k = r[key]; const x = (o[k] ||= { e: 0, i: 0, q: 0 }); x.e += r.earnings; x.i += r.impressions; x.q += r.requests; }); return Object.entries(o); };
  const tbl = (t, key) => `<h3>${t}</h3><table><tr><th>${key}</th><th>Impressions</th><th>Revenue</th><th>eCPM</th><th>Fill rate</th></tr>${agg(key).map(([k, x]) => `<tr><td>${esc(k)}</td><td>${x.i}</td><td>${x.e.toFixed(2)}</td><td>${x.i ? ((x.e / x.i) * 1000).toFixed(2) : '–'}</td><td>${x.q ? Math.round((x.i / x.q) * 100) + '%' : '–'}</td></tr>`).join('')}</table>`;
  const days = new Set(rows.map((r) => r.date)).size; const tot = rows.reduce((s, r) => s + r.earnings, 0);
  return tbl('By format', 'format') + tbl('By country', 'country') + `<p class="muted">Imported ${rows.length} rows over ${days} day(s). Total revenue ${tot.toFixed(2)}. Revenue per daily active user needs your player-count from a backend/analytics source.</p>`;
}

// ---------------- question editor ----------------
function editor(q, done) {
  const isNew = !q; const w0 = q?.world || 'word'; const wrap = document.createElement('div'); wrap.className = 'modal'; document.body.appendChild(wrap);
  const base = q || { world: w0, cat: worldById(w0).cats[0].id, type: 'mcq', d: 2, q: '', a: '', w: ['', '', ''], explain: '', objective: '', instr: '' };
  const raw = JSON.stringify(stripMeta(base), null, 1);
  const simple = ['mcq', 'input'].includes(base.type);
  wrap.innerHTML = `<div><h2>${isNew ? 'New question' : 'Edit question'}${q?.builtin ? ' <span class="pill">built-in: edits saved as override</span>' : ''}</h2><div class="row"><label class="f grow"><span>World</span><select id="ew" ${isNew ? '' : 'disabled'}>${WORLDS.map((w) => `<option value="${w.id}" ${w.id === base.world ? 'selected' : ''}>${w.name}</option>`).join('')}</select></label><label class="f grow"><span>Category</span><select id="ec"></select></label><label class="f" style="width:110px"><span>Difficulty</span><select id="ed">${[1, 2, 3, 4, 5].map((d) => `<option ${base.d === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label><label class="f" style="width:130px"><span>Type</span><select id="et" ${isNew ? '' : 'disabled'}>${['mcq', 'input', 'order', 'match', 'sort', 'lab', 'multi'].map((t) => `<option ${base.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
  <label class="f"><span>Question text</span><textarea id="eq">${esc(base.q)}</textarea></label><label class="f"><span>Instructions (optional)</span><input id="ei" value="${esc(base.instr || '')}"></label>
  <div id="typed"></div><label class="f"><span>Explanation (shown after answering)</span><textarea id="ex">${esc(base.explain || '')}</textarea></label><label class="f"><span>Educational objective</span><input id="eo" value="${esc(base.objective || '')}"></label>
  <div class="row"><label class="f grow"><span>Image (optional, ≤150 KB)</span><input type="file" id="eimg" accept="image/*"></label><label class="f grow"><span>Audio URL (optional)</span><input id="eau" value="${esc(base.audio || '')}"></label><label class="f" style="width:170px"><span>Fact certainty</span><select id="ece"><option value="">Established</option><option value="debated" ${base.certainty === 'debated' ? 'selected' : ''}>Debated / uncertain</option></select></label></div>
  <p class="err" id="eerr"></p><div class="row"><button class="btn" id="esv">Save</button><button class="btn ghost" id="ecl">Cancel</button>${!isNew && !q.builtin ? '<button class="btn red" id="edel">Delete</button>' : ''}${!isNew ? '<button class="btn ghost" id="efl">Flag as outdated…</button>' : ''}</div></div>`;
  let imgData = base.image || ''; const catSel = () => { const w = worldById($('#ew', wrap).value); $('#ec', wrap).innerHTML = w.cats.map((c) => `<option value="${c.id}" ${c.id === base.cat ? 'selected' : ''}>${c.name}</option>`).join(''); };
  const typed = () => { const t = $('#et', wrap).value; const box = $('#typed', wrap);
    if (t === 'mcq') box.innerHTML = `<label class="f"><span>Correct answer</span><input id="ea" value="${esc(base.a ?? '')}"></label><label class="f"><span>Wrong options (one per line, 2–3)</span><textarea id="ew2">${esc((base.w || []).join('\n'))}</textarea></label>`;
    else if (t === 'input') box.innerHTML = `<label class="f"><span>Correct answer</span><input id="ea" value="${esc(base.answer ?? '')}"></label><label class="f"><span>Also accept (comma-separated)</span><input id="eacc" value="${esc((base.accept || []).join(', '))}"></label>`;
    else if (t === 'order') box.innerHTML = `<label class="f"><span>Items in the CORRECT order (one per line)</span><textarea id="eit">${esc((base.items || []).join('\n'))}</textarea></label>`;
    else if (t === 'match') box.innerHTML = `<label class="f"><span>Pairs, one per line as “left = right”</span><textarea id="epa">${esc((base.pairs || []).map((p) => p.join(' = ')).join('\n'))}</textarea></label>`;
    else box.innerHTML = `<p class="muted">Advanced type — edit the JSON (fields: ${t === 'sort' ? 'buckets[], items[[text,bucketIndex]]' : t === 'lab' ? 'scenario, slots[{label,options[],answer}]' : 'options[{t,price}], answers[idx], budget'}).</p><textarea id="ejs" style="min-height:160px;font-family:monospace">${esc(raw)}</textarea>`; };
  catSel(); typed(); $('#ew', wrap).addEventListener('change', () => { base.cat = ''; catSel(); }); $('#et', wrap).addEventListener('change', typed);
  $('#eimg', wrap).addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 150 * 1024) { $('#eerr', wrap).textContent = 'Image too large (150 KB max).'; e.target.value = ''; return; } const r = new FileReader(); r.onload = () => (imgData = r.result); r.readAsDataURL(f); });
  const close = () => { wrap.remove(); done(); };
  $('#ecl', wrap).addEventListener('click', () => wrap.remove());
  $('#edel', wrap)?.addEventListener('click', () => { if (confirm('Delete this custom question?')) { commit((c) => { c.custom = c.custom.filter((x) => x.id !== q.id); }); close(); } });
  $('#efl', wrap)?.addEventListener('click', () => { const r = prompt('Why is this outdated or incorrect?'); if (r) { commit((c) => { c.flags[q.id] = { reason: r, by: session.name, at: Date.now() }; }); close(); } });
  $('#esv', wrap).addEventListener('click', () => {
    const t = $('#et', wrap).value; const o = { world: $('#ew', wrap).value, cat: $('#ec', wrap).value, d: +$('#ed', wrap).value, type: t, q: $('#eq', wrap).value.trim(), instr: $('#ei', wrap).value.trim() || undefined, explain: $('#ex', wrap).value.trim(), objective: $('#eo', wrap).value.trim() || undefined, audio: $('#eau', wrap).value.trim() || undefined, image: imgData || undefined, certainty: $('#ece', wrap).value || undefined };
    const err = (m) => { $('#eerr', wrap).textContent = m; };
    const lines = (id) => $(id, wrap).value.split('\n').map((x) => x.trim()).filter(Boolean);
    try {
      if (t === 'mcq') { o.a = $('#ea', wrap).value.trim(); o.w = lines('#ew2'); if (!o.a) return err('Correct answer is required.'); if (o.w.length < 2 || o.w.length > 3) return err('Give 2 or 3 wrong options.'); if (new Set([o.a, ...o.w]).size !== o.w.length + 1) return err('Options must be different.'); }
      else if (t === 'input') { o.answer = $('#ea', wrap).value.trim(); o.accept = $('#eacc', wrap).value.split(',').map((x) => x.trim()).filter(Boolean); if (!o.answer) return err('Answer required.'); }
      else if (t === 'order') { o.items = lines('#eit'); if (o.items.length < 2) return err('Need at least 2 items.'); }
      else if (t === 'match') { o.pairs = lines('#epa').map((l) => l.split('=').map((x) => x.trim())); if (o.pairs.length < 2 || o.pairs.some((p) => p.length !== 2 || !p[0] || !p[1])) return err('Each line must be “left = right”, minimum 2 lines.'); }
      else { Object.assign(o, JSON.parse($('#ejs', wrap).value), { world: o.world, cat: o.cat, d: o.d, type: t, q: o.q, explain: o.explain }); }
    } catch (e) { return err('Invalid JSON: ' + e.message); }
    if (o.q.length < 5) return err('Question text is too short.'); if (!o.explain || o.explain.length < 8) return err('Please add an explanation (min 8 characters).');
    const chk = validateQuestion(realise({ ...o, id: 'tmp' }, makeRng(3))); if (!chk.ok) return err('Invalid: ' + chk.errors.join(', '));
    const id = q?.id || qId(o.world, o); const key = qKey(o); if (allBank().some((x) => (isNew || x.id !== id) && qKey(x) === key)) return err('A question with the same text and answer already exists.');
    Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]);
    if (isNew || !q.builtin) commit((c) => { const i = c.custom.findIndex((x) => x.id === id); const rec = { ...o, id, enabled: true }; i >= 0 ? (c.custom[i] = rec) : c.custom.push(rec); });
    else commit((c) => { c.edits[id] = o; c.reviewed[id] = { by: session.name, at: Date.now() }; });
    toast('Question saved'); close();
  });
}
const stripMeta = (q) => { const { id, builtin, enabled, flagged, world, cat, d, ...rest } = q; delete rest.q; delete rest.explain; delete rest.type; delete rest.instr; delete rest.objective; delete rest.audio; delete rest.image; delete rest.certainty; return rest; };

invalidateBank(); session && loadAdmins() ? shell() : (session = null, loginView());
