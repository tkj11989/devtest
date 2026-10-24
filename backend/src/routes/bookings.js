const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth');
const { getSlots, isActive } = require('../services/slots');
const { formatHour, todayLocal, localNow } = require('../services/time');
const payment = require('../services/payment');
const { sendSms } = require('../services/sms');
const { assertBookableDate } = require('./catalog');
const { ApiError } = require('../errors');

const PAYMENT_METHODS = ['OFFLINE', 'ONLINE'];

function bookingCode() {
  return `SS${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function confirmationMessage(b) {
  const pay = b.paymentStatus === 'PAID'
    ? `Paid online Rs.${b.amount}`
    : `Pay Rs.${b.amount} at venue`;
  return `Booking confirmed! ${b.code}: ${b.sportName} at ${b.spaceName}, ${b.location} on ${b.date}, ${b.slotLabel}. ${pay}. - Sports Space`;
}

// Fire-and-forget: a failed SMS must not undo a booking. The outcome is
// recorded on the booking so the app (or support) can see it.
async function notify(store, booking, message) {
  try {
    await sendSms(booking.phone, message, 'booking');
    booking.smsStatus = 'SENT';
  } catch (err) {
    console.error(`SMS for booking ${booking.id} failed:`, err.message);
    booking.smsStatus = 'FAILED';
  }
  store.save();
}

module.exports = function bookingRoutes(store) {
  const router = express.Router();
  router.use(requireAuth);

  const findOwn = (req) => {
    const booking = store.data.bookings.find((b) => b.id === req.params.id && b.phone === req.phone);
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    return booking;
  };

  router.get('/', (req, res) => {
    const mine = store.data.bookings
      .filter((b) => b.phone === req.phone && (b.status !== 'PENDING_PAYMENT' || isActive(b)))
      .sort((a, b) => (a.date + String(a.startHour).padStart(2, '0') < b.date + String(b.startHour).padStart(2, '0') ? 1 : -1));
    res.json(mine);
  });

  router.get('/:id', (req, res) => res.json(findOwn(req)));

  router.post('/', async (req, res) => {
    const { spaceId, date, startHour, paymentMethod } = req.body;
    const space = store.data.spaces.find((s) => s.id === spaceId);
    if (!space) throw new ApiError(404, 'SPACE_NOT_FOUND', 'Space not found');
    assertBookableDate(date);
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new ApiError(400, 'INVALID_PAYMENT_METHOD', 'Choose Online or Offline payment');
    }
    const slot = getSlots(store, space, date).find((s) => s.startHour === startHour);
    if (!slot) throw new ApiError(400, 'INVALID_SLOT', 'Slot not found');
    if (slot.status !== 'AVAILABLE') {
      throw new ApiError(409, 'SLOT_UNAVAILABLE', 'Sorry, this slot was just booked. Please pick another.');
    }

    const sport = store.data.sports.find((s) => s.id === space.sportId);
    const online = paymentMethod === 'ONLINE';
    const booking = {
      id: crypto.randomUUID(),
      code: bookingCode(),
      phone: req.phone,
      sportId: sport.id,
      sportName: sport.name,
      spaceId: space.id,
      spaceName: space.name,
      location: space.location,
      date,
      startHour,
      slotLabel: slot.label,
      amount: slot.price,
      paymentMethod,
      paymentStatus: online ? 'PENDING' : 'PAY_AT_VENUE',
      status: online ? 'PENDING_PAYMENT' : 'CONFIRMED',
      smsStatus: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    // Reserve synchronously before any await so concurrent requests can't
    // both claim the slot.
    store.data.bookings.push(booking);
    store.save();

    if (!online) {
      await notify(store, booking, confirmationMessage(booking));
      return res.status(201).json({ booking });
    }

    try {
      const order = await payment.createOrder({ amount: booking.amount, receipt: booking.code });
      booking.orderId = order.orderId;
      booking.holdExpiresAt = new Date(Date.parse(booking.createdAt) + config.paymentHoldMs).toISOString();
      store.save();
      res.status(201).json({ booking, order });
    } catch (err) {
      booking.status = 'FAILED';
      store.save();
      throw err;
    }
  });

  router.post('/:id/pay', async (req, res) => {
    const booking = findOwn(req);
    if (booking.status === 'CONFIRMED') return res.json({ booking }); // idempotent retry
    if (booking.status !== 'PENDING_PAYMENT' || !isActive(booking)) {
      throw new ApiError(410, 'HOLD_EXPIRED', 'Payment window expired. Please book the slot again.');
    }
    const { paymentId, signature } = req.body;
    if (!payment.verifySignature(booking.orderId, paymentId, signature)) {
      throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'Payment could not be verified');
    }
    Object.assign(booking, {
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      paymentId,
      paidAt: new Date().toISOString(),
    });
    store.save();
    await notify(store, booking, confirmationMessage(booking));
    res.json({ booking });
  });

  router.post('/:id/cancel', async (req, res) => {
    const booking = findOwn(req);
    if (booking.status === 'CANCELLED') return res.json({ booking });
    const started = booking.date < todayLocal() ||
      (booking.date === todayLocal() && booking.startHour <= localNow().getUTCHours());
    if (started) throw new ApiError(400, 'CANNOT_CANCEL', 'Past bookings cannot be cancelled');

    const wasConfirmed = booking.status === 'CONFIRMED';
    booking.status = 'CANCELLED';
    booking.cancelledAt = new Date().toISOString();
    store.save();
    if (wasConfirmed) {
      const refund = booking.paymentStatus === 'PAID' ? ' Your refund of Rs.' + booking.amount + ' will be processed in 5-7 days.' : '';
      await notify(store, booking, `Booking ${booking.code} for ${booking.spaceName} on ${booking.date}, ${formatHour(booking.startHour)} has been cancelled.${refund} - Sports Space`);
    }
    res.json({ booking });
  });

  return router;
};
