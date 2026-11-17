// Small shared helpers: seeded RNG, dates, escaping.
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeRng(seed) {
  const f = mulberry32(typeof seed === 'string' ? hashStr(seed) : seed >>> 0);
  const r = () => f();
  r.int = (a, b) => a + Math.floor(f() * (b - a + 1));
  r.pick = (arr) => arr[Math.floor(f() * arr.length)];
  r.shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  r.chance = (p) => f() < p;
  return r;
}
export const pad2 = (n) => String(n).padStart(2, '0');
export function dateKey(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function dayNumber(key) { const [y, m, d] = key.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
export function daysBetween(a, b) { return dayNumber(b) - dayNumber(a); }
export function weekKey(d = new Date()) { // ISO-ish: Monday-start week key
  const k = dateKey(d); const n = dayNumber(k); return 'W' + Math.floor((n + 3) / 7);
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, '').replace(/\s+/g, ' ').trim();
export function distractNums(ans, rng, n = 3) {
  const out = new Set(); const mag = Math.max(2, Math.round(Math.abs(ans) * 0.15));
  let guard = 0;
  while (out.size < n && guard++ < 200) {
    const off = rng.int(1, Math.max(3, mag)) * (rng.chance(0.5) ? 1 : -1);
    const c = ans + off; if (c !== ans && (ans < 0 || c >= 0)) out.add(c);
  }
  let k = 1; while (out.size < n) { if (ans + k !== ans) out.add(ans + k); k++; }
  return [...out];
}
