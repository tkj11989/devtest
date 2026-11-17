import { store } from './store.js';
import { t } from './i18n.js';
import { renderBanner } from './ads.js';
import { $, $$, themeStyle } from './ui.js';
import { worldById } from './content/index.js';
import { sound } from './audio.js';
export const routes = []; let cleanup = null;
export const on = (pattern, fn) => routes.push({ re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
export const go = (path) => { if (location.hash === '#' + path) route(); else location.hash = path; };
export function setCleanup(fn) { cleanup = fn; }
export function route() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const path = location.hash.slice(1) || '/home';
  for (const r of routes) { const m = r.re.exec(path); if (m) { try { r.fn(m.groups || {}); } catch (e) { console.error(e); showError(e); } return; } }
  go('/home');
}
export function showError(e) { $('#app').innerHTML = `<div class="pad stack center"><div class="big">🛠️</div><h2>Something went wrong</h2><p class="muted">Your progress is safe. ${String(e.message || e).slice(0, 120)}</p><button class="btn" data-go="/home">Back to Home</button></div>`; bindGo($('#app')); }
export function bindGo(root) { $$('[data-go]', root).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); sound.tap(); go(b.dataset.go); })); }
const NAV = [['/home', '🏠', 'nav.home'], ['/map', '🗺️', 'nav.map'], ['/daily', '📅', 'nav.daily'], ['/rank', '🏆', 'nav.rank'], ['/me', '🧑', 'nav.me']];
export function view(html, { nav = true, banner = nav, world = null, noPad = true } = {}) {
  const app = $('#app'); app.innerHTML = html; app.scrollTop = 0;
  const w = world ? worldById(world) : null; const shell = $('#shell');
  shell.style.cssText = w ? themeStyle(w) : '';
  $('#nav').hidden = !nav; const path = location.hash.slice(1) || '/home';
  $('#nav').innerHTML = NAV.map(([p, i, k]) => `<button data-go="${p}" ${path === p || (p !== '/home' && path.startsWith(p + '/')) || (p === '/map' && path.startsWith('/world')) ? 'aria-current="page"' : ''}><span class="i" aria-hidden="true">${i}</span>${t(k)}</button>`).join('');
  bindGo($('#nav')); bindGo(app); renderBanner($('#banner'), banner && nav);
  const s = store.state.settings; document.documentElement.style.setProperty('--fs', [0.9, 1, 1.15, 1.3][s.textSize] ?? 1);
  document.body.classList.toggle('rd-low', !!s.reduceMotion);
  return app;
}
