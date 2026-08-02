/**
 * Tests for spending against a rolling monthly budget.
 *
 * The number that carries risk is `accumulated`. It is the only one that spans months, so a mistake
 * in it does not look wrong on any single screen — it just quietly reports the wrong amount of
 * money as available, for the rest of the year.
 */

const test = require('node:test');
const assert = require('node:assert');

const { UNCATEGORISED, BUDGET_GROUPS, EXCLUDED, budgetCategoryOf, spendOf, summariseBudgets } = require('../services/budgetSummary');

const spend = (month, amount, category, over = {}) => ({
  year: 2026, month, date: `2026-${String(month).padStart(2, '0')}-15`,
  amount, transactionType: 'expense', category, ...over,
});

const find = (result, name) => result.categories.find((c) => c.category === name);

// ---------------------------------------------------------------------------
// the worked example
// ---------------------------------------------------------------------------

test('THE WORKED EXAMPLE: travel in March, $300/month, $609.37 spent in January', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 609.37, 'travel')],
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
    transactions: [spend(1, 100, 'travel')],
    budgets: { travel: 300 },
    year: 2026, month: 2,
  });
  assert.strictEqual(find(result, 'travel').accumulated, 500, '600 accrued, 100 spent');
});

test('an overspent month goes negative rather than resetting to zero', () => {
  // Clamping at zero would make the next month look funded when it is not.
  const result = summariseBudgets({
    transactions: [spend(1, 1000, 'travel')],
    budgets: { travel: 300 },
    year: 2026, month: 2,
  });
  assert.strictEqual(find(result, 'travel').accumulated, -400);
});

test('the current month counts toward accumulated as well as toward current', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 100, 'travel'), spend(3, 50, 'travel')],
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
      { ...spend(3, 500, 'travel'), transactionType: 'income' },
      spend(3, 40, 'travel'),
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
      spend(1, 100, 'travel'),
      spend(6, 999, 'travel'),                       // after the month asked about
      { ...spend(1, 888, 'travel'), year: 2025 },    // a different year
    ],
    budgets: { travel: 300 }, year: 2026, month: 3,
  });
  assert.strictEqual(find(result, 'travel').accumulated, 800, '900 - 100 only');
});

// ---------------------------------------------------------------------------
// which budget a purchase draws from
// ---------------------------------------------------------------------------

test('a transaction is charged to its main category, not its purchase-category tags', () => {
  // purchaseCategory is an array of tags and can hold several; category is the one budget it draws
  // from, so a dining-tagged travel purchase still only counts once.
  const result = summariseBudgets({
    transactions: [spend(3, 90, 'travel', { purchaseCategory: ['dining', 'hotel'] })],
    budgets: { travel: 300, bill: 100 }, year: 2026, month: 3,
  });
  assert.strictEqual(find(result, 'travel').current, 90);
  assert.strictEqual(result.totals.current, 90, 'the total equals what was spent');
});

test('spending with no category is kept out of the budget view entirely', () => {
  // An allowance for "everything uncategorised" cannot be acted on; the fix is to categorise it.
  const result = summariseBudgets({
    transactions: [spend(3, 25, ''), spend(3, 5, null), spend(3, 10, '   ')],
    budgets: {}, year: 2026, month: 3,
  });
  assert.strictEqual(find(result, UNCATEGORISED), undefined);
  assert.strictEqual(result.totals.current, 0, 'and it does not inflate the total either');
});

test('budgetCategoryOf never returns an empty name', () => {
  assert.strictEqual(budgetCategoryOf({ category: 'fuel' }), 'fuel');
  assert.strictEqual(budgetCategoryOf({ category: '' }), UNCATEGORISED);
  assert.strictEqual(budgetCategoryOf({ category: '   ' }), UNCATEGORISED);
  assert.strictEqual(budgetCategoryOf({}), UNCATEGORISED);
  assert.strictEqual(budgetCategoryOf(null), UNCATEGORISED);
});

// ---------------------------------------------------------------------------
// the shape of the answer
// ---------------------------------------------------------------------------

