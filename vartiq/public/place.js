/**
 * Small helpers for shared locations, used by the browser (and tested in Node).
 * No map is loaded inside the app: a shared position opens in the person's own map app or OpenStreetMap, so nothing
 * about where people are is sent to a map service until someone taps "Open in map".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Place = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /** Live shares offered in the app (seconds), the same as the server allows. */
  const LIVE_CHOICES = [
    { seconds: 15 * 60, label: '15 minutes' },
    { seconds: 60 * 60, label: '1 hour' },
    { seconds: 8 * 60 * 60, label: '8 hours' },
  ];

  /** A position from a payload or message, checked (anything odd becomes null). */
  function clean(loc) {
    const lat = Number(loc?.lat);
    const lon = Number(loc?.lon);
    if (!loc || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const out = { lat, lon };
    if (loc.acc !== undefined && loc.acc !== null && Number.isFinite(Number(loc.acc)) && Number(loc.acc) >= 0) out.acc = Math.round(Number(loc.acc));
    return out;
  }

  /** From the browser's GeolocationPosition. */
  function fromPosition(pos) {
    return clean({ lat: pos?.coords?.latitude, lon: pos?.coords?.longitude, acc: pos?.coords?.accuracy });
  }

  /** Link that opens the position in a map (OpenStreetMap works everywhere; phones offer their map app for geo: links). */
  function mapUrl(loc) {
    const p = clean(loc);
    if (!p) return null;
    return `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(6)}&mlon=${p.lon.toFixed(6)}#map=17/${p.lat.toFixed(5)}/${p.lon.toFixed(5)}`;
  }

  /** "12.97162, 77.59461 (about 20 m)" */
  function describe(loc) {
    const p = clean(loc);
    if (!p) return '';
    return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${p.acc !== undefined ? ` (within ${p.acc >= 1000 ? `${(p.acc / 1000).toFixed(1)} km` : `${p.acc} m`})` : ''}`;
  }

  /** Distance between two positions in metres. */
  function metres(a, b) {
    const R = 6371000;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * Should a new position be sent on a live share? Only when the person moved a little (so a phone lying on a
   * table sends almost nothing), or as a "still here" signal once a minute; never faster than every 5 seconds.
   */
  function shouldSend(previous, next, now, lastSentAt) {
    if (!previous) return true;
    const since = now - lastSentAt;
    if (since < 5000) return false;
    return metres(previous, next) >= 15 || since >= 60000;
  }

  /** Is this live share still running? (The server also ends it; this keeps a stale saved copy honest.) */
  function liveActive(live, now = Date.now()) {
    return !!live && !live.endedAt && live.until > now;
  }

  /** "2 min ago", "just now" */
  function ago(ts, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 15) return 'just now';
    if (s < 60) return `${s} s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.round(m / 60)} h ago`;
  }

  return { LIVE_CHOICES, clean, fromPosition, mapUrl, describe, metres, shouldSend, liveActive, ago };
}));
