const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth');
const settlement = require('../services/settlement');
const { publicPayout, validateLinkedAccountId } = require('../services/payouts');
const { ApiError } = require('../errors');

// Platform admin: platform earnings and owner payout accounts.
function adminRoutes(store) {
  const router = express.Router();
  router.use(requireAuth, (req, _res, next) => {
    if (req.phone !== config.adminPhone) return next(new ApiError(403, 'NOT_ADMIN', 'Admins only'));
    next();
  });

  const owners = () => [...new Set(store.data.grounds.map((g) => g.ownerPhone))];
  const findOwner = (phone) => {
    if (!owners().includes(phone)) throw new ApiError(404, 'OWNER_NOT_FOUND', 'Owner not found');
    let user = store.data.users.find((u) => u.phone === phone);
    if (!user) {
      user = { phone, name: '', favorites: [], createdAt: new Date().toISOString() };
      store.data.users.push(user);
    }
    return user;
  };

  router.get('/summary', (_req, res) => {
    const confirmed = store.data.bookings.filter((b) => b.status === 'CONFIRMED');
    res.json({
      ...settlement.platformSummary(store),
      paymentProvider: config.paymentProvider,
      bookings: confirmed.length,
      grossBookingValue: confirmed.reduce((t, b) => t + b.total, 0),
      owners: owners().map((phone) => {
        const user = store.data.users.find((u) => u.phone === phone);
        const { entries, ...summary } = settlement.ownerSummary(store, phone);
        return {
          phone,
          name: user?.name || '',
          grounds: store.data.grounds.filter((g) => g.ownerPhone === phone).map((g) => g.name),
          payout: publicPayout(user?.payout, config.paymentProvider),
          ...summary,
        };
      }),
    });
  });

  // After onboarding the owner in Razorpay (Route → Linked Accounts), record
  // the linked account ID so online payments can be routed to them.
  router.put('/owners/:phone/linked-account', (req, res) => {
    const user = findOwner(req.params.phone);
    if (!user.payout) throw new ApiError(400, 'NO_PAYOUT', 'The owner has not added payout details yet');
    user.payout.linkedAccountId = validateLinkedAccountId(req.body.linkedAccountId);
    store.save();
    res.json(publicPayout(user.payout, config.paymentProvider));
  });

  // Record platform fees an owner has paid for pay-at-venue bookings.
  router.post('/owners/:phone/dues-received', (req, res) => {
    findOwner(req.params.phone);
    const amount = Number(req.body.amount);
    const due = settlement.ownerSummary(store, req.params.phone).platformFeesDue;
    if (!Number.isInteger(amount) || amount <= 0 || amount > due) {
      throw new ApiError(400, 'INVALID_AMOUNT', `Enter an amount between ₹1 and ₹${Math.max(due, 0)}`);
    }
    settlement.addEntry(store, null, 'DUES_SETTLED', amount, { ownerPhone: req.params.phone });
    store.save();
    res.json(settlement.ownerSummary(store, req.params.phone));
  });

  return router;
}

module.exports = { adminRoutes };
