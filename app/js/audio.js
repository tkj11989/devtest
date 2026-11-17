// Synthesised sound (WebAudio) – no downloads, separate music and SFX switches.
import { store } from './store.js';
let ctx = null, musicTimer = null, step = 0;
const ac = () => { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } } if (ctx.state === 'suspended') ctx.resume(); return ctx; };
function tone(freq, dur = 0.12, type = 'sine', vol = 0.12, when = 0) {
  const c = ac(); if (!c) return; const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = freq;
  const t0 = c.currentTime + when; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02);
}
const sfxOn = () => store.state.settings.sfx;
export const sound = {
  tap() { if (sfxOn()) tone(520, 0.05, 'triangle', 0.08); },
  correct() { if (!sfxOn()) return; tone(660, 0.12, 'triangle', 0.14); tone(880, 0.18, 'triangle', 0.14, 0.1); },
  wrong() { if (!sfxOn()) return; tone(220, 0.22, 'sawtooth', 0.08); tone(165, 0.25, 'sawtooth', 0.08, 0.12); },
  reward() { if (!sfxOn()) return; [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.13, i * 0.1)); },
  unlock() { if (!sfxOn()) return; [392, 523, 659, 784, 988].forEach((f, i) => tone(f, 0.2, 'square', 0.07, i * 0.09)); },
  achievement() { if (!sfxOn()) return; [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.22, 'triangle', 0.13, i * 0.12)); },
};
const SCALE = [262, 330, 392, 523, 392, 330, 294, 349, 440, 587, 440, 349];
export function syncMusic() {
  const on = store.state.settings.music;
  if (on && !musicTimer) { musicTimer = setInterval(() => { if (document.hidden) return; tone(SCALE[step++ % SCALE.length] / 2, 0.5, 'sine', 0.035); }, 480); }
  if (!on && musicTimer) { clearInterval(musicTimer); musicTimer = null; }
}
export function haptic(ms = 15) { if (store.state.settings.haptics && navigator.vibrate) try { navigator.vibrate(ms); } catch { /* unsupported */ } }
