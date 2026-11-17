// On-device analytics (aggregated counters only, no personal data, nothing leaves the device).
import { storage } from './contentStore.js';
const KEY = 'kv_analytics_v1';
const load = () => { try { return JSON.parse(storage.get(KEY) || '{}') || {}; } catch { return {}; } };
export function track(event, props = {}) {
  try {
    const a = load(); const day = new Date().toISOString().slice(0, 10); const d = (a.days ||= {}); const x = (d[day] ||= { sessions: 0, missions: 0, answers: 0, correct: 0, playSec: 0, worlds: {}, ads: {}, feedback: 0 });
    a.first ||= day;
    switch (event) {
      case 'session': x.sessions++; break;
      case 'mission': x.missions++; x.worlds[props.world] = (x.worlds[props.world] || 0) + 1; break;
      case 'answers': x.answers += props.n; x.correct += props.c; x.playSec += props.sec || 0; break;
      case 'ad': { const k = `${props.format}:${props.type}`; x.ads[k] = (x.ads[k] || 0) + 1; break; }
      case 'feedback': (a.feedback ||= []).unshift({ ts: Date.now(), text: String(props.text).slice(0, 500), rating: props.rating }); a.feedback = a.feedback.slice(0, 100); x.feedback++; break;
      case 'report': (a.reports ||= []).unshift({ ts: Date.now(), qid: props.qid, reason: String(props.reason).slice(0, 200) }); a.reports = a.reports.slice(0, 200); break;
    }
    storage.set(KEY, JSON.stringify(a));
  } catch { /* analytics must never break the game */ }
}
export const readAnalytics = load;
