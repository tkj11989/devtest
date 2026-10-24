const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth');
const { getSlots, isActive } = require('../services/slots');
const { todayLocal, localNow } = require('../services/time');
const { quote } = require('../services/pricing');
const payment = require('../services/payment');
const { notifyBooking } = require('../services/notify');
const { assertBookableDate, findGround } = require('./grounds');
const { ApiError } = require('../errors');

const PAYMENT_METHODS = ['OFFLINE', 'ONLINE'];
const ONLINE_CHANNELS = ['UPI', 'CARD', 'NETBANKING', 'WALLET'];

// e.g. CG20261024A0F1: sport code + play date + random suffix.
const bookingCode = (sportCode, date) =>
  `${sportCode}${date.replace(/-/g, '')}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

function confirmationMessage(b) {
  const pay = b.paymentStatus === 'PAID' ? `Paid Rs.${b.total} online` : `Pay Rs.${b.total} at venue`;
  return `Booking confirmed! ID ${b.code}: ${b.groundName}, ${b.area}, ${b.cityName} on ${b.date}, ${b.slotLabel}. ${pay}. Show your ticket at the venue. - Sports Space`;
}

const hasStarted = (b) => b.date < todayLocal() || (b.date === todayLocal() && b.startHour <= localNow().getUTCHours());

function bookingRoutes(store) {
  const router = express.Router();
  router.use(requireAuth);

  const findOwn = (req) => {
    const booking = store.data.bookings.find((b) => b.id === req.params.id && b.phone === req.phone);
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    return booking;
  };

  // Validates the ground/date/slot and returns it with the price breakdown.
  function prepare(body) {
    const ground = findGround(store, body.groundId);
    assertBookableDate(body.date);
    const slot = getSlots(store, ground, body.date).find((s) => s.startHour === body.startHour);
    if (!slot) throw new ApiError(400, 'INVALID_SLOT', 'Slot not found');
    if (slot.status !== 'AVAILABLE') {
      throw new ApiError(409, 'SLOT_UNAVAILABLE', 'Sorry, this slot was just booked. Please pick another.');
    }
    return { ground, slot, price: quote(store, slot.price, body.couponCode) };
  }

  router.post('/quote', (req, res) => res.json(prepare(req.body).price));

  router.get('/', (req, res) => {
    const key = (b) => b.date + String(b.startHour).padStart(2, '0');
    const mine = store.data.bookings
      .filter((b) => b.phone === req.phone && (b.status === 'CONFIRMED' || b.status === 'CANCELLED'))
      .map((b) => ({ ...b, started: hasStarted(b) }))
      .sort((a, b) => (key(a) < key(b) ? 1 : -1));
    res.json(mine);
  });

  router.get('/:id', (req, res) => {
    const b = findOwn(req);
    res.json({ ...b, started: hasStarted(b) });
  });

  router.post('/', async (req, res) => {
    const { paymentMethod, paymentChannel } = req.body;
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new ApiError(400, 'INVALID_PAYMENT_METHOD', 'Choose a payment method');
    }
    const online = paymentMethod === 'ONLINE';
    if (online && !ONLINE_CHANNELS.includes(paymentChannel)) {
      throw new ApiError(400, 'INVALID_PAYMENT_METHOD', 'Choose UPI, card, net banking or wallet');
    }
    const { ground, slot, price } = prepare(req.body);
    const sport = store.data.sports.find((s) => s.id === ground.sportId);
    const city = store.data.cities.find((c) => c.id === ground.city);
    const user = store.data.users.find((u) => u.phone === req.phone);

    const booking = {
      id: crypto.randomUUID(),
      code: bookingCode(sport.code, req.body.date),
      phone: req.phone,
      customerName: user?.name || '',
      sportId: sport.id,
      sportName: sport.name,
      groundId: ground.id,
      groundName: ground.name,
      groundType: ground.type,
      area: ground.area,
      cityName: city.name,
      date: req.body.date,
      startHour: slot.startHour,
      slotLabel: slot.label,
      ...price,
      paymentMethod,
      paymentChannel: online ? paymentChannel : 'VENUE',
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
      await notifyBooking(store, booking, 'Booking confirmed', confirmationMessage(booking));
      return res.status(201).json({ booking });
    }

    try {
      const order = await payment.createOrder({ amount: booking.total, receipt: booking.code });
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
    await notifyBooking(store, booking, 'Booking confirmed', confirmationMessage(booking));
    res.json({ booking });
  });

  router.post('/:id/cancel', async (req, res) => {
    const booking = findOwn(req);
    if (booking.status === 'CANCELLED') return res.json({ booking });
    if (hasStarted(booking)) throw new ApiError(400, 'CANNOT_CANCEL', 'Past bookings cannot be cancelled');

    const wasConfirmed = booking.status === 'CONFIRMED';
    booking.status = 'CANCELLED';
    booking.cancelledAt = new Date().toISOString();
    if (booking.paymentStatus === 'PAID') booking.paymentStatus = 'REFUND_INITIATED';
    store.save();
    if (wasConfirmed) {
      const refund = booking.paymentStatus === 'REFUND_INITIATED' ? ` Refund of Rs.${booking.total} will reach you in 5-7 days.` : '';
      await notifyBooking(
        store,
        booking,
        'Booking cancelled',
        `Booking ${booking.code} at ${booking.groundName} on ${booking.date}, ${booking.slotLabel} has been cancelled.${refund} - Sports Space`,
      );
    }
    res.json({ booking });
  });

  return router;
}

module.exports = { bookingRoutes, hasStarted };
