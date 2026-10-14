'use strict';

/**
 * Personalisation: colour themes, app icons and avatar shapes.
 *
 * The catalogue is served to every client (`GET /api/v1/appearance`), including mobile apps,
 * which apply the colour values themselves. Colour themes, extra app icons and avatar shapes
 * are Premium; the light/dark/auto mode is free. Every theme is generated so its text and
 * background pairs meet WCAG AA contrast in both light and dark (checked by the tests).
 */

// ---------- colour maths ----------

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const hsl = (h, s, l) => hex(hslToRgb(h, s, l));
function luminance(color) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Step lightness (from `from` towards `to`) until `color(l)` has contrast `min` against every colour in `against`. */
function fit(make, from, to, against, min) {
  const step = from < to ? 1 : -1;
  for (let l = from; l !== to + step; l += step) {
    const c = make(l);
    if (against.every((bg) => contrast(c, bg) >= min)) return c;
  }
  return make(to);
}

const SURFACE = { light: ['#ffffff', '#F1F5FB'], dark: ['#0C1730', '#13213F'] };

/** All the colour tokens one theme changes, for light and dark. `sat` 0-100, `h` hue in degrees. */
function makeTokens(h, sat = 80) {
  const light = {};
  light['--primary'] = fit((l) => hsl(h, sat, l), 52, 25, ['#ffffff'], 4.6);
  light['--primary-dark'] = fit((l) => hsl(h, sat, l), 30, 10, ['#ffffff'], 8);
  light['--primary-text'] = fit((l) => hsl(h, sat, l), 45, 15, SURFACE.light, 4.7);
  light['--primary-soft'] = hsl(h, Math.min(sat, 80), 95);
  light['--navy'] = hsl(h, Math.min(sat, 70), 12);
  light['--header-bg'] = `linear-gradient(120deg, ${hsl(h, Math.min(sat, 70), 11)} 0%, ${hsl(h, Math.min(sat, 60), 24)} 100%)`;
  light['--bubble-out'] = hsl(h, Math.min(sat, 85), 91);
  light['--tick-read'] = light['--primary-text'];
  light['--hover'] = hsl(h, Math.min(sat, 40), 96);
  light['--active'] = hsl(h, Math.min(sat, 40), 92);
  light['--chat-bg'] = hsl(h, Math.min(sat, 50), 95);

  const dark = {};
  dark['--primary'] = fit((l) => hsl(h, Math.min(sat, 72), l), 55, 28, ['#ffffff'], 4.6);
  dark['--primary-dark'] = fit((l) => hsl(h, Math.min(sat, 80), l), 38, 12, ['#ffffff'], 8);
  dark['--primary-text'] = fit((l) => hsl(h, Math.min(100, sat + 15), l), 60, 85, SURFACE.dark, 4.7);
  dark['--primary-soft'] = hsl(h, Math.min(sat, 60), 18);
  dark['--header-bg'] = `linear-gradient(120deg, ${hsl(h, Math.min(sat, 60), 7)} 0%, ${hsl(h, Math.min(sat, 55), 17)} 100%)`;
  dark['--bubble-out'] = fit((l) => hsl(h, Math.min(sat, 75), l), 34, 14, ['#E6EDF7'], 5.5);
  dark['--tick-read'] = dark['--primary-text'];
  dark['--chat-bg'] = hsl(h, Math.min(sat, 45), 7);
  dark['--hover'] = hsl(h, Math.min(sat, 40), 16);
  dark['--active'] = hsl(h, Math.min(sat, 45), 20);
  return { light, dark };
}

// ---------- the catalogue ----------

/** `default` = the app's own brand colours (no overrides). */
const THEMES = [
  { id: 'ocean', label: 'Ocean', premium: false, swatch: '#0670DE', tokens: null },
  ...[
    ['emerald', 'Emerald', 158, 85], ['teal', 'Teal', 186, 85], ['indigo', 'Indigo', 236, 78], ['violet', 'Violet', 268, 75],
    ['rose', 'Rose', 338, 78], ['crimson', 'Crimson', 355, 76], ['graphite', 'Graphite', 215, 14],
  ].map(([id, label, h, s]) => {
    const tokens = makeTokens(h, s);
    return { id, label, premium: true, swatch: tokens.light['--primary'], tokens };
  }),
];

