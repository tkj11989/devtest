const config = require('../config');
const { ApiError } = require('../errors');

function findCoupon(store, code) {
  return store.data.coupons.find((c) => c.code === String(code || '').trim().toUpperCase());
}

// Throws if the coupon doesn't exist or doesn't apply to this amount.
function couponDiscount(coupon, amount) {
  if (amount < coupon.minAmount) {
    throw new ApiError(400, 'COUPON_NOT_APPLICABLE', `${coupon.code} needs a booking of at least ₹${coupon.minAmount}`);
  }
  if (coupon.type === 'FLAT') return Math.min(coupon.value, amount);
  return Math.min(Math.round((amount * coupon.value) / 100), coupon.maxDiscount ?? Infinity);
}

function quote(store, amount, couponCode) {
  let discount = 0;
  let coupon = null;
  if (couponCode) {
    coupon = findCoupon(store, couponCode);
    if (!coupon) throw new ApiError(400, 'INVALID_COUPON', 'This coupon code is not valid');
    discount = couponDiscount(coupon, amount);
  }
  return {
    amount,
    platformFee: config.platformFee,
    discount,
    couponCode: coupon?.code ?? null,
    total: amount + config.platformFee - discount,
  };
}

module.exports = { quote };
