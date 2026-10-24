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

function getSlots(store, space, date, now = Date.now()) {
  const taken = new Set(
    store.data.bookings
      .filter((b) => b.spaceId === space.id && b.date === date && isActive(b, now))
      .map((b) => b.startHour),
  );
  const isToday = date === todayLocal(now);
  const currentHour = localNow(now).getUTCHours();

  const slots = [];
  for (let h = space.openHour; h < space.closeHour; h++) {
    let status = 'AVAILABLE';
    if (taken.has(h)) status = 'BOOKED';
    else if (isToday && h <= currentHour) status = 'PAST';
    slots.push({
      startHour: h,
      label: `${formatHour(h)} - ${formatHour(h + 1)}`,
      price: space.pricePerSlot,
      status,
    });
  }
  return slots;
}

module.exports = { getSlots, isActive, MAX_ADVANCE_DAYS };
