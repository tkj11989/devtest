// Verifies rewarded-ad rules in the browser (test ads): reward only after full view, idempotent, optional.
import { createRequire } from 'module'; const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://localhost:8123';
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 390, height: 780 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('✗', m); } };
await p.goto(base + '/index.html'); await p.waitForSelector('#nx'); await p.fill('#nm', 'AdTester'); await p.click('#nx'); await p.click('[data-age="adult"]'); for (let i = 0; i < 4; i++) await p.click('#nx'); await p.waitForSelector('.top');
await p.evaluate(() => { location.hash = '/world/math'; }); await p.click('.mission:not(.locked)'); await p.click('[data-close="go"]'); await p.waitForSelector('#qbox');
ok(await p.evaluate(() => JSON.parse(localStorage.getItem('kv_save_v1')).coins) === 0, 'starts with 0 coins');
// hint with no coins → offered rewarded ad; skipping gives nothing
await p.click('#hint'); await p.waitForSelector('text=Need a hint?'); await p.click('text=Watch ad'); await p.waitForSelector('.ad-full'); await p.click('#adskip'); await p.waitForTimeout(200);
ok(await p.evaluate(() => JSON.parse(localStorage.getItem('kv_save_v1')).ads.rewarded.completed) === 0, 'skipped ad is not counted as completed'); ok(await p.locator('#hint:not([disabled])').count() === 1, 'no hint granted without completion');
// complete the ad
await p.click('#hint'); await p.click('text=Watch ad'); await p.waitForSelector('.ad-full'); await p.waitForSelector('.ad-full', { state: 'detached', timeout: 9000 }); await p.waitForTimeout(200);
const ads = await p.evaluate(() => JSON.parse(localStorage.getItem('kv_save_v1')).ads); ok(ads.rewarded.completed === 1 && ads.rewarded.requested === 2 && ads.hintsFromAds === 1, 'verified completion recorded once');
ok(await p.locator('#hint[disabled]').count() === 1, 'hint applied after verified ad');
// no interstitial can appear during gameplay
ok(await p.locator('.ad-full').count() === 0, 'no ad during gameplay');
// parental: disabling rewarded ads removes the option
await p.evaluate(async () => { const { store } = await import('./js/store.js'); store.state.parental.rewardedAds = false; store.state.session = null; store.save(); location.hash = '/home'; }); await p.waitForSelector('.top');
await p.evaluate(() => { location.hash = '/world/math'; }); await p.click('.mission:not(.locked)'); await p.click('[data-close="go"]'); await p.waitForSelector('#hint'); await p.click('#hint'); await p.waitForTimeout(200);
ok(await p.locator('text=Need a hint?').count() === 0, 'no ad offer when parent disabled rewarded ads');
// banner never on gameplay
ok(await p.locator('#banner:visible').count() === 0, 'banner hidden during gameplay');
console.log('errors:', errs.length ? errs : 'none'); ok(errs.length === 0, 'no JS errors'); console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
