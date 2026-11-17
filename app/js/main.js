import { store } from './store.js';
import { initI18n } from './i18n.js';
import { on, route, go } from './router.js';
import { splash, onboarding, home, map, world } from './screens_home.js';
import { playScreen } from './play.js';
import { daily, challenge, rank, me, stats, rewards, settings, parental, help } from './screens_more.js';
import { syncMusic } from './audio.js';
import { initAds } from './ads.js';
import { track } from './analytics.js';
import { getContent } from './contentStore.js';

store.load(); globalThis.__KV_CUR = store.state.settings.currency || getContent().settings.currency;
const guard = (fn) => (p) => (store.state.profile ? fn(p) : go('/welcome'));
on('/', splash); on('/splash', splash); on('/welcome', onboarding);
on('/home', guard(home)); on('/map', guard(map)); on('/world/:id', guard(world)); on('/play', guard(playScreen));
on('/daily', guard(daily)); on('/challenge', guard(challenge)); on('/rank', guard(rank)); on('/me', guard(me));
on('/stats', guard(stats)); on('/rewards', guard(rewards)); on('/settings', guard(settings)); on('/parental', guard((p) => parental(p))); on('/help', guard(help));
await initI18n(store.state.profile?.lang || 'en');
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => store.save());
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled', e.reason));
if (store.state.profile) { initAds(); track('session'); }
syncMusic(); document.addEventListener('pointerdown', () => syncMusic(), { once: true });
if (!location.hash) { location.hash = '/splash'; } else route();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
