const crypto = require('crypto');
const { sendSms } = require('./sms');

// Sends the booking intimation by SMS and keeps a copy as an in-app
// notification. A failed SMS never undoes a booking; the outcome is recorded
// on the booking so the app (or support) can see it.
async function notifyBooking(store, booking, title, message) {
  store.data.notifications.push({
    id: crypto.randomUUID(),
    phone: booking.phone,
    bookingId: booking.id,
    title,
    message,
    read: false,
    createdAt: new Date().toISOString(),
  });
  try {
    await sendSms(booking.phone, message, 'booking');
    booking.smsStatus = 'SENT';
  } catch (err) {
    console.error(`SMS for booking ${booking.id} failed:`, err.message);
    booking.smsStatus = 'FAILED';
  }
  store.save();
}

module.exports = { notifyBooking };
