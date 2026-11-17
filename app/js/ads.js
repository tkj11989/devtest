// Ad manager. Uses Google AdMob through Capacitor when running as a native app; in the browser it shows clearly-labelled TEST ads only.
// Principles: ads never interrupt a puzzle, never block progress, rewarded ads are optional and only pay after verified completion.
import { store, isChild } from './store.js';
import { getContent } from './contentStore.js';
import { track } from './analytics.js';
import { grant } from './game.js';

const native = () => globalThis.Capacitor?.Plugins?.AdMob || null;
const platform = () => (globalThis.Capacitor?.getPlatform?.() === 'ios' ? 'ios' : 'android');
const cfg = () => getContent().ads;
const locks = { interstitial: false, rewarded: false };
let inited = false;
export const adsAllowedByParent = () => store.state.parental.rewardedAds !== false;

export async function initAds() {
  if (inited) return; inited = true; const n = native(); if (!n) return;
  try {
    await n.initialize({ initializeForTesting: cfg().testMode, tagForChildDirectedTreatment: isChild(), tagForUnderAgeOfConsent: isChild() || store.state.profile?.age === '13-15', maxAdContentRating: isChild() ? 'G' : 'T' });
  } catch (e) { console.warn('AdMob init failed', e); }
}
const unit = (fmt) => cfg().units[platform()][fmt];
const reqOpts = () => ({ isTesting: cfg().testMode, npa: !store.state.privacy.personalisedAds || isChild() });
function count(format, type) { const s = store.state.ads.impressions; const k = `${format}:${type}`; s[k] = (s[k] || 0) + 1; track('ad', { format, type }); }
const overlay = () => document.getElementById('overlay');

export function bannerVisible() { return cfg().bannerEnabled && (!!native() || cfg().testMode); }
export function renderBanner(el, show) {
  if (!show || !bannerVisible()) { el.hidden = true; el.innerHTML = ''; native()?.removeBanner?.().catch(() => {}); return; }
  if (native()) { el.hidden = true; native().showBanner({ adId: unit('banner'), adSize: 'ADAPTIVE_BANNER', position: 'BOTTOM_CENTER', margin: 64, ...reqOpts() }).then(() => count('banner', 'impression')).catch(() => count('banner', 'failed')); return; }
  if (el.dataset.shown !== '1') { el.dataset.shown = '1'; count('banner', 'impression'); }
  el.hidden = false; el.innerHTML = '<span class="ad-label">Test ad</span> Banner placeholder – only shown in test mode';
}

function webAdOverlay({ title, seconds, rewarded }) {
  return new Promise((resolve) => {
    const o = overlay(); o.hidden = false; let left = seconds; let finished = false;
    o.innerHTML = `<div class="ad-full" role="dialog" aria-modal="true" aria-label="Test advertisement"><div class="ad-label">Test ad</div><h2>${title}</h2><p class="muted">This is a development test ad. Real ads appear in the installed app.</p><div class="ad-count" id="adcount">${left}</div>
      <button class="btn ghost" id="adclose" ${rewarded ? 'hidden' : 'disabled'}>Close</button>${rewarded ? '<button class="btn ghost small" id="adskip">Skip (no reward)</button>' : ''}</div>`;
    const done = (ok) => { if (finished) return; finished = true; clearInterval(tm); o.hidden = true; o.innerHTML = ''; resolve(ok); };
    const tm = setInterval(() => { left--; const c = o.querySelector('#adcount'); if (c) c.textContent = Math.max(0, left); if (left <= 0) { clearInterval(tm); if (rewarded) done(true); else { const b = o.querySelector('#adclose'); b.disabled = false; b.textContent = 'Close ✕'; } } }, 1000);
    o.querySelector('#adclose')?.addEventListener('click', () => done(false)); o.querySelector('#adskip')?.addEventListener('click', () => done(false));
  });
}

// Interstitial: only at natural breaks, capped by mission count + cooldown, never during gameplay.
export function interstitialDue() {
  const c = cfg(), a = store.state.ads; if (!c.interstitialEnabled || !(native() || c.testMode)) return false;
  const every = isChild() ? c.interstitialEveryMissions + 2 : c.interstitialEveryMissions;
  return a.missionsSince >= every && Date.now() - a.lastInterstitial > c.interstitialMinSeconds * 1000;
}
export async function maybeInterstitial() {
  if (!interstitialDue() || locks.interstitial) return false; locks.interstitial = true;
  try {
    const n = native();
    if (n) { await n.prepareInterstitial({ adId: unit('interstitial'), ...reqOpts() }); await n.showInterstitial(); } else await webAdOverlay({ title: 'Interstitial', seconds: 3, rewarded: false });
    count('interstitial', 'impression'); store.state.ads.lastInterstitial = Date.now(); store.state.ads.missionsSince = 0; store.save(); return true;
  } catch (e) { count('interstitial', 'failed'); return false; } finally { locks.interstitial = false; }
}

// Rewarded: resolves {status:'rewarded', token} only when the ad reports completion. Otherwise 'unavailable' | 'dismissed' | 'busy' | 'disabled'.
export async function showRewarded(purpose) {
  const c = cfg(); if (!c.rewardedEnabled || !adsAllowedByParent() || !(native() || c.testMode)) return { status: 'disabled' };
  if (locks.rewarded) return { status: 'busy' }; locks.rewarded = true; store.state.ads.rewarded.requested++;
  try {
    const n = native(); let ok = false;
    if (n) {
      await n.prepareRewardVideoAd({ adId: unit('rewarded'), ...reqOpts() });
      ok = await new Promise((res) => { let rewarded = false; const hs = []; const add = (ev, fn) => n.addListener(ev, fn).then((h) => hs.push(h)); add('onRewardedVideoAdReward', () => { rewarded = true; }); add('onRewardedVideoAdDismissed', () => { hs.forEach((h) => h.remove?.()); res(rewarded); }); add('onRewardedVideoAdFailedToShow', () => { hs.forEach((h) => h.remove?.()); res(false); }); n.showRewardVideoAd().catch(() => res(false)); });
    } else ok = await webAdOverlay({ title: 'Rewarded ad', seconds: 5, rewarded: true });
    if (!ok) { count('rewarded', 'dismissed'); store.save(); return { status: 'dismissed' }; }
    count('rewarded', 'impression'); store.state.ads.rewarded.completed++;
    const token = `rw:${purpose}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`; store.save(); return { status: 'rewarded', token };
  } catch (e) { count('rewarded', 'failed'); return { status: 'unavailable' }; } finally { locks.rewarded = false; }
}
// Grant coins for a verified rewarded completion (idempotent by token).
export function grantRewardCoins(token, coins) { const ok = grant(store.state, token, { coins }); store.save(); return ok; }
