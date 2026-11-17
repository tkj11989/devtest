// Browser smoke test (Playwright). Usage: node tests/browser_smoke.mjs [baseUrl]   (serve ./app first, e.g. python3 -m http.server 8123 --directory app)
import { createRequire } from 'module'; const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://localhost:8123';
const shots = process.env.SHOTS || '/tmp';
const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1 });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('✗', m); } };
await page.goto(base + '/index.html'); await page.waitForSelector('#nx', { timeout: 8000 });
// onboarding incl. validation
await page.fill('#nm', 'me@mail.com'); await page.click('#nx'); ok((await page.locator('#err').innerText()).length > 0, 'rejects email-like nickname');
await page.fill('#nm', 'TestHero'); await page.click('#nx'); await page.click('#nx'); ok(await page.locator('[data-age]').count() === 5, 'age is required before continuing');
await page.click('[data-age="adult"]'); await page.click('#nx'); await page.click('#nx'); await page.click('#nx'); await page.click('#nx');
await page.waitForSelector('.top'); ok(await page.locator('text=TestHero').count() > 0, 'home shows nickname');
ok(await page.locator('.wcard').count() === 8, '8 world cards'); ok(await page.locator('.wcard.locked').count() === 5, '5 worlds locked at start');
await page.screenshot({ path: shots + '/home.png' });
// renderers: solve every question type programmatically
const result = await page.evaluate(async () => {
  const { mountQuestion } = await import('./js/qtypes.js'); const C = await import('./js/content/index.js'); const G = await import('./js/game.js'); const { newState } = await import('./js/store.js');
  const out = []; const s = newState(); s.profile = { name: 'x', age: 'adult', difficulty: 'auto' };
  const seen = new Set(); const qs = [];
  for (const w of C.WORLDS) for (const m of C.missionsFor(w.id)) for (let seed = 1; seed < 4; seed++) for (const q of G.buildQuestions(s, m, seed * 31)) { const k = q.type + (q.id || q.q); if (!seen.has(k)) { seen.add(k); qs.push(q); } }
  const byType = {}; for (const q of qs) (byType[q.type] ||= []).push(q);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const [type, list] of Object.entries(byType)) for (const q of list.slice(0, 6)) {
    const box = document.createElement('div'); document.body.appendChild(box); let res = null;
    mountQuestion(q, box, { fast: true, done: (r) => { res = r; } });
    const click = (el) => el && el.click(); const $ = (s) => box.querySelector(s); const $$ = (s) => [...box.querySelectorAll(s)];
    try {
      if (type === 'mcq') click($$('.opt')[q.answer]);
      else if (type === 'input') { $('#ans').value = String(q.answer); click($('#chk')); }
      else if (type === 'order') { for (const it of q.items) click($$('#bank .btile:not(.used)').find((x) => x.textContent === it)); click($('#chk')); }
      else if (type === 'match') { for (let i = 0; i < q.pairs.length; i++) { click($$('#L .btile')[i]); click($$('#Rt .btile').find((x) => x.textContent === q.pairs[i][1] && !x.classList.contains('done'))); } }
      else if (type === 'sort') { for (let i = 0; i < q.items.length; i++) { const chip = $$('#pool .btile')[0]; click(chip); const it = q.items.find((x) => x[0] === chip.textContent); click($$('.bucket')[it[1]]); } click($('#chk')); }
      else if (type === 'lab') { q.slots.forEach((s, i) => click($$(`.choices[data-s="${i}"] button`)[s.answer])); click($('#run')); await wait(40); }
      else if (type === 'multi') { q.answers.forEach((i) => click($$('.opt')[i])); click($('#chk')); }
      else if (type === 'memory') { await wait(60); for (const x of q.show) click($$('#ch button:not(:disabled)').find((b) => b.textContent === x)); }
      else if (type === 'hunt') { q.cells.forEach((i) => click($$('.hunt button')[i])); click($('#chk')); }
      else if (type === 'map') { const svg = $('svg'); const r = svg.getBoundingClientRect(); svg.dispatchEvent(new MouseEvent('click', { clientX: r.left + ((q.target.lon + 180) / 360) * r.width, clientY: r.top + ((90 - q.target.lat) / 180) * r.height, bubbles: true })); click($('#chk')); }
      else if (type === 'lock') { q.answer.split('').forEach((d, i) => { for (let k = 0; k < +d; k++) click($$(`.dial .btn[data-i="${i}"][data-s="1"]`)[0]); }); click($('#chk')); }
    } catch (e) { out.push(`${type}|EXC|${e.message}`); }
    await wait(10); out.push(`${type}|${res ? (res.correct ? 'ok' : 'WRONG') : 'NORESULT'}|${(q.q || '').slice(0, 60)}`); box.remove();
  }
  return out;
});
const types = new Set(); for (const r of result) { const [t, st] = r.split('|'); types.add(t); ok(st === 'ok', `renderer ${r}`); }
ok(types.size >= 11, 'tested ≥11 question types: ' + [...types].join(','));
console.log('question types tested:', [...types].join(', '), `(${result.length} questions)`);
// play a real mission through the UI (answers read from the saved session)
await page.evaluate(() => { location.hash = '/world/math'; }); await page.waitForSelector('.mission');
await page.click('.mission:not(.locked)'); await page.waitForSelector('.sheet'); await page.click('[data-close="go"]'); await page.waitForSelector('#qbox');
for (let i = 0; i < 6; i++) {
  if (await page.locator('.starrow').count()) break;
  const q = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('kv_save_v1')); return s.session.qs[s.session.idx]; });
  if (q.type === 'mcq') await page.click(`.opt >> nth=${q.answer}`);
  else if (q.type === 'input') { await page.fill('#ans', String(q.answer)); await page.click('#chk'); }
  else if (q.type === 'order') { for (const it of q.items) await page.locator('#bank .btile:not(.used)', { hasText: new RegExp('^' + it.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }).first().click(); await page.click('#chk'); }
  else if (q.type === 'match') { for (let k = 0; k < q.pairs.length; k++) { await page.click(`#L .btile >> nth=${k}`); await page.locator('#Rt .btile:not(.done)', { hasText: new RegExp('^' + q.pairs[k][1] + '$') }).first().click(); } }
  await page.waitForSelector('#next', { timeout: 5000 }).catch(async () => { await page.screenshot({ path: shots + '/fail.png' }); console.log('stuck on', JSON.stringify(q)); throw new Error('no #next'); }); if (i === 2) await page.screenshot({ path: shots + '/play.png' });
  if (i === 1) { // interrupted session: reload mid-mission and resume
    console.log('pre-reload', JSON.stringify(await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('kv_save_v1')).session; return [s.idx, s.answers.length]; }))); await page.reload(); await page.waitForSelector('#qbox'); const idx = await page.evaluate(() => JSON.parse(localStorage.getItem('kv_save_v1')).session.idx); ok(idx === 2, 'reload mid-mission resumes at the next question (idx=' + idx + ')'); continue;
  }
  await page.click('#next');
}
await page.waitForSelector('.starrow'); ok(await page.locator('.starrow span.on').count() === 3, 'perfect mission gives 3 stars');
await page.screenshot({ path: shots + '/results.png' });
const st = await page.evaluate(() => JSON.parse(localStorage.getItem('kv_save_v1'))); ok(st.xp > 0 && st.coins > 0 && st.progress['math-m1']?.stars === 3 && !st.session, 'rewards + progress saved, session cleared');
await page.evaluate(() => { location.hash = '/home'; }); await page.waitForSelector('.top');
for (const route of ['map', 'daily', 'challenge', 'rank', 'me', 'stats', 'rewards', 'help', 'settings', 'world/word']) { await page.evaluate((r) => { location.hash = '/' + r; }, route); await page.waitForTimeout(150); ok((await page.locator('#app').innerText()).length > 20, `route ${route} renders`); }
await page.evaluate(() => { location.hash = '/map'; }); await page.waitForTimeout(100); await page.screenshot({ path: shots + '/map.png' });
await page.evaluate(() => { location.hash = '/world/math'; }); await page.waitForTimeout(100); await page.screenshot({ path: shots + '/world.png' });
await page.evaluate(() => { location.hash = '/daily'; }); await page.waitForTimeout(100); await page.screenshot({ path: shots + '/daily.png' });
console.log('JS errors:', errors.length ? errors : 'none'); ok(errors.length === 0, 'no console/page errors');
console.log(`${pass} passed, ${fail} failed`); await browser.close(); process.exit(fail ? 1 : 0);
