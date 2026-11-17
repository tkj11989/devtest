// Admin dashboard smoke test. Usage: node tests/admin_smoke.mjs [baseUrl]
import { createRequire } from 'module'; const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://localhost:8123'; const shots = process.env.SHOTS || '/tmp';
const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } }); const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('dialog', (d) => d.accept('Outdated fact'));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('✗', m); } };
await page.goto(base + '/admin/index.html'); await page.waitForSelector('#go');
await page.fill('#u', 'admin'); await page.fill('#p', 'short'); await page.click('#go'); ok((await page.locator('#e').innerText()).length > 0, 'weak passphrase rejected');
await page.fill('#p', 'correct horse battery'); await page.click('#go'); await page.waitForSelector('aside');
ok(await page.locator('aside [data-t]').count() === 13, 'admin sees 13 sections');
for (const t of ['Worlds', 'Missions & Levels', 'Questions', 'Quality & Reports', 'Daily Challenges', 'Rewards', 'Difficulty', 'Users', 'Leaderboard Moderation', 'Advertising', 'Analytics', 'Settings & Backup', 'Overview']) { await page.click(`aside button:text-is("${t}")`); await page.waitForTimeout(80); ok((await page.locator('main').innerText()).length > 40, `tab ${t} renders`); }
// create a custom question
await page.click('aside button:text-is("Questions")'); await page.click('#new'); await page.waitForSelector('#esv');
await page.selectOption('#ew', 'word'); await page.fill('#eq', 'Which word means the same as “gigantic”?'); await page.fill('#ea', 'huge'); await page.fill('#ew2', 'tiny\nquiet\nslow'); await page.fill('#ex', 'Gigantic means extremely large, like huge.'); await page.fill('#eo', 'Understand synonyms'); await page.click('#esv'); await page.waitForTimeout(200);
await page.fill('#fq', 'gigantic'); await page.press('#fq', 'Enter'); await page.waitForTimeout(100); ok(await page.locator('td:has-text("gigantic")').count() > 0, 'custom question listed');
// duplicate prevention
await page.click('#new'); await page.waitForSelector('#esv'); await page.selectOption('#ew', 'word'); await page.fill('#eq', 'Which word means the same as “gigantic”?'); await page.fill('#ea', 'huge'); await page.fill('#ew2', 'tiny\nquiet\nslow'); await page.fill('#ex', 'Duplicate explanation text.'); await page.click('#esv'); ok((await page.locator('#eerr').innerText()).includes('already exists'), 'duplicate blocked'); await page.click('#ecl');
// validation
await page.click('#new'); await page.waitForSelector('#esv'); await page.fill('#eq', 'Short'); await page.click('#esv'); ok((await page.locator('#eerr').innerText()).length > 0, 'incomplete question rejected'); await page.click('#ecl');
// game picks it up
const inGame = await page.evaluate(async () => { const C = await import('../js/content/index.js'); C.invalidateBank(); return C.bankFor('word').some((q) => q.q.includes('gigantic')); }); ok(inGame, 'custom question available to the game');
// unpublish + flag
await page.click('.tg >> nth=0'); await page.waitForTimeout(100);
// content manager role restrictions
await page.click('aside button:text-is("Users")'); await page.fill('#nu', 'editor'); await page.fill('#np', 'editorpass123'); await page.selectOption('#nr', 'content'); await page.click('#au'); await page.waitForTimeout(150);
await page.click('aside a#lo'); await page.waitForSelector('#go'); await page.fill('#u', 'editor'); await page.fill('#p', 'editorpass123'); await page.click('#go'); await page.waitForSelector('aside');
ok(await page.locator('aside [data-t]').count() === 6, 'content manager sees only 6 sections'); ok(await page.locator('aside button:text-is("Advertising")').count() === 0, 'content manager cannot see ads/users');
await page.screenshot({ path: shots + '/admin.png' });
console.log('errors:', errors.length ? errors : 'none'); ok(errors.length === 0, 'no JS errors'); console.log(`${pass} passed, ${fail} failed`); await browser.close(); process.exit(fail ? 1 : 0);
