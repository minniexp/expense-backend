/**
 * Tests for spending against a rolling monthly budget.
 *
 * The number that carries risk is `accumulated`. It is the only one that spans months, so a mistake
 * in it does not look wrong on any single screen — it just quietly reports the wrong amount of
 * money as available, for the rest of the year.
 */

const test = require('node:test');
const assert = require('node:assert');

const { UNCATEGORISED, budgetCategoryOf, spendOf, summariseBudgets } = require('../services/budgetSummary');

const spend = (month, amount, tags, over = {}) => ({
  year: 2026, month, date: `2026-${String(month).padStart(2, '0')}-15`,
  amount, transactionType: 'expense', purchaseCategory: tags, ...over,
});

const find = (result, name) => result.categories.find((c) => c.purchaseCategory === name);

// ---------------------------------------------------------------------------
// the worked example
// ---------------------------------------------------------------------------

test('THE WORKED EXAMPLE: travel in March, $300/month, $609.37 spent in January', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 609.37, ['travel'])],
    budgets: { travel: 300 },
    year: 2026,
    month: 3,
  });

  const travel = find(result, 'travel');
  assert.strictEqual(travel.current, 0, 'nothing spent in March');
  assert.strictEqual(travel.budgeted, 300, 'the monthly allowance');
  assert.strictEqual(travel.accumulated, 290.63, '3 x 300 - 609.37');
});

test('an underspent month carries its remainder forward', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 100, ['travel'])],
    budgets: { travel: 300 },
    year: 2026, month: 2,
  });
  assert.strictEqual(find(result, 'travel').accumulated, 500, '600 accrued, 100 spent');
});

test('an overspent month goes negative rather than resetting to zero', () => {
  // Clamping at zero would make the next month look funded when it is not.
  const result = summariseBudgets({
    transactions: [spend(1, 1000, ['travel'])],
    budgets: { travel: 300 },
    year: 2026, month: 2,
  });
  assert.strictEqual(find(result, 'travel').accumulated, -400);
});

test('the current month counts toward accumulated as well as toward current', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 100, ['travel']), spend(3, 50, ['travel'])],
    budgets: { travel: 300 },
    year: 2026, month: 3,
  });
  const travel = find(result, 'travel');
  assert.strictEqual(travel.current, 50);
  assert.strictEqual(travel.accumulated, 750, '900 - 150');
});

// ---------------------------------------------------------------------------
// what counts as spending
// ---------------------------------------------------------------------------

test('income is not spending, whichever way its sign runs', () => {
  const result = summariseBudgets({
    transactions: [
      { ...spend(3, 500, ['travel']), transactionType: 'income' },
      spend(3, 40, ['travel']),
    ],
    budgets: { travel: 300 }, year: 2026, month: 3,
  });
  assert.strictEqual(find(result, 'travel').current, 40);
});

test('a negative stored amount is still spending of that magnitude', () => {
  // On the checking account an expense is stored negative; the magnitude is what was spent.
  assert.strictEqual(spendOf({ transactionType: 'expense', amount: -37.57 }), 37.57);
  assert.strictEqual(spendOf({ transactionType: 'expense', amount: 37.57 }), 37.57);
});

test('later months and other years are excluded', () => {
  const result = summariseBudgets({
    transactions: [
      spend(1, 100, ['travel']),
      spend(6, 999, ['travel']),                       // after the month asked about
      { ...spend(1, 888, ['travel']), year: 2025 },    // a different year
    ],
    budgets: { travel: 300 }, year: 2026, month: 3,
  });
  assert.strictEqual(find(result, 'travel').accumulated, 800, '900 - 100 only');
});

// ---------------------------------------------------------------------------
// which budget a purchase draws from
// ---------------------------------------------------------------------------

test('only the FIRST purchase category is charged, so nothing is counted twice', () => {
  // Counting a dining-and-travel purchase against both would report more spending than happened.
  const result = summariseBudgets({
    transactions: [spend(3, 90, ['dining', 'travel'])],
    budgets: { dining: 100, travel: 300 }, year: 2026, month: 3,
  });
  assert.strictEqual(find(result, 'dining').current, 90);
  assert.strictEqual(find(result, 'travel').current, 0);
  assert.strictEqual(result.totals.current, 90, 'the total equals what was spent');
});

test('spending with no purchase category lands in "etc."', () => {
  const result = summariseBudgets({
    transactions: [spend(3, 25, []), spend(3, 5, null), spend(3, 10, ['  '])],
    budgets: {}, year: 2026, month: 3,
  });
  assert.strictEqual(find(result, UNCATEGORISED).current, 40);
});

test('budgetCategoryOf never returns an empty name', () => {
  assert.strictEqual(budgetCategoryOf({ purchaseCategory: ['dining'] }), 'dining');
  assert.strictEqual(budgetCategoryOf({ purchaseCategory: [] }), UNCATEGORISED);
  assert.strictEqual(budgetCategoryOf({}), UNCATEGORISED);
  assert.strictEqual(budgetCategoryOf(null), UNCATEGORISED);
});

// ---------------------------------------------------------------------------
// the shape of the answer
// ---------------------------------------------------------------------------

test('a budgeted category with no spending still appears, showing its allowance', () => {
  const result = summariseBudgets({ transactions: [], budgets: { hotel: 250 }, year: 2026, month: 4 });
  const hotel = find(result, 'hotel');
  assert.strictEqual(hotel.current, 0);
  assert.strictEqual(hotel.budgeted, 250);
  assert.strictEqual(hotel.accumulated, 1000);
});

test('the "etc." placeholder is dropped when nothing is uncategorised', () => {
  const result = summariseBudgets({
    transactions: [spend(3, 10, ['dining'])], budgets: { dining: 50 }, year: 2026, month: 3,
  });
  assert.strictEqual(find(result, UNCATEGORISED), undefined);
});

test('categories come back ordered by what was spent this month', () => {
  const result = summariseBudgets({
    transactions: [spend(3, 10, ['dining']), spend(3, 90, ['travel']), spend(3, 50, ['fuel'])],
    budgets: {}, year: 2026, month: 3,
  });
  assert.deepStrictEqual(result.categories.map((c) => c.purchaseCategory), ['travel', 'fuel', 'dining']);
});

test('totals add up across categories', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 100, ['travel']), spend(3, 40, ['dining'])],
    budgets: { travel: 300, dining: 50 }, year: 2026, month: 3,
  });
  assert.strictEqual(result.totals.current, 40);
  assert.strictEqual(result.totals.budgeted, 350);
  assert.strictEqual(result.totals.yearToDate, 140);
  assert.strictEqual(result.totals.accumulated, 910, '(900-100) + (150-40)');
});

test('money is rounded to cents, not left with floating-point crumbs', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 0.1, ['travel']), spend(1, 0.2, ['travel'])],
    budgets: { travel: 1 }, year: 2026, month: 1,
  });
  assert.strictEqual(find(result, 'travel').current, 0.3);
  assert.strictEqual(find(result, 'travel').accumulated, 0.7);
});

test('an invalid period is rejected rather than quietly reporting zeroes', () => {
  for (const bad of [{}, { year: 2026 }, { year: 2026, month: 0 }, { year: 2026, month: 13 }]) {
    assert.throws(() => summariseBudgets({ transactions: [], budgets: {}, ...bad }), /Invalid period/);
  }
});

test('no transactions and no budgets is an empty answer, not a crash', () => {
  const result = summariseBudgets({ transactions: [], budgets: {}, year: 2026, month: 5 });
  assert.deepStrictEqual(result.categories, []);
  assert.strictEqual(result.totals.current, 0);
});
