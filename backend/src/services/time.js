const config = require('../config');

// The venue's local "now", expressed as a Date whose UTC fields hold local time.
function localNow(now = Date.now()) {
  return new Date(now + config.timezoneOffsetMinutes * 60 * 1000);
}

function todayLocal(now) {
  return localNow(now).toISOString().slice(0, 10);
}

function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatHour(h) {
  const suffix = h >= 12 && h < 24 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:00 ${suffix}`;
}

module.exports = { localNow, todayLocal, isValidDate, addDays, formatHour };
