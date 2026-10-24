const express = require('express');
const cors = require('cors');
const config = require('./config');
const { createStore } = require('./store');
const { ApiError } = require('./errors');

function createApp(store = createStore(config.dbFile)) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/config', (_req, res) =>
    res.json({
      paymentProvider: config.paymentProvider,
      ...(config.paymentProvider === 'razorpay' && { razorpayKeyId: config.razorpay.keyId }),
    }),
  );
  app.use('/auth', require('./routes/auth')(store));
  app.use('/', require('./routes/catalog')(store));
  app.use('/bookings', require('./routes/bookings')(store));
  app.use('/payments', require('./routes/payments')(store));

  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Not found')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'BAD_JSON', message: 'Malformed JSON body' });
    }
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong' });
  });

  app.locals.store = store;
  return app;
}

module.exports = { createApp };
