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
  store.data.bookings = [];
  store.data.users = [];
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

async function login(phone = '9876543210') {
  const sent = await call('POST', '/auth/send-otp', { phone });
  assert.equal(sent.status, 200);
  const verified = await call('POST', '/auth/verify-otp', { phone, otp: sent.body.devOtp });
  assert.equal(verified.status, 200);
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

test('catalog: sports, spaces and slots', async () => {
  const sports = await call('GET', '/sports');
  assert.ok(sports.body.find((s) => s.id === 'cricket' && s.spaceCount === 2));

  const spaces = await call('GET', '/sports/cricket/spaces');
  assert.ok(spaces.body.every((s) => s.sportId === 'cricket'));

  const slots = await call('GET', `/spaces/cr-1/slots?date=${tomorrow()}`);
  assert.equal(slots.body.slots.length, 23 - 6);
  assert.ok(slots.body.slots.every((s) => s.status === 'AVAILABLE'));

  assert.equal((await call('GET', '/spaces/cr-1/slots?date=2020-01-01')).body.error, 'DATE_OUT_OF_RANGE');
  assert.equal((await call('GET', '/spaces/cr-1/slots?date=nope')).body.error, 'INVALID_DATE');
});

test('offline booking confirms immediately, sends SMS and blocks the slot', async () => {
  const token = await login();
  const res = await call('POST', '/bookings', { spaceId: 'cr-1', date: tomorrow(), startHour: 18, paymentMethod: 'OFFLINE' }, token);
  assert.equal(res.status, 201);
  assert.equal(res.body.booking.status, 'CONFIRMED');
  assert.equal(res.body.booking.paymentStatus, 'PAY_AT_VENUE');
  assert.equal(res.body.booking.smsStatus, 'SENT');
  assert.match(smsLog.at(-1), /Booking confirmed!.*Pay Rs\.1200 at venue/);

  const slots = await call('GET', `/spaces/cr-1/slots?date=${tomorrow()}`);
  assert.equal(slots.body.slots.find((s) => s.startHour === 18).status, 'BOOKED');

  const other = await login('9123456789');
  const clash = await call('POST', '/bookings', { spaceId: 'cr-1', date: tomorrow(), startHour: 18, paymentMethod: 'OFFLINE' }, other);
  assert.equal(clash.status, 409);

  const mine = await call('GET', '/bookings', null, token);
  assert.equal(mine.body.length, 1);
  assert.equal((await call('GET', '/bookings', null, other)).body.length, 0);
});

test('online booking holds the slot, confirms after verified payment', async () => {
  const token = await login();
  const created = await call('POST', '/bookings', { spaceId: 'bd-1', date: tomorrow(), startHour: 7, paymentMethod: 'ONLINE' }, token);
  assert.equal(created.body.booking.status, 'PENDING_PAYMENT');
  const { orderId } = created.body.order;
  assert.equal(smsLog.length, 1); // only the OTP so far

  const held = await call('GET', `/spaces/bd-1/slots?date=${tomorrow()}`);
  assert.equal(held.body.slots.find((s) => s.startHour === 7).status, 'BOOKED');

  const bad = await call('POST', `/bookings/${created.body.booking.id}/pay`, { paymentId: 'pay_x', signature: 'forged' }, token);
  assert.equal(bad.body.error, 'PAYMENT_VERIFICATION_FAILED');

  const checkout = await call('POST', '/payments/mock-checkout', { orderId }, token);
  const paid = await call('POST', `/bookings/${created.body.booking.id}/pay`, checkout.body, token);
  assert.equal(paid.body.booking.status, 'CONFIRMED');
  assert.equal(paid.body.booking.paymentStatus, 'PAID');
  assert.match(smsLog.at(-1), /Booking confirmed!.*Paid online Rs\.400/);
});

test('expired payment hold releases the slot', async () => {
  const token = await login();
  const created = await call('POST', '/bookings', { spaceId: 'bd-1', date: tomorrow(), startHour: 8, paymentMethod: 'ONLINE' }, token);
  store.data.bookings[0].createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const slots = await call('GET', `/spaces/bd-1/slots?date=${tomorrow()}`);
  assert.equal(slots.body.slots.find((s) => s.startHour === 8).status, 'AVAILABLE');

  const checkout = await call('POST', '/payments/mock-checkout', { orderId: created.body.order.orderId }, token);
  const paid = await call('POST', `/bookings/${created.body.booking.id}/pay`, checkout.body, token);
  assert.equal(paid.status, 410);
});

test('cancel frees the slot and notifies', async () => {
  const token = await login();
  const { body } = await call('POST', '/bookings', { spaceId: 'tn-1', date: tomorrow(), startHour: 9, paymentMethod: 'OFFLINE' }, token);
  const cancelled = await call('POST', `/bookings/${body.booking.id}/cancel`, {}, token);
  assert.equal(cancelled.body.booking.status, 'CANCELLED');
  assert.match(smsLog.at(-1), /has been cancelled/);
  const slots = await call('GET', `/spaces/tn-1/slots?date=${tomorrow()}`);
  assert.equal(slots.body.slots.find((s) => s.startHour === 9).status, 'AVAILABLE');
});

test('booking endpoints require login', async () => {
  assert.equal((await call('GET', '/bookings')).status, 401);
  assert.equal((await call('GET', '/bookings', null, 'garbage')).status, 401);
});
