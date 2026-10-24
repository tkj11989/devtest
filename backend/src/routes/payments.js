const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth');
const payment = require('../services/payment');
const { ApiError } = require('../errors');

// Stand-in for the gateway's hosted checkout, available only with
// PAYMENT_PROVIDER=mock. With Razorpay, the app opens Razorpay Checkout and
// receives paymentId/signature from it instead.
module.exports = function paymentRoutes(store) {
  const router = express.Router();

  router.post('/mock-checkout', requireAuth, (req, res) => {
    if (config.paymentProvider !== 'mock') throw new ApiError(404, 'NOT_FOUND', 'Not found');
    const booking = store.data.bookings.find((b) => b.orderId === req.body.orderId && b.phone === req.phone);
    if (!booking) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (req.body.outcome === 'fail') throw new ApiError(402, 'PAYMENT_DECLINED', 'Payment declined by bank');
    res.json(payment.mockCapture(booking.orderId));
  });

  return router;
};
