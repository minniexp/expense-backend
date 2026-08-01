/**
 * Tests for detaching deleted transactions from the return that covered them.
 *
 * The arithmetic here mirrors createBulkTransactions in reverse, and it decides a number that says
 * what somebody owes. Getting it wrong is invisible — the return still looks like a return, it just
 * claims the wrong total, and nothing anywhere recomputes it.
 */

const test = require('node:test');
const assert = require('node:assert');

const { planReturnUnlink } = require('../services/returnUnlink');

const ret = (over = {}) => ({
  total: 300,
  returnedTransactionIds: ['a', 'b', 'c'],
  returnedTellerTransactionIds: ['manual_a', 'manual_b'],
  ...over,
});

const tx = (id, amount, type = 'expense', upstream) => ({
  _id: id, amount, transactionType: type, tellerTransactionId: upstream,
});

test('a deleted transaction is removed from both id lists', () => {
  const plan = planReturnUnlink(ret(), [tx('b', 50, 'expense', 'manual_b')]);
  assert.deepStrictEqual(plan.returnedTransactionIds, ['a', 'c']);
  assert.deepStrictEqual(plan.returnedTellerTransactionIds, ['manual_a']);
});

test('the total drops by exactly what the expense added', () => {
  const plan = planReturnUnlink(ret({ total: 300 }), [tx('b', 50)]);
  assert.strictEqual(plan.total, 250);
  assert.strictEqual(plan.removedFromTotal, 50);
});

test('ONLY expenses move the total, because only expenses ever added to it', () => {
  // createBulkTransactions adds nothing for an income row. Subtracting one here would move the
  // total by an amount that was never in it.
  const plan = planReturnUnlink(ret({ total: 300 }), [tx('a', 80, 'income', 'manual_a')]);
  assert.strictEqual(plan.total, 300, 'unchanged');
  assert.strictEqual(plan.removedFromTotal, 0);
  assert.deepStrictEqual(plan.returnedTransactionIds, ['b', 'c'], 'but it is still unlinked');
});

test('several deletions at once are summed', () => {
  const plan = planReturnUnlink(ret({ total: 300 }), [tx('a', 100), tx('b', 50), tx('c', 25)]);
  assert.strictEqual(plan.total, 125);
  assert.deepStrictEqual(plan.returnedTransactionIds, []);
});

test('a negative expense — a refund on a card — adds back rather than subtracting twice', () => {
  const plan = planReturnUnlink(ret({ total: 300 }), [tx('a', -45)]);
  assert.strictEqual(plan.total, 345, 'removing a -45 row raises the total by 45');
});

test('the total is rounded to cents, not left with floating-point crumbs', () => {
  // 100.10 - 20.20 is 79.89999999999999 in binary floating point. A total is money.
  const plan = planReturnUnlink(ret({ total: 100.1 }), [tx('a', 20.2)]);
  assert.strictEqual(plan.total, 79.9);
});

test('a transaction that was never linked leaves the return untouched', () => {
  const plan = planReturnUnlink(ret({ total: 300 }), [tx('zzz', 40)]);
  assert.deepStrictEqual(plan.returnedTransactionIds, ['a', 'b', 'c']);
  assert.strictEqual(plan.total, 260, 'the total still reflects the row that is going away');
});

test('a row with no upstream id does not disturb the upstream list', () => {
  const plan = planReturnUnlink(ret(), [tx('a', 10, 'expense', undefined)]);
  assert.deepStrictEqual(plan.returnedTellerTransactionIds, ['manual_a', 'manual_b']);
});

test('missing arrays and a missing total are treated as empty and zero', () => {
  const plan = planReturnUnlink({}, [tx('a', 10)]);
  assert.deepStrictEqual(plan.returnedTransactionIds, []);
  assert.deepStrictEqual(plan.returnedTellerTransactionIds, []);
  assert.strictEqual(plan.total, -10);
});

test('a non-numeric amount is skipped rather than turning the total into NaN', () => {
  // One bad row must not destroy a figure the rest of the return depends on.
  const plan = planReturnUnlink(ret({ total: 300 }), [tx('a', 'oops'), tx('b', 50)]);
  assert.strictEqual(plan.total, 250);
});

test('deleting nothing changes nothing', () => {
  const plan = planReturnUnlink(ret({ total: 300 }), []);
  assert.strictEqual(plan.total, 300);
  assert.deepStrictEqual(plan.returnedTransactionIds, ['a', 'b', 'c']);
});

test('ids are compared as strings, so ObjectId values match their string form', () => {
  const objectIdish = { toString: () => 'b' };
  const plan = planReturnUnlink(ret(), [{ _id: objectIdish, amount: 50, transactionType: 'expense' }]);
  assert.deepStrictEqual(plan.returnedTransactionIds, ['a', 'c']);
});