const ICON_DEFS = {
  classic: { label: 'Classic', premium: false, body: '<path d="M15 4a12 12 0 0 0-10.3 18.1L3 28l6.1-1.6A12 12 0 1 0 15 4Z" fill="var(--primary)"/><rect x="25" y="1" width="4" height="4" rx=".8" fill="#FE730F"/><rect x="21" y="5" width="3" height="3" rx=".7" fill="var(--primary-text)"/><rect x="28" y="7" width="3" height="3" rx=".7" fill="#FF9A15"/>' },
  spark: { label: 'Spark', premium: true, body: '<path d="M15 4a12 12 0 0 0-10.3 18.1L3 28l6.1-1.6A12 12 0 1 0 15 4Z" fill="var(--primary)"/><path d="m16 9 1.8 4.6 4.7 1.7-4.7 1.7L16 21.6l-1.8-4.6-4.7-1.7 4.7-1.7L16 9Z" fill="#fff"/><circle cx="26" cy="5" r="2.2" fill="#FF9A15"/>' },
  heart: { label: 'Heart', premium: true, body: '<path d="M15 4a12 12 0 0 0-10.3 18.1L3 28l6.1-1.6A12 12 0 1 0 15 4Z" fill="var(--primary)"/><path d="M15 20.5s-5.5-3.4-5.5-7.1a3.1 3.1 0 0 1 5.5-1.9 3.1 3.1 0 0 1 5.5 1.9c0 3.7-5.5 7.1-5.5 7.1Z" fill="#fff"/>' },
  bolt: { label: 'Bolt', premium: true, body: '<circle cx="16" cy="16" r="13" fill="var(--primary)"/><path d="M17.5 6 9 17.5h5.5L13.5 26 23 13.5h-5.8L17.5 6Z" fill="#FFD23F"/>' },
  leaf: { label: 'Leaf', premium: true, body: '<path d="M6 26C6 13 13 6 27 5c0 14-7 21-17 21l-4 2 2-5Z" fill="var(--primary)"/><path d="M9 23c4-7 8-10 13-12" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>' },
  star: { label: 'Star', premium: true, body: '<rect x="3" y="3" width="26" height="26" rx="8" fill="var(--primary)"/><path d="m16 8 2.5 5.3 5.8.8-4.2 4.1 1 5.8-5.1-2.7-5.1 2.7 1-5.8-4.2-4.1 5.8-.8L16 8Z" fill="#FFD23F"/>' },
  plane: { label: 'Plane', premium: true, body: '<circle cx="16" cy="16" r="13" fill="var(--primary)"/><path d="M24 8 7.5 14.8l5.2 2 1.6 5.4 2.7-3.6 4.3 3.1L24 8Z" fill="#fff"/>' },
  smile: { label: 'Smile', premium: true, body: '<path d="M15 4a12 12 0 0 0-10.3 18.1L3 28l6.1-1.6A12 12 0 1 0 15 4Z" fill="var(--primary)"/><circle cx="11.5" cy="13" r="1.7" fill="#fff"/><circle cx="18.5" cy="13" r="1.7" fill="#fff"/><path d="M10.5 17.5c1.2 2.4 3 3.4 4.5 3.4s3.3-1 4.5-3.4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>' },
};
const ICONS = Object.entries(ICON_DEFS).map(([id, d]) => ({ id, label: d.label, premium: d.premium, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${d.body}</svg>` }));

const SHAPES = [
  { id: 'circle', label: 'Circle', premium: false },
  { id: 'rounded', label: 'Rounded', premium: true },
  { id: 'square', label: 'Square', premium: true },
];
const MODES = ['auto', 'light', 'dark'];

const DEFAULTS = { mode: 'auto', theme: 'ocean', appIcon: 'classic', avatarShape: 'circle' };

const premiumOf = (list, id) => !!list.find((x) => x.id === id)?.premium;

/** Check a preferences patch. Returns the cleaned patch and whether it asks for any Premium option. */
function checkPatch(patch) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400, code: 'invalid_request' });
  if (!patch || typeof patch !== 'object') throw bad('Send the settings to change');
  const out = {};
  let needsPremium = null;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'mode') {
      if (!MODES.includes(value)) throw bad(`mode must be one of: ${MODES.join(', ')}`);
    } else if (key === 'theme') {
      if (!THEMES.some((t) => t.id === value)) throw bad(`Unknown theme "${value}"`);
      if (premiumOf(THEMES, value)) needsPremium = needsPremium || 'Colour themes';
    } else if (key === 'appIcon') {
      if (!ICONS.some((t) => t.id === value)) throw bad(`Unknown app icon "${value}"`);
      if (premiumOf(ICONS, value)) needsPremium = needsPremium || 'Custom app icons';
    } else if (key === 'avatarShape') {
      if (!SHAPES.some((t) => t.id === value)) throw bad(`Unknown avatar shape "${value}"`);
      if (premiumOf(SHAPES, value)) needsPremium = needsPremium || 'Avatar shapes';
    } else {
      throw bad(`Unknown setting "${key}"`);
    }
    out[key] = value;
  }
  if (!Object.keys(out).length) throw bad('Send the settings to change');
  return { patch: out, needsPremium };
}

/** What a person actually gets: Premium choices fall back to the defaults when Premium has ended. */
function effective(saved = {}, premium = false) {
  const merged = { ...DEFAULTS, ...saved };
  if (premium) return merged;
  return {
    mode: merged.mode,
    theme: premiumOf(THEMES, merged.theme) ? DEFAULTS.theme : merged.theme,
    appIcon: premiumOf(ICONS, merged.appIcon) ? DEFAULTS.appIcon : merged.appIcon,
    avatarShape: premiumOf(SHAPES, merged.avatarShape) ? DEFAULTS.avatarShape : merged.avatarShape,
  };
}

const catalogue = () => ({ defaults: DEFAULTS, modes: MODES, themes: THEMES, icons: ICONS, avatarShapes: SHAPES });

module.exports = { THEMES, ICONS, SHAPES, MODES, DEFAULTS, catalogue, checkPatch, effective, contrast, SURFACE };
