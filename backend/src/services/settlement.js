const crypto = require('crypto');
const config = require('../config');
const payment = require('./payment');
const { destinationLabel } = require('./payouts');

// How a booking's money is divided:
//   owner gets the full slot price (amount);
//   platform gets the platform fee minus any coupon discount.
// When a coupon is bigger than the fee, the platform's share is negative:
// the platform tops up the owner (a "subsidy") so the owner never pays for
// the platform's promotions.
function split(b) {
  const ownerShare = b.amount;
  const platformShare = b.platformFee - b.discount;
  return {
    ownerShare,
    platformShare,
    // Online: the part of the customer's payment routed to the owner, and the
    // top-up the platform sends from its own balance.
    ownerFromPayment: Math.min(ownerShare, b.total),
    subsidy: Math.max(0, ownerShare - b.total),
  };
}

const ownerOf = (store, groundId) => store.data.grounds.find((g) => g.id === groundId)?.ownerPhone;
const userByPhone = (store, phone) => store.data.users.find((u) => u.phone === phone);

// Online payments are only possible when the money has somewhere to go.
function canTakeOnline(store, ground) {
  const payout = userByPhone(store, ground.ownerPhone)?.payout;
  if (!payout) return false;
  return config.paymentProvider !== 'razorpay' || !!payout.linkedAccountId;
}

function addEntry(store, booking, type, amount, extra = {}) {
  if (!amount) return;
  store.data.ledger.push({
    id: crypto.randomUUID(),
    bookingId: booking?.id ?? null,
    bookingCode: booking?.code ?? null,
    groundName: booking?.groundName ?? null,
    ownerPhone: booking?.ownerPhone ?? extra.ownerPhone,
    type,
    amount,
    status: 'PROCESSED',
    createdAt: new Date().toISOString(),
    ...extra,
  });
}

// Razorpay Route transfer instructions attached to the order, so the owner's
// share moves to their linked account as soon as the payment is captured.
function orderTransfers(store, booking) {
  const payout = userByPhone(store, booking.ownerPhone)?.payout;
  if (config.paymentProvider !== 'razorpay' || !payout?.linkedAccountId) return undefined;
  return [
    {
      account: payout.linkedAccountId,
      amount: split(booking).ownerFromPayment * 100,
      currency: 'INR',
      notes: { booking: booking.code },
      on_hold: false,
    },
  ];
}

// Called once an online payment is verified.
async function settleOnlinePayment(store, booking) {
  const payout = userByPhone(store, booking.ownerPhone)?.payout;
  const s = split(booking);
  const destination = destinationLabel(payout);
  // With Razorpay the order's transfer does the move; we record it as
  // initiated and Razorpay settles it to the owner's bank on its schedule.
  const status = config.paymentProvider === 'razorpay' ? 'INITIATED' : 'PROCESSED';
  addEntry(store, booking, 'OWNER_PAYOUT', s.ownerFromPayment, { status, destination });
  if (s.subsidy) {
    let subsidyStatus = status;
    if (config.paymentProvider === 'razorpay') {
      try {
        await payment.directTransfer({ account: payout.linkedAccountId, amount: s.subsidy, notes: { booking: booking.code } });
      } catch (err) {
        console.error(`Subsidy transfer for ${booking.code} failed:`, err.message);
        subsidyStatus = 'FAILED';
      }
    }
    addEntry(store, booking, 'PLATFORM_SUBSIDY', s.subsidy, { status: subsidyStatus, destination });
  }
  if (s.platformShare > 0) addEntry(store, booking, 'PLATFORM_FEE', s.platformShare);
  Object.assign(booking, { ownerShare: s.ownerShare, platformShare: s.platformShare, settlement: 'SPLIT_ONLINE' });
}

// Owner collected the full amount at the venue, so they owe the platform its
// share (or, if a coupon exceeded the fee, the platform owes them).
function settleVenueCollection(store, booking) {
  const s = split(booking);
  addEntry(store, booking, 'VENUE_COLLECTION', booking.total);
  addEntry(store, booking, 'FEE_DUE', s.platformShare);
  Object.assign(booking, { ownerShare: s.ownerShare, platformShare: s.platformShare, settlement: 'COLLECTED_AT_VENUE' });
}

// A paid online booking was cancelled: the customer is refunded, so pull the
// owner's share back and drop the platform's.
function reverseOnlinePayment(store, booking) {
  const s = split(booking);
  addEntry(store, booking, 'OWNER_PAYOUT', -s.ownerFromPayment, { reversal: true });
  if (s.subsidy) addEntry(store, booking, 'PLATFORM_SUBSIDY', -s.subsidy, { reversal: true });
  if (s.platformShare > 0) addEntry(store, booking, 'PLATFORM_FEE', -s.platformShare, { reversal: true });
}

const sum = (entries, type) => entries.filter((e) => e.type === type && e.status !== 'FAILED').reduce((t, e) => t + e.amount, 0);

// Everything an owner needs to reconcile with the platform.
function ownerSummary(store, phone) {
  const entries = store.data.ledger.filter((e) => e.ownerPhone === phone);
  const feeDue = sum(entries, 'FEE_DUE') - sum(entries, 'DUES_SETTLED');
  return {
    paidToAccount: sum(entries, 'OWNER_PAYOUT') + sum(entries, 'PLATFORM_SUBSIDY'),
    collectedAtVenue: sum(entries, 'VENUE_COLLECTION'),
    platformFeesDue: feeDue, // negative = platform owes the owner
    entries: entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  };
}

function platformSummary(store) {
  const all = store.data.ledger;
  return {
    feesCollectedOnline: sum(all, 'PLATFORM_FEE'),
    subsidiesPaid: sum(all, 'PLATFORM_SUBSIDY'),
    paidToOwners: sum(all, 'OWNER_PAYOUT'),
    feesDueFromVenues: sum(all, 'FEE_DUE') - sum(all, 'DUES_SETTLED'),
    duesReceived: sum(all, 'DUES_SETTLED'),
  };
}

module.exports = {
  split,
  ownerOf,
  canTakeOnline,
  orderTransfers,
  settleOnlinePayment,
  settleVenueCollection,
  reverseOnlinePayment,
  ownerSummary,
  platformSummary,
  addEntry,
};
