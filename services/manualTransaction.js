const crypto = require('crypto');
const {
  parseIsoDate,
  determineCategory,
  determinePurchaseCategory,
  calculatePoints,
} = require('./transactionSync');

/**
 * Turn a terse manually-submitted payload into a full ledger row.
 *
 * The phone sends the minimum it reasonably can:
 *
 *   {"amount": 37.57, "description": "Zelle payment from HYEON M YANG",
 *    "date": "2026-07-25", "notes": "gas"}
 *
 * Everything else — transaction type, payment method, category, points, year/month/day, and a
 * stable identifier — is derived here. Pure functions only: no database, no HTTP, no clock
 * beyond what is passed in, so it is unit-testable offline like the other services.
 *
 * Three rules govern the derivation, in order:
 *   1. An explicit value in the payload always wins.
 *   2. Otherwise a description rule decides.
 *   3. Otherwise fall back to the sign of the amount and a default account.
 */

/**
 * Description patterns that determine direction and account.
 *
 * The amount's sign is NOT sufficient. A Shortcut naturally sends a positive number, so
 * "Zelle payment to Anna" — money leaving — would be read as income if only the sign were
 * consulted. The description is the one reliable signal for direction.
 *
 * Ordered: the first match wins. Extend as new recurring descriptions appear.
 */
const DESCRIPTION_RULES = [
  { match: /zelle\s+payment\s+from/i, transactionType: 'income', paymentMethod: 'Chase College' },
  { match: /zelle\s+payment\s+to/i, transactionType: 'expense', paymentMethod: 'Chase College' },
];

const VALID_TYPES = ['income', 'expense'];
const DEFAULT_PAYMENT_METHOD = 'Cash';

/** First matching rule, or null. Never guesses. */
function resolveDescriptionRule(description) {
  if (typeof description !== 'string') return null;
  return DESCRIPTION_RULES.find((r) => r.match.test(description)) || null;
}

/**
 * Parse an amount, rejecting anything that is not actually a number.
 *
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so a missing amount would otherwise
 * be stored as a perfectly valid free transaction with no error raised anywhere.
 */
function parseAmount(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value.trim());
  else throw new Error(`Invalid amount: ${JSON.stringify(value)}`);

  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${JSON.stringify(value)}`);
  if (n === 0) throw new Error('Invalid amount: zero is not a transaction');
  return n;
}

/**
 * Apply the account's sign convention.
 *
 * Every one of the existing rows follows one: on the checking account (and cash) money coming
 * in is positive; on a credit card a charge is positive. A manual row that ignores this looks
 * right on its own but reports the wrong way round in any total that sums amounts.
 *
 * The guarantee is that `determineTransactionType(paymentMethod, result) === transactionType`.
 */
function normalizeAmountSign(amount, paymentMethod, transactionType) {
  const magnitude = Math.abs(Number(amount));
  const inflowIsPositive = paymentMethod === 'Chase College' || paymentMethod === 'Cash';
  const positive = inflowIsPositive
    ? transactionType === 'income'
    : transactionType === 'expense';
  return positive ? magnitude : -magnitude;
}

/**
 * A stable id derived from the transaction's own content.
 *
 * Manual rows have no upstream identifier, yet the id is what the whole dedupe, ignore and
 * duplicate-detection machinery keys on. Deriving it from the content means a phone retrying a
 * dropped request produces the same id and upserts, rather than silently doubling an expense.
 *
 * `ordinal` keeps genuinely repeated purchases addressable. The live data contains eleven
 * groups of real transactions sharing card, date, amount and description — collapsing those
 * would delete real spending.
 */
function deriveTransactionId({ date, amount, description, paymentMethod }, ordinal = 0) {
  const canonical = [
    String(date || ''),
    Math.abs(Number(amount) || 0).toFixed(2),
    String(description || '').trim().toUpperCase().replace(/\s+/g, ' '),
    String(paymentMethod || ''),
  ].join('|');
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  return ordinal > 0 ? `manual_${hash}_${ordinal}` : `manual_${hash}`;
}

/**
 * Build the full ledger row.
 *
 * @param {object} input      the submitted payload
 * @param {object} options
 * @param {string} options.userId
 * @param {function} options.returnIdForMonth  (year, month) => returnId | null
 * @param {number} [options.ordinal]           distinguishes a genuine repeat
 * @param {string} [options.source]            provenance, default 'phone'
 * @returns {object} ready to persist
 * @throws {Error} on any invalid input — never silently coerces
 */
function buildManualTransaction(input, options = {}) {
  const { userId, returnIdForMonth = () => null, ordinal = 0, source = 'phone' } = options;
  const raw = input || {};

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) throw new Error('A description is required');

  const dateMs = parseIsoDate(raw.date);
  if (dateMs === null) {
    throw new Error(`Invalid date: ${JSON.stringify(raw.date)} — expected YYYY-MM-DD`);
  }
  const [year, month, day] = raw.date.split('-').map(Number);

  const submitted = parseAmount(raw.amount);

  if (raw.transactionType !== undefined && !VALID_TYPES.includes(raw.transactionType)) {
    throw new Error(
      `Invalid transactionType: ${JSON.stringify(raw.transactionType)} — expected income or expense`
    );
  }

  // Precedence: explicit > description rule > fallback.
  const rule = resolveDescriptionRule(description);
  const paymentMethod = raw.paymentMethod || (rule && rule.paymentMethod) || DEFAULT_PAYMENT_METHOD;
  // Last-resort fallback, and it deliberately does NOT reuse determineTransactionType().
  //
  // That function encodes how the BANK reports: on a checking account a positive figure is
  // money arriving, because that is how a deposit appears in the feed. A person typing
  // "12.50, ARMO GRILL" into their phone means they SPENT 12.50. Applying the bank's
  // convention to hand-entered data files ordinary purchases as income.
  //
  // So: a bare positive amount is an expense, a negative one is a refund or income. The sign
  // convention for STORAGE is still the account's — normalizeAmountSign() applies it below —
  // so the stored row remains indistinguishable from a bank-sourced one.
  const transactionType = raw.transactionType
    || (rule && rule.transactionType)
    || (submitted > 0 ? 'expense' : 'income');

  const amount = normalizeAmountSign(submitted, paymentMethod, transactionType);

  // Same classifiers the Teller sync used, so manual rows categorise identically.
  const forClassifier = { description };
  const purchaseCategory = raw.purchaseCategory !== undefined
    ? raw.purchaseCategory
    : determinePurchaseCategory(forClassifier);
  const category = raw.category !== undefined ? raw.category : determineCategory(forClassifier);
  const points = raw.points !== undefined
    ? Number(raw.points)
    : calculatePoints(paymentMethod, purchaseCategory, month);

  const isParentsMonthly = category === 'parents-monthly';

  return {
    userId,
    tellerTransactionId: deriveTransactionId({ date: raw.date, amount, description, paymentMethod }, ordinal),
    source,
    date: raw.date,
    year,
    month,
    day,
    amount,
    transactionType,
    description,
    category,
    purchaseCategory,
    paymentMethod,
    points,
    returnId: isParentsMonthly ? returnIdForMonth(year, month) : null,
    returned: false,
    needToBePaidback: isParentsMonthly,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

module.exports = {
  DESCRIPTION_RULES,
  DEFAULT_PAYMENT_METHOD,
  resolveDescriptionRule,
  parseAmount,
  normalizeAmountSign,
  deriveTransactionId,
  buildManualTransaction,
};
