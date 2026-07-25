/**
 * Teller → MongoDB sync diff.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The sync used to decide what was new by comparing each transaction's date against a stored
 * `lastDate` high-water mark. That is wrong: Chase reports the *transaction* date, not the
 * *posting* date, and it posts in batches through the day. A transaction that arrives after the
 * watermark was set but carries an equal-or-earlier date was filtered out on every subsequent
 * fetch, permanently. On the live database that had silently swallowed 506 transactions.
 *
 * A date is not an identity. This module answers the question that was actually being asked —
 * "which transactions does Chase have that my database does not?" — by set-differencing on
 * `tellerTransactionId`. It is idempotent and self-healing: anything not yet saved keeps
 * reappearing until it is saved, regardless of dates, ordering, or how late Chase posts it.
 *
 * Everything here is a pure function. No Teller connection, no Mongo connection, no Express —
 * so it is unit-testable offline (see tests/transactionSync.test.js).
 */

// ---------------------------------------------------------------------------
// Exclusion phrases
// ---------------------------------------------------------------------------

/**
 * Descriptions that are money moving between the user's own accounts (card autopayments,
 * transfers) rather than spending. Logging them would double-count.
 *
 * Calibrated on 2026-07-25 against the account's full live transaction history.
 * The first five entries are the original list. `PAYMENT-THANK YOU` matched *nothing*: the
 * real Chase string has spaces around the dash. It is retained (harmless) and the three
 * strings that actually occur were added.
 *
 * Deliberately NOT excluded, because they are real transactions: `VENMO PAYMENT`,
 * `ATT* BILL PAYMENT`, and every `Zelle payment to/from …`.
 */
const EXCLUDED_PHRASES = [
  'Payment to Chase card ending in',
  'PAYMENT TO CHASE CARD ENDING IN',
  'Payment Thank You-Mobile',
  'PAYMENT-THANK YOU',
  'Online Transfer',
  // added 2026-07-25 — verified present in live data, previously never matched
  'AUTOMATIC PAYMENT - THANK YOU',
  'CHASE CREDIT CRD AUTOPAY',
  'Payment Thank You - Web',
];

/** Upper-case and collapse whitespace so spacing/case variants match a single phrase. */
const normalizeDescription = (value) => String(value).toUpperCase().replace(/\s+/g, ' ').trim();

const NORMALIZED_EXCLUDED = EXCLUDED_PHRASES.map(normalizeDescription);

