const config = require('../config');
const { localNow, todayLocal, formatHour } = require('./time');

const MAX_ADVANCE_DAYS = 30;

// A booking blocks its slot while confirmed, or while it is awaiting online
// payment and the hold hasn't expired.
function isActive(booking, now = Date.now()) {
  if (booking.status === 'CONFIRMED') return true;
  if (booking.status === 'PENDING_PAYMENT') {
    return now - new Date(booking.createdAt).getTime() < config.paymentHoldMs;
  }
  return false;
}

const slotLabel = (h) => `${formatHour(h)} - ${formatHour(h + 1)}`;

// Every slot in the ground's template for a date, with its status:
// AVAILABLE | BOOKED | PAST | BLOCKED (switched off by the owner).
function getSlots(store, ground, date, now = Date.now()) {
  const bookings = new Map(
    store.data.bookings
      .filter((b) => b.groundId === ground.id && b.date === date && isActive(b, now))
      .map((b) => [b.startHour, b]),
  );
  const blocked = new Set(
    store.data.blockedSlots.filter((s) => s.groundId === ground.id && s.date === date).map((s) => s.startHour),
  );
  const isToday = date === todayLocal(now);
  const currentHour = localNow(now).getUTCHours();

  return [...ground.slots]
    .sort((a, b) => a.startHour - b.startHour)
    .map(({ startHour, price }) => {
      let status = 'AVAILABLE';
      if (bookings.has(startHour)) status = 'BOOKED';
      else if (isToday && startHour <= currentHour) status = 'PAST';
      else if (blocked.has(startHour)) status = 'BLOCKED';
      return { startHour, label: slotLabel(startHour), price, status, booking: bookings.get(startHour) };
    });
}

module.exports = { getSlots, isActive, slotLabel, MAX_ADVANCE_DAYS };
