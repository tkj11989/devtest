const { ApiError } = require('../errors');

// Owner payout details: where the venue's share of online payments goes.
//   { method: 'UPI' | 'BANK', contactPhone, accountHolder,
//     upiId?, accountNumber?, ifsc?, linkedAccountId?, updatedAt }
// linkedAccountId is the owner's Razorpay Route linked account (acc_...),
// set by the platform admin once the owner is onboarded on Razorpay.

const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PHONE_RE = /^[6-9]\d{9}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const LINKED_ACCOUNT_RE = /^acc_[A-Za-z0-9]{14}$/;

function validatePayout(body, existing) {
  const method = body.method;
  if (method !== 'UPI' && method !== 'BANK') throw new ApiError(400, 'INVALID_PAYOUT', 'Choose UPI or bank account');
  const accountHolder = String(body.accountHolder || '').trim();
  if (accountHolder.length < 2 || accountHolder.length > 100) {
    throw new ApiError(400, 'INVALID_PAYOUT', 'Enter the account holder name');
  }
  const contactPhone = String(body.contactPhone || '').replace(/\D/g, '').slice(-10);
  if (!PHONE_RE.test(contactPhone)) throw new ApiError(400, 'INVALID_PAYOUT', 'Enter a valid 10-digit payment contact number');

  const payout = { method, accountHolder, contactPhone };
  if (method === 'UPI') {
    const upiId = String(body.upiId || '').trim().toLowerCase();
    if (!UPI_RE.test(upiId)) throw new ApiError(400, 'INVALID_PAYOUT', 'Enter a valid UPI ID, e.g. name@okaxis');
    payout.upiId = upiId;
  } else {
    // The app only ever sees the masked number, so an unchanged form omits it.
    const accountNumber = body.accountNumber ? String(body.accountNumber).replace(/\s/g, '') : existing?.accountNumber;
    if (!ACCOUNT_RE.test(accountNumber || '')) throw new ApiError(400, 'INVALID_PAYOUT', 'Enter a valid bank account number');
    const ifsc = String(body.ifsc || '').trim().toUpperCase();
    if (!IFSC_RE.test(ifsc)) throw new ApiError(400, 'INVALID_PAYOUT', 'Enter a valid IFSC code, e.g. HDFC0001234');
    payout.accountNumber = accountNumber;
    payout.ifsc = ifsc;
  }
  // Changing where money goes means the Razorpay link must be redone.
  const sameDestination =
    existing && existing.method === payout.method && existing.upiId === payout.upiId &&
    existing.accountNumber === payout.accountNumber && existing.ifsc === payout.ifsc;
  if (sameDestination && existing.linkedAccountId) payout.linkedAccountId = existing.linkedAccountId;
  payout.updatedAt = new Date().toISOString();
  return payout;
}

function validateLinkedAccountId(id) {
  if (!LINKED_ACCOUNT_RE.test(String(id || ''))) {
    throw new ApiError(400, 'INVALID_LINKED_ACCOUNT', 'Linked account ID looks like acc_XXXXXXXXXXXXXX');
  }
  return id;
}

const maskAccount = (n) => (n ? `XXXX${n.slice(-4)}` : null);

// A short label for where money goes, safe to show to admins.
function destinationLabel(p) {
  if (!p) return null;
  return p.method === 'UPI' ? `UPI ${p.upiId}` : `A/c ${maskAccount(p.accountNumber)} · ${p.ifsc}`;
}

// The payout details as returned to the app (account number masked).
function publicPayout(p, provider) {
  if (!p) return null;
  const { accountNumber, ...rest } = p;
  return {
    ...rest,
    accountNumberMasked: maskAccount(accountNumber),
    destination: destinationLabel(p),
    // With Razorpay, money can only be routed once the admin has linked the
    // owner's Route account.
    status: provider === 'razorpay' && !p.linkedAccountId ? 'PENDING_LINK' : 'ACTIVE',
  };
}

module.exports = { validatePayout, validateLinkedAccountId, publicPayout, destinationLabel, maskAccount };
