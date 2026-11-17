// UI helpers: toast, overlays, confetti, scenes, parental gate.
import { store } from './store.js';
import { esc } from './util.js';
import { sound } from './audio.js';
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let toastT;
export function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }
export const reduceMotion = () => store.state.settings.reduceMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function modal(html, { sheet = false, dismiss = true } = {}) {
  return new Promise((resolve) => {
    const o = $('#overlay'); o.hidden = false; o.innerHTML = `<div class="${sheet ? 'sheet' : 'modal'}" role="dialog" aria-modal="true">${html}</div>`;
    const close = (v) => { o.hidden = true; o.innerHTML = ''; resolve(v); };
    o.onclick = (e) => { if (dismiss && e.target === o) close(undefined); };
    o.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(b.dataset.close === '' ? undefined : b.dataset.close)));
    o.querySelector('input,button')?.focus?.({ preventScroll: true });
    o._close = close;
  });
}
export const closeModal = (v) => { const o = $('#overlay'); if (o._close) o._close(v); else { o.hidden = true; o.innerHTML = ''; } };
export const confirmBox = (title, text, yes = 'Yes', no = 'Cancel') => modal(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="row" style="margin-top:14px"><button class="btn ghost grow" data-close="no">${esc(no)}</button><button class="btn grow" data-close="yes">${esc(yes)}</button></div>`).then((v) => v === 'yes');

// Parental gate: PIN if set, otherwise an adult-level arithmetic question.
export async function gate(reason) {
  const pin = store.state.parental.pin; const a = 6 + Math.floor(Math.random() * 6), b = 7 + Math.floor(Math.random() * 5);
  const p = modal(`<h2>🔒 Ask a grown-up</h2><p class="muted">${esc(reason || 'This needs a grown-up.')}</p>${pin ? '<label class="field"><span>Enter parent PIN</span><input id="gp" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label>' : `<label class="field"><span>What is ${a} × ${b}?</span><input id="gp" type="text" inputmode="numeric" autocomplete="off"></label>`}<p class="small" id="gerr" style="color:var(--bad)"></p><div class="row"><button class="btn ghost grow" data-close="no">Cancel</button><button class="btn grow" id="gok">Continue</button></div>`);
  const ok = $('#gok'); const inp = $('#gp'); const try_ = () => { const v = inp.value.trim(); const good = pin ? v === String(pin) : v === String(a * b); if (good) closeModal('ok'); else { $('#gerr').textContent = pin ? 'Wrong PIN.' : 'Not quite — try again.'; inp.value = ''; } };
  ok.addEventListener('click', try_); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') try_(); });
  const v = await p; return v === 'ok';
}

// ---- confetti ----
export function confetti(n = 120) {
  if (reduceMotion()) return; const c = $('#confetti'); const x = c.getContext('2d'); c.width = innerWidth; c.height = innerHeight;
  const ps = Array.from({ length: n }, () => ({ x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.5, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4, s: 5 + Math.random() * 6, r: Math.random() * 6, c: ['#fde047', '#f472b6', '#60a5fa', '#34d399', '#a78bfa', '#fb923c'][Math.floor(Math.random() * 6)] }));
  let f = 0; (function tick() { x.clearRect(0, 0, c.width, c.height); ps.forEach((p) => { p.x += p.vx; p.y += p.vy; p.r += 0.1; x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; x.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); x.restore(); }); if (++f < 140) requestAnimationFrame(tick); else x.clearRect(0, 0, c.width, c.height); })();
}
export function celebrate(kind = 'reward') { confetti(); sound[kind]?.(); }

// ---- scenery (inline SVG, no downloads) ----
const sc = (inner) => `<svg class="scene" viewBox="0 0 200 110" aria-hidden="true">${inner}</svg>`;
export function scene(id) {
  switch (id) {
    case 'math': return sc('<circle cx="160" cy="25" r="14" fill="#fde047"/><rect x="40" y="55" width="120" height="55" fill="#4c1d95"/><rect x="40" y="38" width="22" height="30" fill="#5b21b6"/><rect x="138" y="38" width="22" height="30" fill="#5b21b6"/><polygon points="36,38 51,18 66,38" fill="#fbbf24"/><polygon points="134,38 149,18 164,38" fill="#fbbf24"/><rect x="88" y="72" width="24" height="38" rx="12" fill="#fbbf24"/><text x="70" y="62" font-size="14" fill="#fde68a">+ − ×</text>');
    case 'word': return sc('<rect x="30" y="70" width="140" height="40" fill="#14532d"/><rect x="40" y="38" width="18" height="40" fill="#fcd34d"/><rect x="62" y="30" width="16" height="48" fill="#f472b6"/><rect x="82" y="42" width="20" height="36" fill="#60a5fa"/><rect x="106" y="34" width="16" height="44" fill="#fb923c"/><rect x="126" y="40" width="22" height="38" fill="#c084fc"/><circle cx="170" cy="30" r="12" fill="#86efac"/>');
    case 'science': return sc('<path d="M85 20h30v30l25 45a8 8 0 0 1-7 12H67a8 8 0 0 1-7-12l25-45z" fill="#a5f3fc" stroke="#0e7490" stroke-width="3"/><circle cx="100" cy="85" r="6" fill="#22d3ee"/><circle cx="115" cy="70" r="4" fill="#67e8f9"/><circle cx="165" cy="25" r="10" fill="none" stroke="#a5f3fc" stroke-width="3"/><circle cx="35" cy="40" r="6" fill="#a5f3fc"/>');
    case 'geo': return sc('<circle cx="110" cy="58" r="45" fill="#38bdf8"/><path d="M80 40q15-12 30 0t10 22q-20 5-30-5t-10-17zM115 70q15 0 20 14-15 8-25-2z" fill="#86efac"/><ellipse cx="110" cy="58" rx="45" ry="14" fill="none" stroke="#fff6" stroke-width="2"/>');
    case 'history': return sc('<polygon points="30,110 90,25 150,110" fill="#e9c46a"/><polygon points="90,25 150,110 110,110" fill="#d4a24c"/><polygon points="120,110 160,60 200,110" fill="#f4d58d"/><circle cx="165" cy="22" r="13" fill="#fef3c7"/>');
    case 'space': return sc('<circle cx="140" cy="45" r="28" fill="#f472b6"/><ellipse cx="140" cy="45" rx="44" ry="9" fill="none" stroke="#fde68a" stroke-width="4" transform="rotate(-18 140 45)"/><circle cx="50" cy="30" r="9" fill="#67e8f9"/><circle cx="30" cy="80" r="2" fill="#fff"/><circle cx="90" cy="15" r="2" fill="#fff"/><circle cx="80" cy="85" r="2" fill="#fff"/><text x="62" y="92" font-size="26">🚀</text>');
    case 'logic': return sc('<rect x="35" y="45" width="130" height="65" fill="#1e293b"/><rect x="35" y="28" width="20" height="25" fill="#334155"/><rect x="145" y="28" width="20" height="25" fill="#334155"/><polygon points="31,28 45,10 59,28" fill="#8b5cf6"/><polygon points="141,28 155,10 169,28" fill="#8b5cf6"/><rect x="88" y="68" width="24" height="42" rx="12" fill="#8b5cf6"/><circle cx="106" cy="90" r="3" fill="#fde047"/>');
    case 'money': return sc('<rect x="25" y="50" width="30" height="60" fill="#0f766e"/><rect x="60" y="25" width="36" height="85" fill="#14b8a6"/><rect x="100" y="42" width="28" height="68" fill="#0d9488"/><rect x="132" y="60" width="38" height="50" fill="#f59e0b"/><circle cx="175" cy="22" r="13" fill="#fde047"/><text x="168" y="28" font-size="14" fill="#92400e">$</text>');
    default: return '';
  }
}
export const stars = (n, max = 3) => `<span class="stars" aria-label="${n} of ${max} stars">${Array.from({ length: max }, (_, i) => `<span class="${i < n ? 'on' : ''}">★</span>`).join('')}</span>`;
export const themeStyle = (w) => `--w1:${w.colors[0]};--w2:${w.colors[1]};--w3:${w.colors[2]}`;