test('a budgeted category with no spending still appears, showing its allowance', () => {
  const result = summariseBudgets({ transactions: [], budgets: { bill: 250 }, year: 2026, month: 4 });
  const bill = find(result, 'bill');
  assert.strictEqual(bill.current, 0);
  assert.strictEqual(bill.budgeted, 250);
  assert.strictEqual(bill.accumulated, 1000);
});

test('MONEY LAID OUT FOR OTHERS IS NOT BUDGETED', () => {
  // parents-monthly is reclaimed through a return and business is reimbursed. Counting either
  // would report thousands of dollars of overspend that was never yours to spend.
  const result = summariseBudgets({
    transactions: [
      spend(3, 900, 'parents-monthly'),
      spend(3, 400, 'parents-not monthly'),
      spend(3, 250, 'business'),
      spend(3, 10, 'personal'),
    ],
    budgets: { personal: 50 }, year: 2026, month: 3,
  });
  assert.deepStrictEqual(result.categories.map((c) => c.category), ['personal']);
  assert.strictEqual(result.totals.current, 10, 'only the personal spend counts');
});

test('an excluded category cannot be resurrected by budgeting for it', () => {
  const result = summariseBudgets({
    transactions: [], budgets: { business: 500, 'etc.': 100 }, year: 2026, month: 3,
  });
  assert.deepStrictEqual(result.categories, []);
});

// ---------------------------------------------------------------------------
// categories that share one allowance
// ---------------------------------------------------------------------------

test('doctors, emergency and automobile draw from a single allowance', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 120, 'doctors'), spend(2, 300, 'automobile'), spend(3, 80, 'emergency')],
    budgets: { emergency: 350 }, year: 2026, month: 3,
  });
  const pot = find(result, 'emergency');
  assert.strictEqual(pot.current, 80, 'only March');
  assert.strictEqual(pot.yearToDate, 500, '120 + 300 + 80');
  assert.strictEqual(pot.accumulated, 550, '3 x 350 - 500');
  assert.strictEqual(find(result, 'doctors'), undefined, 'members do not appear separately');
  assert.strictEqual(find(result, 'automobile'), undefined);
});

test('budgetCategoryOf resolves a grouped category to its allowance', () => {
  assert.strictEqual(budgetCategoryOf({ category: 'doctors' }), 'emergency');
  assert.strictEqual(budgetCategoryOf({ category: 'automobile' }), 'emergency');
  assert.strictEqual(budgetCategoryOf({ category: 'emergency' }), 'emergency');
  assert.strictEqual(budgetCategoryOf({ category: 'travel' }), 'travel', 'ungrouped is unchanged');
});

test('the group table and the exclusion list do not overlap', () => {
  // A category that is both grouped and excluded would silently vanish from its own pot.
  for (const members of Object.values(BUDGET_GROUPS)) {
    for (const m of members) {
      assert.ok(!EXCLUDED.has(m), `${m} is both grouped and excluded`);
    }
  }
});

test('categories come back ordered by what was spent this month', () => {
  const result = summariseBudgets({
    transactions: [spend(3, 10, 'personal'), spend(3, 90, 'travel'), spend(3, 50, 'fuel')],
    budgets: {}, year: 2026, month: 3,
  });
  assert.deepStrictEqual(result.categories.map((c) => c.category), ['travel', 'fuel', 'personal']);
});

test('totals add up across categories', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 100, 'travel'), spend(3, 40, 'personal')],
    budgets: { travel: 300, personal: 50 }, year: 2026, month: 3,
  });
  assert.strictEqual(result.totals.current, 40);
  assert.strictEqual(result.totals.budgeted, 350);
  assert.strictEqual(result.totals.yearToDate, 140);
  assert.strictEqual(result.totals.accumulated, 910, '(900-100) + (150-40)');
});

test('money is rounded to cents, not left with floating-point crumbs', () => {
  const result = summariseBudgets({
    transactions: [spend(1, 0.1, 'travel'), spend(1, 0.2, 'travel')],
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
