/**
 * Business hours, shared by the server (away messages) and the browser ("Open now").
 *
 * hours = { mon: { mode: 'hours', open: '09:00', close: '17:00' }, tue: { mode: 'closed' }, wed: { mode: 'open24' }, … }
 * A close time at or before the open time means open past midnight (e.g. 18:00–02:00).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BusinessHours = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const CATEGORIES = [
    'Automotive', 'Beauty, Spa & Salon', 'Clothing & Apparel', 'Education', 'Entertainment', 'Event Planning',
    'Finance & Banking', 'Food & Grocery', 'Health & Medical', 'Hotel & Lodging', 'Non-profit',
    'Professional Services', 'Public Service', 'Restaurant', 'Retail', 'Shopping', 'Travel & Transportation', 'Other',
  ];
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

  function isValidTimeZone(tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  /** Weekday key and minutes since midnight at `date` in `timeZone`. */
  function localNow(timeZone, date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t).value;
    return { day: get('weekday').slice(0, 3).toLowerCase(), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
  }

  /** Is the business open at `date`? Unknown hours count as open (no away messages). */
  function isOpenNow(business, date = new Date()) {
    if (!business?.hours || !business.timezone) return true;
    const { day, minutes } = localNow(business.timezone, date);
    const prevDay = DAYS[(DAYS.indexOf(day) + 6) % 7];
    const today = business.hours[day];
    const yesterday = business.hours[prevDay];
    // Still open from yesterday's overnight hours?
    if (yesterday?.mode === 'hours' && toMinutes(yesterday.close) <= toMinutes(yesterday.open) && minutes < toMinutes(yesterday.close)) return true;
    if (!today || today.mode === 'closed') return false;
    if (today.mode === 'open24') return true;
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);
    return close > open ? minutes >= open && minutes < close : minutes >= open;
  }

  /** "9:00 AM – 5:00 PM", "Open 24 hours" or "Closed". */
  function describeDay(h) {
    if (!h || h.mode === 'closed') return 'Closed';
    if (h.mode === 'open24') return 'Open 24 hours';
    const fmt = (t) => {
      const [hh, mm] = t.split(':').map(Number);
      return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
    };
    return `${fmt(h.open)} – ${fmt(h.close)}`;
  }

  /** Validate and normalise an hours object; throws on bad input. */
  function normaliseHours(hours) {
    if (hours == null) return null;
    if (typeof hours !== 'object') throw new Error('hours must be an object keyed by mon…sun');
    const out = {};
    for (const d of DAYS) {
      const h = hours[d] || { mode: 'closed' };
      if (h.mode === 'closed' || h.mode === 'open24') {
        out[d] = { mode: h.mode };
      } else if (h.mode === 'hours') {
        if (!TIME.test(h.open || '') || !TIME.test(h.close || '')) throw new Error(`${DAY_NAMES[d]}: times must be HH:MM`);
        if (h.open === h.close) throw new Error(`${DAY_NAMES[d]}: opening and closing times are the same`);
        out[d] = { mode: 'hours', open: h.open, close: h.close };
      } else {
        throw new Error(`${DAY_NAMES[d]}: mode must be "hours", "open24" or "closed"`);
      }
    }
    return out;
  }

  return { DAYS, DAY_NAMES, CATEGORIES, isOpenNow, describeDay, localNow, normaliseHours, isValidTimeZone };
}));
