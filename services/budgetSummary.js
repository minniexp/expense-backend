/**
 * Spending against a rolling monthly budget, per purchase category.
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

/** Spending with no purchase category still has to appear somewhere. */
const UNCATEGORISED = 'etc.';

/**
 * Which budget a transaction draws from.
 *
 * The FIRST purchase category, not all of them. `purchaseCategory` is an array, and a purchase
 * tagged both dining and travel would otherwise be counted twice — the totals would exceed what was
 * actually spent, which is the one thing a budget must never do.
 */
function budgetCategoryOf(transaction) {
  const tags = (transaction && transaction.purchaseCategory) || [];
  const first = Array.isArray(tags) ? tags.find((t) => typeof t === 'string' && t.trim()) : null;
  return first ? first.trim() : UNCATEGORISED;
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
    UNCATEGORISED,
  ]);

  const categories = [...names]
    .map((name) => {
      const monthlyBudget = Number((budgets || {})[name]) || 0;
      const current = currentByCategory.get(name) || 0;
      const yearToDate = yearToDateByCategory.get(name) || 0;
      return {
        purchaseCategory: name,
        current: round2(current),
        budgeted: round2(monthlyBudget),
        yearToDate: round2(yearToDate),
        // Deliberately allowed to go negative: overspending is a real state and hiding it at zero
        // would make the next month look funded when it is not.
        accumulated: round2(targetMonth * monthlyBudget - yearToDate),
      };
    })
    // Drop the placeholder when nothing is uncategorised and nothing budgets for it.
    .filter((c) => !(c.purchaseCategory === UNCATEGORISED && c.yearToDate === 0 && c.budgeted === 0))
    .sort((a, b) => b.current - a.current || a.purchaseCategory.localeCompare(b.purchaseCategory));

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

module.exports = { UNCATEGORISED, budgetCategoryOf, spendOf, summariseBudgets };
