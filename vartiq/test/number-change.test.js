'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../server/store');

test('number change: older chats are sealed until each one is continued', () => {
  const store = new Store({ file: null });
  store.register('alice', 'pass');
  store.register('bob', 'pass');
  store.register('carol', 'pass');
  store.setContact('alice', 'sms', '+919800000001');

  const dm = store.getOrCreateDirect('alice', 'bob');
  const group = store.createGroup('alice', 'Team', ['bob', 'carol']);
  store.addMessage(dm.id, 'bob', 'before the change');
  store.addMessage(group.id, 'alice', 'group before the change');
  const before = Date.now();

  assert.strictEqual(store.numberChangedAt('alice'), null, 'no change yet');
  assert.strictEqual(store.sealedBefore('alice', dm.id), null);

  // A new number seals the earlier chats; the first number being added does not.
  store.setContact('alice', 'sms', '+919800000002');
  assert.ok(store.numberChangedAt('alice') >= before);
  assert.ok(store.sealedBefore('alice', dm.id) >= before);
  assert.ok(store.sealedBefore('alice', group.id) >= before);
  assert.strictEqual(store.sealedBefore('bob', dm.id), null, 'other people are not affected');

  // Continuing one chat unseals only that chat.
  store.continueChat('alice', dm.id);
  assert.strictEqual(store.sealedBefore('alice', dm.id), null);
  assert.ok(store.sealedBefore('alice', group.id) >= before, 'the other chat stays sealed');

  // Changing the number again seals a continued chat once more.
  store.setContact('alice', 'sms', '+919800000003');
  assert.ok(store.sealedBefore('alice', dm.id) >= store.numberChangedAt('alice') - 1);
});

test('number change: adding the first number or the same number seals nothing', () => {
  const store = new Store({ file: null });
  store.register('dana', 'pass');
  store.setContact('dana', 'sms', '+919800000010');
  assert.strictEqual(store.numberChangedAt('dana'), null, 'adding the first number is not a change');
  store.setContact('dana', 'sms', '+919800000010');
  assert.strictEqual(store.numberChangedAt('dana'), null, 'the same number is not a change');
  store.setContact('dana', 'email', 'dana@example.com');
  assert.strictEqual(store.numberChangedAt('dana'), null, 'email changes do not seal chats');
});
