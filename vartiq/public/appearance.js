/*
 * Personalisation on the client: light/dark mode, colour theme, app icon, avatar shape.
 * Loaded in <head> so the last-used look is applied before the first paint (no flash).
 * The catalogue (colours, icons) comes from GET /api/v1/appearance; the effective choices
 * come from the server (`me.appearance`), where Premium options already fall back to the free ones.
 */
(function () {
  'use strict';

  const CACHE = 'chat.appearance.v1';
  const root = document.documentElement;
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const DEFAULTS = { mode: 'auto', theme: 'ocean', appIcon: 'classic', avatarShape: 'circle' };
  const originalIcon = document.querySelector('link[rel="icon"]')?.getAttribute('href');

  const originals = new WeakMap(); // each logo's own markup, so Classic can put it back
  let catalogue = null;
  let prefs = { ...DEFAULTS };
  let applied = [];

  const read = () => { try { return JSON.parse(localStorage.getItem(CACHE)); } catch { return null; } };
  const write = (value) => { try { localStorage.setItem(CACHE, JSON.stringify(value)); } catch { /* private mode */ } };

  const isDark = () => prefs.mode === 'dark' || (prefs.mode === 'auto' && dark.matches);

  /** Colour tokens for the theme, for the light or dark look currently showing. */
  function tokensFor(theme, wantDark) {
    if (catalogue) {
      const t = catalogue.themes.find((x) => x.id === theme);
      return t?.tokens ? t.tokens[wantDark ? 'dark' : 'light'] : null;
    }
    const cached = read();
    return cached?.theme === theme ? cached.tokens?.[wantDark ? 'dark' : 'light'] || null : null;
  }

  function paintIcon(tokens) {
    const icon = catalogue?.icons.find((i) => i.id === prefs.appIcon);
    const body = icon ? icon.svg.replace(/^<svg[^>]*>|<\/svg>$/g, '') : null;
    document.querySelectorAll('.brand-logo').forEach((svg) => {
      if (!originals.has(svg)) originals.set(svg, svg.innerHTML);
      svg.innerHTML = prefs.appIcon === 'classic' || !body ? originals.get(svg) : body;
    });
    const link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    if (prefs.appIcon === 'classic') {
      if (originalIcon) { link.setAttribute('href', originalIcon); link.setAttribute('type', 'image/png'); }
      return;
    }
    if (!body) return;
    const primary = tokens?.['--primary'] || '#0670DE';
    const text = tokens?.['--primary-text'] || '#0564C8';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body.replaceAll('var(--primary-text)', text).replaceAll('var(--primary)', primary)}</svg>`;
    link.setAttribute('type', 'image/svg+xml');
    link.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(svg)}`);
  }

  // ---------- the logo follows the theme ----------

  const logoCache = new Map(); // `${src}|${theme}` -> data URL
  let logoRun = 0;

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  /** The blue parts of the VartiQ logo take the theme's hue; the orange stays. Returns a PNG data URL. */
  async function recolour(src, theme) {
    const key = `${src}|${theme.id}`;
    if (logoCache.has(key)) return logoCache.get(key);
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    const satScale = Math.min(1, theme.sat / 80);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
      if (h < 180 || h > 260 || s < 0.12) continue; // not one of the logo's blues
      const [r, g, b] = hslToRgb(theme.hue, Math.min(1, s * satScale), l);
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    }
    ctx.putImageData(data, 0, 0);
    const url = canvas.toDataURL('image/png');
    logoCache.set(key, url);
    return url;
  }

  /** Logo images in the page (login screen, empty screen) and the browser tab icon. */
  async function paintLogo() {
    const run = ++logoRun;
    const theme = catalogue?.themes.find((t) => t.id === prefs.theme);
    const targets = [
      ...[...document.querySelectorAll('img.brand-full-img')].map((n) => ({ n, attr: 'src' })),
      ...[...document.querySelectorAll('.brand-logo image')].filter((n) => (n.getAttribute('data-orig') || n.getAttribute('href') || '').includes('vartiq-mark')).map((n) => ({ n, attr: 'href' })),
    ];
    for (const { n, attr } of targets) {
      if (!n.dataset.orig) n.dataset.orig = n.getAttribute(attr);
      let url = n.dataset.orig;
      if (theme?.hue != null) {
        try { url = await recolour(n.dataset.orig, theme); } catch { /* keep the original */ }
      }
      if (run !== logoRun) return;
      n.setAttribute(attr, url);
    }
    const link = document.querySelector('link[rel="icon"]');
    if (link && prefs.appIcon === 'classic' && theme?.hue != null) {
      try {
        const mark = await recolour('/brand/vartiq-mark.png', theme);
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, 64, 64);
        const m = new Image();
        m.src = mark;
        await m.decode();
        const w = 58; const h = (m.naturalHeight / m.naturalWidth) * w;
        ctx.drawImage(m, 3, (64 - h) / 2, w, h);
        if (run === logoRun) { link.setAttribute('type', 'image/png'); link.setAttribute('href', c.toDataURL('image/png')); }
      } catch { /* keep the file icon */ }
    }
  }

  function apply(next, { save = true } = {}) {
    prefs = { ...DEFAULTS, ...next };
    if (prefs.mode === 'auto') root.removeAttribute('data-mode');
    else root.setAttribute('data-mode', prefs.mode);
    root.dataset.avatarShape = prefs.avatarShape;

    for (const name of applied) root.style.removeProperty(name);
    const tokens = tokensFor(prefs.theme, isDark());
    applied = Object.keys(tokens || {});
    for (const [name, value] of Object.entries(tokens || {})) root.style.setProperty(name, value);

    paintIcon(tokens);
    paintLogo();

    if (save && catalogue) {
      const t = catalogue.themes.find((x) => x.id === prefs.theme);
      write({ prefs, theme: prefs.theme, tokens: t?.tokens || null });
    }
  }

  dark.addEventListener?.('change', () => { if (prefs.mode === 'auto') apply(prefs, { save: false }); });

  const cached = read();
  if (cached?.prefs) {
    prefs = { ...DEFAULTS, ...cached.prefs };
    apply(prefs, { save: false });
  }

  // Get the catalogue now so even the sign-in screen shows the saved theme and its matching logo.
  document.addEventListener('DOMContentLoaded', () => { window.Appearance.load().catch(() => {}); });

  window.Appearance = {
    DEFAULTS,
    get catalogue() { return catalogue; },
    get prefs() { return prefs; },
    /** Fetch the catalogue of themes and icons (public, needs no sign-in). */
    async load() {
      if (catalogue) return catalogue;
      catalogue = await fetch('/api/v1/appearance').then((r) => r.json());
      apply(prefs);
      return catalogue;
    },
    apply,
    /** Back to the app's own look (signed out). */
    reset() { apply(DEFAULTS); },
  };
}());
