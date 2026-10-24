const express = require('express');
const config = require('../config');
const otp = require('../services/otp');
const { sendSms } = require('../services/sms');
const { signToken } = require('../auth');
const { ApiError } = require('../errors');
const { publicUser } = require('./me');

const PHONE_RE = /^[6-9]\d{9}$/; // Indian 10-digit mobile

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (!PHONE_RE.test(digits)) throw new ApiError(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  return digits;
}

const OTP_MESSAGES = {
  OTP_NOT_REQUESTED: 'Please request an OTP first',
  OTP_EXPIRED: 'OTP expired, please request a new one',
  OTP_TOO_MANY_ATTEMPTS: 'Too many wrong attempts, please request a new OTP',
  OTP_INVALID: 'Incorrect OTP',
};

module.exports = function authRoutes(store) {
  const router = express.Router();

  router.post('/send-otp', async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const result = otp.issue(phone);
    if (result.error) {
      throw new ApiError(429, result.error, 'Please wait before requesting another OTP', {
        retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
      });
    }
    await sendSms(phone, `${result.code} is your Sports Space login OTP. Valid for 5 minutes. Do not share it with anyone.`, 'otp');
    res.json({
      phone,
      expiresInSeconds: config.otp.ttlMs / 1000,
      resendInSeconds: config.otp.resendCooldownMs / 1000,
      ...(config.exposeDevOtp && { devOtp: result.code }),
    });
  });

  router.post('/verify-otp', (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const err = otp.verify(phone, req.body.otp);
    if (err) throw new ApiError(400, err, OTP_MESSAGES[err]);

    let user = store.data.users.find((u) => u.phone === phone);
    if (!user) {
      user = { phone, name: '', favorites: [], createdAt: new Date().toISOString() };
      store.data.users.push(user);
      store.save();
    }
    res.json({ token: signToken(phone), user: publicUser(store, user) });
  });

  return router;
};
