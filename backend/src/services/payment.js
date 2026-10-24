const crypto = require('crypto');
const config = require('../config');

// Signature scheme matches Razorpay: HMAC_SHA256(orderId|paymentId, keySecret).
// The mock provider uses the same scheme with a local secret so the app can
// exercise the full online flow without a gateway account.
const MOCK_SECRET = 'mock-gateway-secret';
const secret = () => (config.paymentProvider === 'razorpay' ? config.razorpay.keySecret : MOCK_SECRET);

const sign = (orderId, paymentId) =>
  crypto.createHmac('sha256', secret()).update(`${orderId}|${paymentId}`).digest('hex');

// `transfers` (Razorpay Route) splits the payment to linked accounts on capture.
async function createOrder({ amount, receipt, transfers }) {
  if (config.paymentProvider === 'razorpay') {
    const { keyId, keySecret } = config.razorpay;
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt, ...(transfers && { transfers }) }),
    });
    if (!res.ok) throw new Error(`Razorpay order failed: ${res.status} ${await res.text()}`);
    const order = await res.json();
    return { provider: 'razorpay', orderId: order.id, amount, currency: 'INR', keyId };
  }
  return { provider: 'mock', orderId: `order_mock_${crypto.randomBytes(6).toString('hex')}`, amount, currency: 'INR' };
}

function verifySignature(orderId, paymentId, signature) {
  if (!orderId || !paymentId || typeof signature !== 'string') return false;
  const expected = Buffer.from(sign(orderId, paymentId));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Simulates the gateway's checkout for the mock provider only.
function mockCapture(orderId) {
  const paymentId = `pay_mock_${crypto.randomBytes(6).toString('hex')}`;
  return { paymentId, signature: sign(orderId, paymentId) };
}

// Razorpay Route direct transfer from the platform's own balance.
async function directTransfer({ account, amount, notes }) {
  const { keyId, keySecret } = config.razorpay;
  const res = await fetch('https://api.razorpay.com/v1/transfers', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ account, amount: amount * 100, currency: 'INR', notes }),
  });
  if (!res.ok) throw new Error(`Razorpay transfer failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { createOrder, verifySignature, mockCapture, directTransfer };