function isExcludedDescription(description) {
  if (typeof description !== 'string' || description.length === 0) return false;
  const normalized = normalizeDescription(description);
  return NORMALIZED_EXCLUDED.some((phrase) => normalized.includes(phrase));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;
const DEFAULT_LOOKBACK_DAYS = 90;
// `days` arrives from the query string. Without a ceiling, ?days=999999999999999 pushes the
// computed start date outside the representable Date range and toISOString() throws.
const MAX_LOOKBACK_DAYS = 36500; // 100 years — beyond any real history; use ?all=true instead

/** Parse 'YYYY-MM-DD' to UTC epoch ms, or null if it isn't a real calendar date. */
function parseIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  // rejects 2026-02-30 and friends, which Date.UTC would silently roll over
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

const toIsoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Resolve the lower bound of the review window.
 *
 * This is a *display* window — how far back to look for unsaved transactions — NOT a
 * watermark. It never advances on its own and nothing is permanently skipped because of it:
 * widening the window re-surfaces everything inside it.
 *
 * @returns {string|null} 'YYYY-MM-DD', or null for no lower bound.
 */
function resolveWindowStart(options = {}, todayIso = new Date().toISOString().slice(0, 10)) {
  if (options.all === true || options.all === 'true') return null;

  if (typeof options.since === 'string' && parseIsoDate(options.since) !== null) {
    return options.since;
  }

  let days = Math.floor(Number(options.days));
  if (!Number.isFinite(days) || days <= 0) days = DEFAULT_LOOKBACK_DAYS;
  if (days > MAX_LOOKBACK_DAYS) days = MAX_LOOKBACK_DAYS;

  const todayMs = parseIsoDate(todayIso);
  if (todayMs === null) return null;
  return toIsoDate(todayMs - days * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Amount normalisation
// ---------------------------------------------------------------------------

/**
 * Teller sends amounts as strings ('-17.79'); Mongo stores them as Numbers. Normalise both to
 * one key so a fingerprint built from either side compares equal.
 */
function amountKey(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'NaN';
  const fixed = n.toFixed(2);
  return fixed === '-0.00' ? '0.00' : fixed; // -0 and 0 must not split the key
}

// ---------------------------------------------------------------------------
// Classification (moved verbatim from tellerController so it can be tested)
// ---------------------------------------------------------------------------

const GROCERY_STORES = ['ALDI', 'H MART', 'JERRY S FRUIT', 'JOONG BOO MARKET', 'ASSI PLAZA'];

function determinePurchaseCategory(transaction) {
  const purchaseCategories = new Set();
  const description = String(transaction.description || '').toUpperCase();

  if (GROCERY_STORES.some((store) => description.includes(store))) {
    purchaseCategories.add('groceries');
  }
  if (description.includes('AMAZON')) {
    purchaseCategories.add('amazon');
  }
  if (['WALGREENS', 'CVS'].some((store) => description.includes(store))) {
    purchaseCategories.add('drugstore');
  }
  if (transaction.details?.category === 'dining') {
    purchaseCategories.add('dining');
  }

  return Array.from(purchaseCategories);
}

function determineCategory(transaction) {
  const description = String(transaction.description || '').toUpperCase();

  if (GROCERY_STORES.some((store) => description.includes(store))) return 'parents-monthly';
  if (description.includes('WWW.SWAN-DIVEPILATES.C WWW.SWAN-DIVE')) return 'bill';
  if (description.includes('CAREONE DENTAL ASSOCIATES GLENVIEW')) return 'doctors';

  return '';
}

function determineTransactionType(cardName, amount) {
  // On the checking account and cash, a positive amount is money coming in.
  if (cardName === 'Chase College' || cardName === 'Cash') {
    return amount > 0 ? 'income' : 'expense';
  }
  // On credit cards, a positive amount is a charge.
  return amount > 0 ? 'expense' : 'income';
}

function calculatePoints(cardName, purchaseCategories, month) {
  if (cardName === 'Chase College') return 0;

  if ((cardName === 'Freedom' || cardName === 'Freedom Flex')
      && purchaseCategories.includes('groceries')
      && [1, 2, 3].includes(month)) {
    return 5;
  }
  if (cardName === 'Sapphire Reserve' && purchaseCategories.includes('lyft')) return 10;

  const travelRewardCards = ['Sapphire Reserve', 'Freedom Unlimited', 'Freedom Flex'];
  if (travelRewardCards.includes(cardName) && purchaseCategories.includes('flight')) return 5;
  if (travelRewardCards.includes(cardName) && purchaseCategories.includes('dining')) return 3;
  if (cardName === 'Freedom Unlimited') return 1.5;

  return 0;
}

const MONTH_ENV_KEYS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function defaultReturnIdForMonth(year, month) {
  const key = MONTH_ENV_KEYS[month - 1];
  return key ? process.env[`${year}_${key}_RETURNID`] || null : null;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** How far a transaction's date may shift on posting before we stop suspecting a duplicate. */
const DUPLICATE_DATE_TOLERANCE_DAYS = 3;

/**
 * Set-difference Teller's view against MongoDB's.
 *
 * @param {object}   args
 * @param {Array<{cardName: string, transaction: object}>} args.tellerTransactions
 *        Raw Teller transactions, each tagged with the card it came from.
 * @param {Array<object>} args.loggedTransactions
 *        Rows already in MongoDB. Only `tellerTransactionId`, `date`, `amount` and
 *        `paymentMethod` are read.
 * @param {string|null} args.windowStart  'YYYY-MM-DD' lower bound, inclusive; null = no bound.
 * @param {string} [args.userId]
 * @param {function} [args.returnIdForMonth]  injectable for tests
 * @returns {{newTransactions: Array<object>, summary: object}}
 */
function diffTellerTransactions({
  tellerTransactions = [],
  loggedTransactions = [],
  windowStart = null,
  userId = undefined,
  returnIdForMonth = defaultReturnIdForMonth,
} = {}) {
  const windowStartMs = windowStart === null ? null : parseIsoDate(windowStart);

  const summary = {
    fetched: tellerTransactions.length,
    malformed: 0,
    outsideWindow: 0,
    excluded: 0,
    alreadyLogged: 0,
    newCount: 0,
    possibleDuplicates: 0,
    pending: 0,
  };

  // --- what MongoDB already has -------------------------------------------------
  const loggedIds = new Set();
  for (const row of loggedTransactions) {
    if (row && row.tellerTransactionId) loggedIds.add(String(row.tellerTransactionId));
  }

  // --- partition the incoming transactions ---------------------------------------
  const candidates = [];
  const fetchedIds = new Set();

  for (const entry of tellerTransactions) {
    const t = entry && entry.transaction;
    const cardName = entry && entry.cardName;

    const dateMs = t ? parseIsoDate(t.date) : null;
    if (!t || typeof t.id !== 'string' || !t.id || dateMs === null) {
      summary.malformed++;
      continue;
    }
    fetchedIds.add(t.id);

    if (windowStartMs !== null && dateMs < windowStartMs) {
      summary.outsideWindow++;
      continue;
    }
    if (isExcludedDescription(t.description)) {
      summary.excluded++;
      continue;
    }
    if (loggedIds.has(t.id)) {
      summary.alreadyLogged++;
      continue;
    }

    candidates.push({ cardName, transaction: t, dateMs });
  }

  // Deterministic order: newest first, id as tie-break. Fixed before duplicate assignment so
  // that which candidate claims an unmatched row never depends on Teller's response ordering.
  candidates.sort((a, b) => (b.dateMs - a.dateMs) || a.transaction.id.localeCompare(b.transaction.id));

  // --- count-aware duplicate detection --------------------------------------------
  //
  // Teller re-issues a NEW id when a pending transaction changes materially on posting, so
  // pure id-matching can re-offer something already saved. But `card|date|amount` collides for
  // genuinely distinct transactions in this dataset — the same card charged the same amount
  // at the same merchant twice in one day happens, and both charges are real. Eleven such
  // groups exist in the live history, so matching alone must never suppress anything.
  //
  // The rule is therefore count-aware: a DB row only makes a candidate suspicious if that row
  // is *unclaimed* — no transaction in this fetch carries its id. Each unclaimed row is
  // consumed by at most one candidate. The result is advisory; nothing is ever hidden.
  const unclaimedByKey = new Map();
  for (const row of loggedTransactions) {
    if (!row) continue;
    const id = row.tellerTransactionId ? String(row.tellerTransactionId) : null;
    if (id && fetchedIds.has(id)) continue; // claimed by an incoming transaction

    const rowDateMs = parseIsoDate(row.date);
    if (rowDateMs === null) continue;

    const key = `${row.paymentMethod || ''}|${amountKey(row.amount)}`;
    if (!unclaimedByKey.has(key)) unclaimedByKey.set(key, []);
    unclaimedByKey.get(key).push({ id, dateMs: rowDateMs, date: row.date, consumed: false });
  }

  const newTransactions = candidates.map(({ cardName, transaction, dateMs }) => {
    const [year, month, day] = transaction.date.split('-').map(Number);
    const purchaseCategories = determinePurchaseCategory(transaction);
    const category = determineCategory(transaction);
    const isParentsMonthly = category === 'parents-monthly';
    const amount = Number(transaction.amount);

    // find the closest unclaimed, unconsumed row within tolerance
    const pool = unclaimedByKey.get(`${cardName || ''}|${amountKey(transaction.amount)}`) || [];
    let match = null;
    let bestDelta = Infinity;
    for (const row of pool) {
      if (row.consumed) continue;
      const delta = Math.abs(row.dateMs - dateMs) / MS_PER_DAY;
      if (delta <= DUPLICATE_DATE_TOLERANCE_DAYS && delta < bestDelta) {
        bestDelta = delta;
        match = row;
      }
    }
    if (match) match.consumed = true;

    if (match) summary.possibleDuplicates++;
    if (transaction.status === 'pending') summary.pending++;

    return {
      userId,
      tellerTransactionId: transaction.id,
      date: transaction.date,
      year,
      month,
      day,
      amount,
      transactionType: determineTransactionType(cardName, amount),
      notes: '',
      category,
      purchaseCategory: purchaseCategories,
      description: transaction.description,
      paymentMethod: cardName,
      points: calculatePoints(cardName, purchaseCategories, month),
      returnId: isParentsMonthly ? returnIdForMonth(year, month) : null,
      returned: false,
      needToBePaidback: isParentsMonthly,

      // review-only metadata — not part of the Transaction schema
      status: transaction.status,
      possibleDuplicate: Boolean(match),
      duplicateReason: match
        ? (match.id
          ? `Matches an existing entry (${match.id}) dated ${match.date} with the same card and amount. `
            + 'Teller re-issues an id when a pending transaction changes on posting, so this may already be saved.'
          : `Matches an existing manual entry dated ${match.date} with the same card and amount.`)
        : null,
    };
  });

  summary.newCount = newTransactions.length;

  return { newTransactions, summary };
}

module.exports = {
  EXCLUDED_PHRASES,
  DEFAULT_LOOKBACK_DAYS,
  MAX_LOOKBACK_DAYS,
  DUPLICATE_DATE_TOLERANCE_DAYS,
  isExcludedDescription,
  normalizeDescription,
  parseIsoDate,
  resolveWindowStart,
  amountKey,
  determinePurchaseCategory,
  determineCategory,
  determineTransactionType,
  calculatePoints,
  diffTellerTransactions,
};
