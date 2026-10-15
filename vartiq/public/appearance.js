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
    if (body) document.querySelectorAll('.brand-logo').forEach((svg) => { svg.innerHTML = body; });
    const link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    if (prefs.appIcon === 'classic' && prefs.theme === 'ocean') {
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
