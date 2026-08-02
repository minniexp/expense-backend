/**
 * Spending against a rolling monthly budget, per main category.
 *
 * Three numbers per category, which answer three different questions:
 *
 *   current      what has been spent in the month being looked at
 *   budgeted     the monthly allowance for that category
 *   accumulated  what is actually left, given every month so far this year
 *
 * `accumulated` is the one that carries the year. The allowance accrues each month and spending
 * draws it down, so an underspent January still funds March and an overspent one still hurts:
 *
 *   accumulated = (months elapsed × monthly allowance) − (everything spent since January)
 *
 * Worked through with travel at $300 a month, looking at March: three months have accrued $900,
 * January spent $609.37 and February nothing, so $900 − $609.37 = $290.63 remains. A single
 * month's figure cannot show that; a running total is the only thing that does.
 */

/** Spending with no category at all. Not budgeted — see EXCLUDED below. */
const UNCATEGORISED = 'etc.';

/**
 * Categories that share one allowance.
 *
 * Doctors, car trouble and outright emergencies are the same kind of money: rare, unplanned, and
 * impossible to budget for individually because none of them happens on a schedule. Budgeting them
 * separately means three lines that each look wildly over or wildly under every month, when what
 * matters is whether the pot as a whole is holding.
 */
const BUDGET_GROUPS = {
  emergency: ['emergency', 'doctors', 'automobile'],
};

/** member category -> the allowance it draws from */
const GROUP_OF = new Map(
  Object.entries(BUDGET_GROUPS).flatMap(([group, members]) => members.map((m) => [m, group]))
);

/**
 * Categories kept out of the budget view entirely.
 *
 * These are not personal spending. `parents-monthly` and `parents-not monthly` are money laid out
 * on someone else's behalf and reclaimed through a return; `business` is reimbursed elsewhere.
 * Budgeting against them would report thousands of dollars of overspend that was never yours to
 * spend. `etc.` is excluded because an allowance for "everything uncategorised" cannot be acted on
 * — the fix for an uncategorised transaction is to categorise it.
 */
const EXCLUDED = new Set(['parents-monthly', 'parents-not monthly', 'business', UNCATEGORISED]);

/**
 * Which budget a transaction draws from.
 *
 * The main `category` field, not `purchaseCategory` — a transaction has exactly one of the former
 * and any number of the latter, so keying on it means nothing is ever double-counted, and a budget
 * of "travel" or "fuel" (which exist as a purchase-category tag too) unambiguously means the main
 * category, not the tag. Grouped categories resolve to their shared allowance.
 */
function budgetCategoryOf(transaction) {
  const category = transaction && typeof transaction.category === 'string' ? transaction.category.trim() : '';
  if (!category) return UNCATEGORISED;
  return GROUP_OF.get(category) || category;
}

/**
 * Money going out, as a positive number.
 *
 * The sign in storage follows the account, not the direction — a charge is positive on a credit
 * card and negative on the checking account — so the magnitude is what "spent" means here.
 */
function spendOf(transaction) {
  if (!transaction || transaction.transactionType !== 'expense') return 0;
  const amount = Math.abs(Number(transaction.amount));
  return Number.isFinite(amount) ? amount : 0;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} args
 * @param {Array}  args.transactions  every transaction; filtered here, so the caller need not
 * @param {object} args.budgets       purchase category -> monthly allowance in dollars
 * @param {number} args.year
 * @param {number} args.month         1-12, the month being looked at
 * @returns {{month: number, year: number, totals: object, categories: Array}}
 */
function summariseBudgets({ transactions = [], budgets = {}, year, month } = {}) {
  const targetYear = Number(year);
  const targetMonth = Number(month);
  if (!targetYear || !targetMonth || targetMonth < 1 || targetMonth > 12) {
    throw new Error(`Invalid period: ${JSON.stringify({ year, month })}`);
  }

  const currentByCategory = new Map();
  const yearToDateByCategory = new Map();

  for (const transaction of transactions) {
    const spend = spendOf(transaction);
    if (spend === 0) continue;
    if (Number(transaction.year) !== targetYear) continue;

    const transactionMonth = Number(transaction.month);
    if (!transactionMonth || transactionMonth > targetMonth) continue;

    const category = budgetCategoryOf(transaction);
    yearToDateByCategory.set(category, (yearToDateByCategory.get(category) || 0) + spend);
    if (transactionMonth === targetMonth) {
      currentByCategory.set(category, (currentByCategory.get(category) || 0) + spend);
    }
  }

  // Every category that has a budget or has seen money, so a category budgeted but untouched still
  // shows its allowance rather than vanishing.
  const names = new Set([
    ...Object.keys(budgets || {}),
    ...yearToDateByCategory.keys(),
  ]);
  // Removed from the totals as well as the list. A total that includes a line you cannot see does
  // not add up on screen, which reads as a bug in the arithmetic rather than a deliberate omission.
  EXCLUDED.forEach((name) => names.delete(name));

  const categories = [...names]
    .map((name) => {
      const monthlyBudget = Number((budgets || {})[name]) || 0;
      const current = currentByCategory.get(name) || 0;
      const yearToDate = yearToDateByCategory.get(name) || 0;
      return {
        category: name,
        current: round2(current),
        budgeted: round2(monthlyBudget),
        yearToDate: round2(yearToDate),
        // Deliberately allowed to go negative: overspending is a real state and hiding it at zero
        // would make the next month look funded when it is not.
        accumulated: round2(targetMonth * monthlyBudget - yearToDate),
      };
    })
    .sort((a, b) => b.current - a.current || a.category.localeCompare(b.category));

  const totals = categories.reduce(
    (acc, c) => ({
      current: round2(acc.current + c.current),
      budgeted: round2(acc.budgeted + c.budgeted),
      yearToDate: round2(acc.yearToDate + c.yearToDate),
      accumulated: round2(acc.accumulated + c.accumulated),
    }),
    { current: 0, budgeted: 0, yearToDate: 0, accumulated: 0 }
  );

  return { year: targetYear, month: targetMonth, totals, categories };
}

module.exports = { UNCATEGORISED, BUDGET_GROUPS, EXCLUDED, budgetCategoryOf, spendOf, summariseBudgets };
