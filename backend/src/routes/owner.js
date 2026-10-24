const express = require('express');
const { requireAuth } = require('../auth');
const { getSlots, isActive, slotLabel } = require('../services/slots');
const { todayLocal, isValidDate } = require('../services/time');
const { assertBookableDate } = require('./grounds');
const { hasStarted } = require('./bookings');
const { ApiError } = require('../errors');

// Stadium-owner endpoints. A user is an owner of every ground whose
// ownerPhone matches their number.
function ownerRoutes(store) {
  const router = express.Router();
  router.use(requireAuth);

  const owned = (req) => store.data.grounds.filter((g) => g.ownerPhone === req.phone);
  const ownGround = (req, id) => {
    const ground = owned(req).find((g) => g.id === id);
    if (!ground) throw new ApiError(404, 'GROUND_NOT_FOUND', 'Ground not found');
    return ground;
  };
  const parseHour = (v) => {
    const h = Number(v);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new ApiError(400, 'INVALID_HOUR', 'Start hour must be 0-23');
    return h;
  };
  const parsePrice = (v) => {
    const p = Number(v);
    if (!Number.isInteger(p) || p <= 0 || p > 100000) throw new ApiError(400, 'INVALID_PRICE', 'Enter a valid price');
    return p;
  };

  router.get('/grounds', (req, res) => res.json(owned(req).map(({ id, name, area, sportId, type }) => ({ id, name, area, sportId, type }))));

  // Stats across the given ground (or all owned grounds) plus today's bookings.
  router.get('/dashboard', (req, res) => {
    const ids = new Set(req.query.groundId ? [ownGround(req, req.query.groundId).id] : owned(req).map((g) => g.id));
    const bookings = store.data.bookings.filter((b) => ids.has(b.groundId) && b.status === 'CONFIRMED');
    const today = todayLocal();
    res.json({
      totalBookings: bookings.length,
      totalRevenue: bookings.reduce((sum, b) => sum + b.amount, 0),
      upcoming: bookings.filter((b) => !hasStarted(b)).length,
      completed: bookings.filter((b) => hasStarted(b)).length,
      pendingPayments: bookings.filter((b) => b.paymentStatus === 'PAY_AT_VENUE').length,
      today: bookings
        .filter((b) => b.date === today)
        .sort((a, b) => a.startHour - b.startHour)
        .map((b) => ({
          id: b.id,
          code: b.code,
          groundName: b.groundName,
          slotLabel: b.slotLabel,
          customerName: b.customerName || `+91 ${b.phone}`,
          phone: b.phone,
          amount: b.amount,
          paymentStatus: b.paymentStatus,
        })),
    });
  });

  // Owner collected cash/UPI at the venue for a pay-at-venue booking.
  router.post('/bookings/:id/collect', (req, res) => {
    const ids = new Set(owned(req).map((g) => g.id));
    const booking = store.data.bookings.find((b) => b.id === req.params.id && ids.has(b.groundId));
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    if (booking.paymentStatus === 'PAY_AT_VENUE') {
      booking.paymentStatus = 'PAID';
      booking.paidAt = new Date().toISOString();
      store.save();
    }
    res.json({ booking });
  });

  router.get('/grounds/:id/slots', (req, res) => {
    const ground = ownGround(req, req.params.id);
    const { date } = req.query;
    if (!isValidDate(date)) throw new ApiError(400, 'INVALID_DATE', 'Date must be YYYY-MM-DD');
    res.json({
      groundId: ground.id,
      date,
      slots: getSlots(store, ground, date).map(({ booking, ...s }) => ({
        ...s,
        enabled: s.status !== 'BLOCKED',
        bookedBy: booking ? booking.customerName || `+91 ${booking.phone}` : null,
      })),
    });
  });

  router.post('/grounds/:id/slots', (req, res) => {
    const ground = ownGround(req, req.params.id);
    const startHour = parseHour(req.body.startHour);
    if (ground.slots.some((s) => s.startHour === startHour)) {
      throw new ApiError(409, 'SLOT_EXISTS', `${slotLabel(startHour)} already exists`);
    }
    ground.slots.push({ startHour, price: parsePrice(req.body.price) });
    store.save();
    res.status(201).json({ ok: true });
  });

  router.patch('/grounds/:id/slots/:hour', (req, res) => {
    const ground = ownGround(req, req.params.id);
    const slot = ground.slots.find((s) => s.startHour === parseHour(req.params.hour));
    if (!slot) throw new ApiError(404, 'SLOT_NOT_FOUND', 'Slot not found');
    slot.price = parsePrice(req.body.price);
    store.save();
    res.json({ ok: true });
  });

  router.delete('/grounds/:id/slots/:hour', (req, res) => {
    const ground = ownGround(req, req.params.id);
    const hour = parseHour(req.params.hour);
    const hasFutureBookings = store.data.bookings.some(
      (b) => b.groundId === ground.id && b.startHour === hour && isActive(b) && !hasStarted(b),
    );
    if (hasFutureBookings) throw new ApiError(409, 'SLOT_HAS_BOOKINGS', 'This slot has upcoming bookings. Turn it off for specific dates instead.');
    ground.slots = ground.slots.filter((s) => s.startHour !== hour);
    store.save();
    res.json({ ok: true });
  });

  // Turn a slot on/off for one date. Existing bookings are unaffected.
  router.put('/grounds/:id/slots/:hour/availability', (req, res) => {
    const ground = ownGround(req, req.params.id);
    const hour = parseHour(req.params.hour);
    const { date, enabled } = req.body;
    assertBookableDate(date);
    store.data.blockedSlots = store.data.blockedSlots.filter(
      (s) => !(s.groundId === ground.id && s.date === date && s.startHour === hour),
    );
    if (enabled === false) store.data.blockedSlots.push({ groundId: ground.id, date, startHour: hour });
    store.save();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { ownerRoutes };
