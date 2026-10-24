const config = require('./config');
const { createApp } = require('./app');

if (config.jwtSecret === 'dev-only-change-me' && process.env.NODE_ENV === 'production') {
  throw new Error('Set JWT_SECRET in production');
}

createApp().listen(config.port, () => {
  console.log(`Sports Space API on http://localhost:${config.port} (sms=${config.smsProvider}, payment=${config.paymentProvider})`);
});
