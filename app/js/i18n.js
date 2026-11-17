// UI strings live in lang/<code>.json so translations can be added/updated without rebuilding the code.
let dict = {}, fallback = {}, lang = 'en';
export const LANGUAGES = [{ code: 'en', name: 'English', ready: true }, { code: 'hi', name: 'हिन्दी (Hindi)', ready: false }, { code: 'es', name: 'Español', ready: false }, { code: 'fr', name: 'Français', ready: false }, { code: 'de', name: 'Deutsch', ready: false }, { code: 'pt', name: 'Português', ready: false }];
async function load(code) { try { const r = await fetch(`lang/${code}.json`); if (r.ok) return await r.json(); } catch { /* offline */ } return null; }
export async function initI18n(code = 'en') { fallback = (await load('en')) || {}; lang = code; dict = code === 'en' ? fallback : (await load(code)) || {}; document.documentElement.lang = lang; }
export const t = (k, vars = {}) => String(dict[k] ?? fallback[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
