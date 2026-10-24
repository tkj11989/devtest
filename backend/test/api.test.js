const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');
const otp = require('../src/services/otp');
const { todayLocal, addDays } = require('../src/services/time');

let server, base, store, smsLog;

// Capture outgoing SMS from the console provider.
const origLog = console.log;
console.log = (...args) => {
  const line = args.join(' ');
  if (line.startsWith('[SMS')) smsLog.push(line);
  else origLog(...args);
};

beforeEach(async () => {
  if (server) server.close();
  otp.reset();
  smsLog = [];
  store = createStore();
  server = createApp(store).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function login(phone = '9876543210', name) {
  const sent = await call('POST', '/auth/send-otp', { phone });
  assert.equal(sent.status, 200);
  const verified = await call('POST', '/auth/verify-otp', { phone, otp: sent.body.devOtp });
  assert.equal(verified.status, 200);
  if (name) await call('PATCH', '/me', { name }, verified.body.token);
  return verified.body.token;
}

const tomorrow = () => addDays(todayLocal(), 1);

test('OTP login: validates phone, rejects wrong code, accepts right one', async () => {
  assert.equal((await call('POST', '/auth/send-otp', { phone: '12345' })).body.error, 'INVALID_PHONE');

  const sent = await call('POST', '/auth/send-otp', { phone: '+91 98765 43210' });
  assert.equal(sent.body.phone, '9876543210');
  assert.match(sent.body.devOtp, /^\d{6}$/);
  assert.match(smsLog[0], /\+919876543210.*is your Sports Space login OTP/);

  const again = await call('POST', '/auth/send-otp', { phone: '9876543210' });
  assert.equal(again.status, 429);

  const wrong = sent.body.devOtp === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/auth/verify-otp', { phone: '9876543210', otp: wrong })).body.error, 'OTP_INVALID');

  const ok = await call('POST', '/auth/verify-otp', { phone: '9876543210', otp: sent.body.devOtp });
  assert.ok(ok.body.token);
  // OTP is single-use
  assert.equal((await call('POST', '/auth/verify-otp', { phone: '9876543210', otp: sent.body.devOtp })).body.error, 'OTP_NOT_REQUESTED');
});

const PLAYON = 'playon-cricket-arena';
const book = (token, body) =>
  call('POST', '/bookings', { groundId: PLAYON, date: tomorrow(), paymentMethod: 'OFFLINE', ...body }, token);
const OWNER = '9000000001';

test('catalog: cities, sports, grounds with filters and slots', async () => {
  assert.ok((await call('GET', '/cities')).body.some((c) => c.id === 'jaipur'));
  const sports = await call('GET', '/sports?city=jaipur');
  assert.equal(sports.body.find((s) => s.id === 'cricket').groundCount, 5);

  const cricket = await call('GET', '/grounds?city=jaipur&sport=cricket');
  assert.equal(cricket.body.length, 5);
  assert.equal(cricket.body[0].id, PLAYON); // highest rated first
  assert.equal(cricket.body[0].pricePerHour, 1500);
  assert.equal(cricket.body[0].cityName, 'Jaipur');
  assert.equal(cricket.body[0].slots, undefined);
  assert.equal(cricket.body[0].ownerPhone, undefined);

  const indoor = await call('GET', '/grounds?city=jaipur&sport=cricket&type=Indoor');
  assert.deepEqual(indoor.body.map((g) => g.type), ['Indoor']);
  const lit = await call('GET', '/grounds?city=jaipur&sport=cricket&floodlights=1');
  assert.equal(lit.body.length, 4);
  const search = await call('GET', '/grounds?q=vaishali');
  assert.ok(search.body.every((g) => g.area === 'Vaishali Nagar'));

  const near = await call('GET', '/grounds?city=jaipur&sport=cricket&sort=distance&lat=26.85&lng=75.76');
  assert.equal(near.body[0].id, PLAYON);
  assert.ok(near.body[0].distanceKm < 1);

  const details = await call('GET', `/grounds/${PLAYON}`);
  assert.equal(details.body.reviews.length, 3);
  assert.equal(details.body.sport.name, 'Cricket');

  const slots = await call('GET', `/grounds/${PLAYON}/slots?date=${tomorrow()}`);
  assert.equal(slots.body.slots.length, 17);
  assert.equal(slots.body.slots[13].label, '7:00 PM - 8:00 PM');
  assert.equal((await call('GET', `/grounds/${PLAYON}/slots?date=2020-01-01`)).body.error, 'DATE_OUT_OF_RANGE');
});

test('profile name and favorites', async () => {
  const token = await login('9876543210', 'Rahul Mehta');
  const me = await call('GET', '/me', null, token);
  assert.equal(me.body.name, 'Rahul Mehta');
  assert.equal(me.body.isOwner, false);

  await call('PUT', `/me/favorites/${PLAYON}`, { favorite: true }, token);
  const favs = await call('GET', '/grounds?favorites=1', null, token);
  assert.deepEqual(favs.body.map((g) => g.id), [PLAYON]);
  assert.equal(favs.body[0].isFavorite, true);
  await call('PUT', `/me/favorites/${PLAYON}`, { favorite: false }, token);
  assert.equal((await call('GET', '/grounds?favorites=1', null, token)).body.length, 0);
  assert.equal((await call('GET', '/grounds?favorites=1')).status, 401);
});

test('quote adds platform fee and applies coupons', async () => {
  const token = await login();
  const q = await call('POST', '/bookings/quote', { groundId: PLAYON, date: tomorrow(), startHour: 19 }, token);
  assert.deepEqual(q.body, { amount: 1500, platformFee: 50, discount: 0, couponCode: null, total: 1550 });

  const flat = await call('POST', '/bookings/quote', { groundId: PLAYON, date: tomorrow(), startHour: 19, couponCode: 'first100' }, token);
  assert.equal(flat.body.total, 1450);
  const pct = await call('POST', '/bookings/quote', { groundId: PLAYON, date: tomorrow(), startHour: 19, couponCode: 'PLAY10' }, token);
  assert.equal(pct.body.discount, 150);
  const bad = await call('POST', '/bookings/quote', { groundId: PLAYON, date: tomorrow(), startHour: 19, couponCode: 'NOPE' }, token);
  assert.equal(bad.body.error, 'INVALID_COUPON');
});

test('offline booking confirms immediately, notifies and blocks the slot', async () => {
  const token = await login('9876543210', 'Rahul Mehta');
  const res = await book(token, { startHour: 19 });
  assert.equal(res.status, 201);
  const b = res.body.booking;
  assert.equal(b.status, 'CONFIRMED');
  assert.equal(b.paymentStatus, 'PAY_AT_VENUE');
  assert.equal(b.total, 1550);
  assert.equal(b.customerName, 'Rahul Mehta');
  assert.match(b.code, new RegExp(`^CG${tomorrow().replace(/-/g, '')}[0-9A-F]{4}$`));
  assert.equal(b.smsStatus, 'SENT');
  assert.match(smsLog.at(-1), /Booking confirmed!.*PlayOn Cricket Arena.*Pay Rs\.1550 at venue/);

  const notes = await call('GET', '/notifications', null, token);
  assert.equal(notes.body[0].title, 'Booking confirmed');

  const slots = await call('GET', `/grounds/${PLAYON}/slots?date=${tomorrow()}`);
  assert.equal(slots.body.slots.find((s) => s.startHour === 19).status, 'BOOKED');

  const other = await login('9123456789');
  assert.equal((await book(other, { startHour: 19 })).status, 409);
  assert.equal((await call('GET', '/bookings', null, token)).body.length, 1);
  assert.equal((await call('GET', '/bookings', null, other)).body.length, 0);
});

test('online booking holds the slot, confirms after verified payment', async () => {
  const token = await login();
  assert.equal((await book(token, { startHour: 7, paymentMethod: 'ONLINE' })).body.error, 'INVALID_PAYMENT_METHOD');
  const created = await book(token, { startHour: 7, paymentMethod: 'ONLINE', paymentChannel: 'UPI', couponCode: 'FIRST100' });
  assert.equal(created.body.booking.status, 'PENDING_PAYMENT');
  assert.equal(created.body.order.amount, 1450);
  // Pending bookings don't show in My Bookings
  assert.equal((await call('GET', '/bookings', null, token)).body.length, 0);

  const held = await call('GET', `/grounds/${PLAYON}/slots?date=${tomorrow()}`);
  assert.equal(held.body.slots.find((s) => s.startHour === 7).status, 'BOOKED');

  const id = created.body.booking.id;
  assert.equal((await call('POST', `/bookings/${id}/pay`, { paymentId: 'pay_x', signature: 'forged' }, token)).body.error, 'PAYMENT_VERIFICATION_FAILED');
  const checkout = await call('POST', '/payments/mock-checkout', { orderId: created.body.order.orderId }, token);
  const paid = await call('POST', `/bookings/${id}/pay`, checkout.body, token);
  assert.equal(paid.body.booking.status, 'CONFIRMED');
  assert.equal(paid.body.booking.paymentStatus, 'PAID');
  assert.match(smsLog.at(-1), /Paid Rs\.1450 online/);
});

test('expired payment hold releases the slot', async () => {
  const token = await login();
  const created = await book(token, { startHour: 8, paymentMethod: 'ONLINE', paymentChannel: 'CARD' });
  store.data.bookings[0].createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const slots = await call('GET', `/grounds/${PLAYON}/slots?date=${tomorrow()}`);
  assert.equal(slots.body.slots.find((s) => s.startHour === 8).status, 'AVAILABLE');
  const checkout = await call('POST', '/payments/mock-checkout', { orderId: created.body.order.orderId }, token);
  assert.equal((await call('POST', `/bookings/${created.body.booking.id}/pay`, checkout.body, token)).status, 410);
});

test('cancel frees the slot and notifies', async () => {
  const token = await login();
  const { body } = await book(token, { startHour: 9 });
  const cancelled = await call('POST', `/bookings/${body.booking.id}/cancel`, {}, token);
  assert.equal(cancelled.body.booking.status, 'CANCELLED');
  assert.match(smsLog.at(-1), /has been cancelled/);
  const slots = await call('GET', `/grounds/${PLAYON}/slots?date=${tomorrow()}`);
  assert.equal(slots.body.slots.find((s) => s.startHour === 9).status, 'AVAILABLE');
});

test('owner: dashboard, slot toggles, add/edit/delete slots, collect payment', async () => {
  const player = await login('9876543210', 'Amit Sharma');
  const owner = await login(OWNER);
  assert.equal((await call('GET', '/me', null, owner)).body.isOwner, true);
  assert.equal((await call('GET', '/owner/grounds', null, player)).body.length, 0);
  assert.equal((await call('GET', `/owner/grounds/${PLAYON}/slots?date=${tomorrow()}`, null, player)).status, 404);

  const { body } = await book(player, { startHour: 20 });
  const dash = await call('GET', `/owner/dashboard?groundId=${PLAYON}`, null, owner);
  assert.equal(dash.body.totalBookings, 1);
  assert.equal(dash.body.totalRevenue, 1500);
  assert.equal(dash.body.upcoming, 1);
  assert.equal(dash.body.pendingPayments, 1);

  const collected = await call('POST', `/owner/bookings/${body.booking.id}/collect`, {}, owner);
  assert.equal(collected.body.booking.paymentStatus, 'PAID');

  // Turn off 6 AM tomorrow: hidden from players, shown as disabled to owner
  await call('PUT', `/owner/grounds/${PLAYON}/slots/6/availability`, { date: tomorrow(), enabled: false }, owner);
  const pub = await call('GET', `/grounds/${PLAYON}/slots?date=${tomorrow()}`);
  assert.ok(!pub.body.slots.some((s) => s.startHour === 6));
  const own = await call('GET', `/owner/grounds/${PLAYON}/slots?date=${tomorrow()}`, null, owner);
  assert.equal(own.body.slots.find((s) => s.startHour === 6).enabled, false);
  assert.equal(own.body.slots.find((s) => s.startHour === 20).bookedBy, 'Amit Sharma');
  assert.equal((await book(player, { startHour: 6 })).status, 409);

  await call('PATCH', `/owner/grounds/${PLAYON}/slots/18`, { price: 1800 }, owner);
  assert.equal((await call('POST', `/owner/grounds/${PLAYON}/slots`, { startHour: 5, price: 1000 }, owner)).status, 201);
  assert.equal((await call('POST', `/owner/grounds/${PLAYON}/slots`, { startHour: 5, price: 1000 }, owner)).status, 409);
  const after = (await call('GET', `/grounds/${PLAYON}/slots?date=${tomorrow()}`)).body.slots;
  assert.equal(after[0].startHour, 5);
  assert.equal(after.find((s) => s.startHour === 18).price, 1800);

  assert.equal((await call('DELETE', `/owner/grounds/${PLAYON}/slots/20`, null, owner)).body.error, 'SLOT_HAS_BOOKINGS');
  assert.equal((await call('DELETE', `/owner/grounds/${PLAYON}/slots/5`, null, owner)).status, 200);
});

const ADMIN = '9000000000';
const config = require('../src/config');

test('owner payout details: validation, masking, and online gating', async () => {
  const owner = await login(OWNER);
  const player = await login('9876543210', 'Rahul Mehta');
  assert.equal((await call('PUT', '/owner/payout', { method: 'UPI', upiId: 'x@y', accountHolder: 'A', contactPhone: '9876543210' }, player)).status, 403);

  const seeded = await call('GET', '/owner/payout', null, owner);
  assert.equal(seeded.body.upiId, 'playonsports@okaxis');
  assert.equal(seeded.body.status, 'ACTIVE');

  const bad = await call('PUT', '/owner/payout', { method: 'BANK', accountHolder: 'PlayOn', accountNumber: '12', ifsc: 'HDFC0001234', contactPhone: '9000000001' }, owner);
  assert.equal(bad.body.error, 'INVALID_PAYOUT');
  const badIfsc = await call('PUT', '/owner/payout', { method: 'BANK', accountHolder: 'PlayOn', accountNumber: '50100123456789', ifsc: 'HDFC1234', contactPhone: '9000000001' }, owner);
  assert.match(badIfsc.body.message, /IFSC/);

  const bank = await call('PUT', '/owner/payout', { method: 'BANK', accountHolder: 'PlayOn Sports', accountNumber: '5010 0123 456789', ifsc: 'hdfc0001234', contactPhone: '+91 98290 12345' }, owner);
  assert.equal(bank.status, 200);
  assert.equal(bank.body.accountNumber, undefined);
  assert.equal(bank.body.accountNumberMasked, 'XXXX6789');
  assert.equal(bank.body.ifsc, 'HDFC0001234');
  assert.equal(bank.body.contactPhone, '9829012345');
  // Saving again without re-entering the account number keeps it.
  const again = await call('PUT', '/owner/payout', { method: 'BANK', accountHolder: 'PlayOn Sports', ifsc: 'HDFC0001234', contactPhone: '9829012345' }, owner);
  assert.equal(again.body.accountNumberMasked, 'XXXX6789');

  // No payout details -> online payments are refused, pay at venue still works.
  store.data.users.find((u) => u.phone === OWNER).payout = undefined;
  assert.equal((await call('GET', `/grounds/${PLAYON}`)).body.onlinePayments, false);
  assert.equal((await book(player, { startHour: 10, paymentMethod: 'ONLINE', paymentChannel: 'UPI' })).body.error, 'ONLINE_PAYMENT_UNAVAILABLE');
  assert.equal((await book(player, { startHour: 10 })).status, 201);
});

test('razorpay mode needs the admin to link the owner account', async () => {
  const admin = await login(ADMIN, 'Platform Admin');
  const owner = await login(OWNER);
  assert.equal((await call('GET', '/me', null, admin)).body.isAdmin, true);
  assert.equal((await call('GET', '/admin/summary', null, owner)).status, 403);

  config.paymentProvider = 'razorpay';
  try {
    assert.equal((await call('GET', '/owner/payout', null, owner)).body.status, 'PENDING_LINK');
    assert.equal((await call('GET', `/grounds/${PLAYON}`)).body.onlinePayments, false);
    assert.equal((await call('PUT', `/admin/owners/${OWNER}/linked-account`, { linkedAccountId: 'nope' }, admin)).body.error, 'INVALID_LINKED_ACCOUNT');
    const linked = await call('PUT', `/admin/owners/${OWNER}/linked-account`, { linkedAccountId: 'acc_AbCdEfGhIjKlMn' }, admin);
    assert.equal(linked.body.status, 'ACTIVE');
    assert.equal((await call('GET', `/grounds/${PLAYON}`)).body.onlinePayments, true);

    // Changing the destination clears the link.
    await call('PUT', '/owner/payout', { method: 'UPI', upiId: 'new@okhdfcbank', accountHolder: 'PlayOn', contactPhone: '9000000001' }, owner);
    assert.equal((await call('GET', '/owner/payout', null, owner)).body.status, 'PENDING_LINK');
  } finally {
    config.paymentProvider = 'mock';
  }
});

test('online payment splits: owner gets the slot price, platform keeps the fee', async () => {
  const player = await login('9876543210', 'Rahul Mehta');
  const owner = await login(OWNER);
  const admin = await login(ADMIN, 'Platform Admin');
  const pay = async (body) => {
    const created = await book(player, { paymentMethod: 'ONLINE', paymentChannel: 'UPI', ...body });
    const checkout = await call('POST', '/payments/mock-checkout', { orderId: created.body.order.orderId }, player);
    return (await call('POST', `/bookings/${created.body.booking.id}/pay`, checkout.body, player)).body.booking;
  };

  const plain = await pay({ startHour: 18 }); // 1500 + 50
  assert.equal(plain.ownerShare, 1500);
  assert.equal(plain.platformShare, 50);
  // PLAY10 = 150 off, more than the 50 fee: customer pays 1400, platform tops up 100.
  const promo = await pay({ startHour: 19, couponCode: 'PLAY10' });
  assert.equal(promo.total, 1400);
  assert.equal(promo.platformShare, -100);

  let earnings = (await call('GET', '/owner/earnings', null, owner)).body;
  assert.equal(earnings.paidToAccount, 3000); // full slot price both times
  assert.deepEqual(earnings.entries.filter((e) => e.bookingId === promo.id).map((e) => [e.type, e.amount]).sort(), [['OWNER_PAYOUT', 1400], ['PLATFORM_SUBSIDY', 100]]);
  assert.match(earnings.entries[0].destination, /playonsports@okaxis/);

  let summary = (await call('GET', '/admin/summary', null, admin)).body;
  assert.equal(summary.feesCollectedOnline, 50);
  assert.equal(summary.subsidiesPaid, 100);
  assert.equal(summary.paidToOwners, 2900);

  // Cancelling a paid booking reverses its split.
  await call('POST', `/bookings/${plain.id}/cancel`, {}, player);
  earnings = (await call('GET', '/owner/earnings', null, owner)).body;
  assert.equal(earnings.paidToAccount, 1500);
  summary = (await call('GET', '/admin/summary', null, admin)).body;
  assert.equal(summary.feesCollectedOnline, 0);

  // Pay at venue: owner collects everything and owes the platform its fee.
  const { body } = await book(player, { startHour: 20 });
  await call('POST', `/owner/bookings/${body.booking.id}/collect`, {}, owner);
  earnings = (await call('GET', '/owner/earnings', null, owner)).body;
  assert.equal(earnings.collectedAtVenue, 1550);
  assert.equal(earnings.platformFeesDue, 50);

  assert.equal((await call('POST', `/admin/owners/${OWNER}/dues-received`, { amount: 60 }, admin)).body.error, 'INVALID_AMOUNT');
  const settled = await call('POST', `/admin/owners/${OWNER}/dues-received`, { amount: 50 }, admin);
  assert.equal(settled.body.platformFeesDue, 0);
  summary = (await call('GET', '/admin/summary', null, admin)).body;
  assert.equal(summary.duesReceived, 50);
  assert.equal(summary.owners[0].phone, OWNER);
});

test('booking endpoints require login', async () => {
  assert.equal((await call('GET', '/bookings')).status, 401);
  assert.equal((await call('GET', '/bookings', null, 'garbage')).status, 401);
  assert.equal((await call('GET', '/me')).status, 401);
});
