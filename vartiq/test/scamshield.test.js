'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/scamshield');

const level = (t, ctx) => S.assess(t, ctx).level;

test('scam shield: the common tricks are caught', () => {
  const danger = [
    'Dear customer your SBI account will be blocked today. Update KYC now at http://sbi-kyc-update.xyz/login',
    'Please share the OTP you received so we can verify your account',
    'Sir apna OTP bhejo warna account block ho jayega',
    'Install AnyDesk and tell me the 9 digit code, I will fix your refund',
    'To receive the refund scan this QR and enter your UPI PIN',
    'This is CBI. A parcel in your name has narcotics. You will face arrest, stay on video call (digital arrest).',
    'Download your KYC app here https://files.example.in/kyc.apk',
    'Pay now: https://hdfcbank-secure.top/netbanking',
    'Click http://192.168.4.5/login to claim cashback',
  ];
  for (const t of danger) assert.strictEqual(level(t), 'danger', t);
  const warn = [
    'Congratulations you won the lucky draw of Rs 25 lakh',
    'Work from home and earn Rs 5000 per day, just like and subscribe tasks',
    'Guaranteed returns of 40% every week, invest in crypto today',
  ];
  for (const t of warn) assert.ok(['warn', 'danger'].includes(level(t)), t);
});

test('scam shield: ordinary messages and real links are left alone', () => {
  const fine = [
    'Hi, are we meeting at 6 for dinner?',
    'Your OTP is a secret, never share it with anyone, even the bank.', // advice, no request
    'I paid the electricity bill yesterday, can you check the receipt?',
    'Here is the SBI website: https://www.onlinesbi.sbi/ please use only this',
    'Booking confirmed on https://www.irctc.co.in/nget/train-search for Friday',
    'Mail me at ravi@sbi.co.in',
    'Let me know when you have transferred the money for the tickets',
    'We won the cricket match!!',
    'Amazon delivery by 8pm today: https://www.amazon.in/gp/your-account/order-history',
  ];
  for (const t of fine) assert.strictEqual(level(t), 'none', t);
});

test('scam shield: why it warns, and a stranger writing first counts for more', () => {
  const r = S.assess('Your account will be blocked tonight, update KYC at http://sbi-kyc.xyz');
  assert.strictEqual(r.level, 'danger');
  assert.ok(r.reasons.length >= 1 && r.reasons.length <= 3);
  assert.ok(r.reasons.some((x) => /SBI/.test(x)));
  assert.deepStrictEqual(r.links, ['http://sbi-kyc.xyz/']);
  const mild = 'Congratulations, you won a free gift';
  assert.strictEqual(level(mild), 'warn');
  assert.strictEqual(level('lucky draw winner', { firstContact: false }), 'warn');
  assert.strictEqual(level('You won the lucky draw', { firstContact: true }), 'danger');
  assert.strictEqual(S.assess('').level, 'none');
});

test('scam shield: look-alike links', () => {
  for (const bad of ['http://paytm-kyc.in/x', 'https://sbibank.top', 'http://xn--hdfcbnk-9ya.com', 'http://amazon-refund.click/a']) {
    assert.ok(S.linksIn(bad).flatMap(S.judgeLink).length > 0, bad);
  }
  for (const good of ['https://www.paytm.com/', 'https://netbanking.hdfcbank.com/', 'https://sbi.co.in', 'https://example.com/page']) {
    assert.strictEqual(S.linksIn(good).flatMap(S.judgeLink).length, 0, good);
  }
});

test('scam shield: warns before you send a code, a PIN or a card number', () => {
  assert.ok(S.assessOutgoing('my otp is 482913'));
  assert.ok(S.assessOutgoing('cvv 123'));
  assert.ok(S.assessOutgoing('card 4111 1111 1111 1111'));
  assert.ok(S.assessOutgoing('aadhaar 1234 5678 9012'));
  assert.strictEqual(S.assessOutgoing('see you at 6:30, room 4021'), null);
  assert.strictEqual(S.assessOutgoing('call me on 9876543210'), null);
});
