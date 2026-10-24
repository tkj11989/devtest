const config = {
  port: Number(process.env.PORT) || 4000,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  dbFile: process.env.DB_FILE || '', // empty = in-memory only

  otp: {
    length: 6,
    ttlMs: 5 * 60 * 1000,
    resendCooldownMs: 30 * 1000,
    maxAttempts: 5,
  },

  // How long an unpaid online booking holds its slot before it is released.
  paymentHoldMs: Number(process.env.PAYMENT_HOLD_MS) || 10 * 60 * 1000,

  platformFee: Number(process.env.PLATFORM_FEE ?? 50),

  // The platform admin signs in with this number to see platform earnings
  // and link owners' payout accounts.
  adminPhone: process.env.ADMIN_PHONE || '9000000000',

  timezoneOffsetMinutes: Number(process.env.TZ_OFFSET_MINUTES ?? 330), // IST default

  // console | twilio | msg91
  smsProvider: process.env.SMS_PROVIDER || 'console',
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM,
  },
  msg91: {
    authKey: process.env.MSG91_AUTH_KEY,
    senderId: process.env.MSG91_SENDER_ID,
    otpTemplateId: process.env.MSG91_OTP_TEMPLATE_ID,
    bookingTemplateId: process.env.MSG91_BOOKING_TEMPLATE_ID,
  },

  // mock | razorpay
  paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
  },
};

// Return the dev OTP in API responses only when SMS isn't actually sent.
config.exposeDevOtp = config.smsProvider === 'console';

module.exports = config;
