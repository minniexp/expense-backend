const Transaction = require('../models/Transaction');
const PendingTransactions = require('../models/PendingTransactions');
const IgnoredTransaction = require('../models/IgnoredTransaction');
const { fetchAccountTransactions } = require('../services/tellerClient');
const {
  resolveWindowStart,
  diffTellerTransactions,
  parseIsoDate,
  DEFAULT_LOOKBACK_DAYS,
  DUPLICATE_DATE_TOLERANCE_DAYS,
} = require('../services/transactionSync');

// Access token is read from process.env.TELLER_ACCESS_TOKEN at request time.
// All Teller traffic goes through the read-only tellerGet() wrapper.
let accessToken = null;

const MS_PER_DAY = 86400000;

exports.getEnrollmentToken = async (req, res) => {
  try {
    const enrollmentId = process.env.TELLER_ENROLLMENT_ID || null;
    console.log('[GET /enrollment-config]', {
      applicationIdSet: Boolean(process.env.TELLER_APPLICATION_ID),
      environment: process.env.TELLER_ENV || 'sandbox',
      enrollmentIdSet: Boolean(enrollmentId),
      enrollmentIdValue: enrollmentId,
    });
    res.json({
      applicationId: process.env.TELLER_APPLICATION_ID,
      environment: process.env.TELLER_ENV || 'sandbox',
      enrollmentId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.handleAccessToken = async (req, res) => {
  try {
    const { accessToken: token } = req.body;
    accessToken = token;
    res.json({ success: true });
  } catch (err) {
    console.error('Error handling access token:', err);
    res.status(500).json({ error: err.message });
  }
};

/** Run `worker` over `items` with at most `limit` in flight. Preserves input order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const cardMapping = () => ({
  'Amazon Visa': process.env.AMAZON_VISA_ID,
  'Chase College': process.env.CHASE_COLLEGE_ID,
  'Freedom Flex': process.env.FREEDOM_FLEX_ID,
  'Sapphire Reserve': process.env.SAPPHIRE_RESERVE_ID,
  Freedom: process.env.FREEDOM_ID,
  'Freedom Unlimited': process.env.FREEDOM_UNLIMITED_ID,
});

/**
 * GET /api/teller/transactions
 *
 * Returns the Teller transactions that are NOT yet in MongoDB.
 *
 * This used to filter on `date > PendingTransactions.lastDate`, a high-water mark. That was
 * the bug: Chase reports the transaction date, not the posting date, and posts in batches
 * through the day, so anything arriving later with an equal-or-earlier date was dropped on
 * every subsequent fetch — permanently. 506 transactions had been lost that way.
 *
 * The watermark is gone. What is "new" is now decided by set-differencing Teller's
 * transaction ids against the ids already in the Transaction collection, so the result is
 * idempotent and self-healing: anything unsaved keeps reappearing until it is saved.
 *
 * Query parameters (all optional):
 *   days=90        lookback window in days (default 90) — a DISPLAY window, not a watermark
 *   since=YYYY-MM-DD  explicit window start, overrides `days`
 *   all=true       no lower bound (paginates deep; slower)
 *   format=detailed  return { transactions, summary } instead of a bare array
 *
 * `format` defaults to the legacy bare-array shape so an older deployed frontend keeps
 * working against this backend during a staggered deploy.
 */
exports.getTellerTransactions = async (req, res) => {
  try {
    accessToken = process.env.TELLER_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(400).json({
        error: 'No access token available. Please connect a bank account first.',
      });
    }

    const windowStart = resolveWindowStart({
      days: req.query.days,
      since: req.query.since,
      all: req.query.all,
    });

    // The legacy watermark is read for logging only — nothing filters on it any more.
    // A missing PendingTransactions document is no longer fatal; it was only ever a cursor.
    let legacyWatermark = null;
    try {
      const pendingDoc = await PendingTransactions.findById(process.env.PENDING_TRANSACTIONS_ID);
      legacyWatermark = pendingDoc?.lastDate ?? null;
    } catch (err) {
      console.warn('Could not read PendingTransactions (non-fatal):', err.message);
    }

    console.log(
      `[GET /teller/transactions] windowStart=${windowStart ?? 'ALL'} ` +
      `legacyWatermark=${legacyWatermark ?? 'none'} (informational only)`
    );

    // --- fetch the accounts ---------------------------------------------------------------
    // Teller rate-limits bursts. A bounded window resolves in one page per account, so all six
    // can go out at once exactly as before. An unbounded fetch paginates deeply, which is what
    // tripped `429 too_many_requests` in testing — so throttle that case hard.
    const cards = Object.entries(cardMapping());
    const concurrency = windowStart === null ? 2 : cards.length;
    const accountReports = [];
    const tellerTransactions = [];

    const results = await mapWithConcurrency(cards, concurrency, async ([cardName, accountId]) => {
      if (!accountId) {
        console.warn(`Skipping ${cardName}: no account ID configured in env`);
        return { cardName, skipped: true };
      }
      const out = await fetchAccountTransactions(accountId, accessToken, {
        startDate: windowStart,
      });
      return { cardName, ...out };
    });

    for (const r of results) {
      if (r.skipped) {
        accountReports.push({ card: r.cardName, skipped: 'no account ID configured' });
        continue;
      }
      if (r.error) {
        console.error(`Error fetching transactions for ${r.cardName}: ${r.error}`);
      }
      if (r.truncated) {
        console.warn(
          `[${r.cardName}] pagination TRUNCATED after ${r.pages} pages — ` +
          'results are incomplete for this account'
        );
      }
      accountReports.push({
        card: r.cardName,
        fetched: r.transactions.length,
        pages: r.pages,
        truncated: r.truncated,
        rateLimited: r.rateLimited,
        error: r.error,
      });
      for (const t of r.transactions) {
        tellerTransactions.push({ cardName: r.cardName, transaction: t });
      }
    }

    // --- what is already logged ----------------------------------------------------------
    const fetchedIds = tellerTransactions
      .map((e) => e.transaction && e.transaction.id)
      .filter(Boolean);

    // One query. Two things are needed from Mongo:
    //   1. rows whose tellerTransactionId matches anything Teller just returned (the diff), and
    //   2. rows sitting inside the window (widened by the duplicate tolerance) so a re-issued
    //      pending transaction can be recognised even though its id changed.
    const projection = 'tellerTransactionId date amount paymentMethod';
    let loggedTransactions;
    if (windowStart) {
      const extendedStart = new Date(
        parseIsoDate(windowStart) - DUPLICATE_DATE_TOLERANCE_DAYS * MS_PER_DAY
      ).toISOString().slice(0, 10);
      loggedTransactions = await Transaction.find(
        {
          $or: [
            { tellerTransactionId: { $in: fetchedIds } },
            { date: { $gte: extendedStart } }, // `date` is a 'YYYY-MM-DD' string — lexicographic compare is correct
          ],
        },
        projection
      ).lean();
    } else {
      loggedTransactions = await Transaction.find({}, projection).lean();
    }

    // --- what has been deliberately dismissed ---------------------------------------------
    // Scoped to the ids Teller actually returned, so this stays O(fetch) rather than loading
    // the whole dismissed history on every request.
    const ignoredRows = await IgnoredTransaction.find(
      { tellerTransactionId: { $in: fetchedIds } },
      'tellerTransactionId'
    ).lean();
    const ignoredIds = new Set(ignoredRows.map((r) => r.tellerTransactionId));

    // --- the diff ------------------------------------------------------------------------
    const { newTransactions, summary } = diffTellerTransactions({
      tellerTransactions,
      loggedTransactions,
      ignoredIds,
      windowStart,
      userId: process.env.MONGODB_USERID,
    });

    // Belt-and-braces. The diff above is the thing that decides what is new, and it is unit
    // tested — but this endpoint's whole contract is "the frontend never sees a transaction
    // that is already in the ledger", and that contract is worth enforcing at the boundary
    // rather than trusting one code path. If this ever strips anything, the diff has a bug:
    // say so loudly instead of quietly serving a double-entry to the review table.
    const loggedIdSet = new Set(
      loggedTransactions.map((r) => r && r.tellerTransactionId).filter(Boolean).map(String)
    );
    const safeTransactions = newTransactions.filter(
      (t) => !loggedIdSet.has(t.tellerTransactionId) && !ignoredIds.has(t.tellerTransactionId)
    );
    if (safeTransactions.length !== newTransactions.length) {
      console.error(
        '[GET /teller/transactions] INVARIANT VIOLATION: the diff returned ' +
        `${newTransactions.length - safeTransactions.length} already-logged or dismissed ` +
        'transaction(s); they were stripped before responding. ' +
        'This is a bug in diffTellerTransactions().'
      );
      summary.newCount = safeTransactions.length;
    }

    const truncatedAccounts = accountReports.filter((a) => a.truncated).map((a) => a.card);
    const failedAccounts = accountReports.filter((a) => a.error).map((a) => a.card);
    const rateLimitedAccounts = accountReports.filter((a) => a.rateLimited).map((a) => a.card);

    console.log(
      `[GET /teller/transactions] fetched=${summary.fetched} ` +
      `alreadyLogged=${summary.alreadyLogged} ignored=${summary.ignored} ` +
      `excluded=${summary.excluded} ` +
      `outsideWindow=${summary.outsideWindow} malformed=${summary.malformed} ` +
      `NEW=${summary.newCount} possibleDuplicates=${summary.possibleDuplicates}`
    );

    if (req.query.format === 'detailed') {
      return res.json({
        transactions: safeTransactions,
        summary: {
          ...summary,
          windowStart,
          defaultLookbackDays: DEFAULT_LOOKBACK_DAYS,
          legacyWatermark,
          totalIgnored: await IgnoredTransaction.countDocuments(),
          accounts: accountReports,
          // surfaced, never silent: coverage is incomplete for these accounts
          truncatedAccounts,
          failedAccounts,
          rateLimitedAccounts,
        },
      });
    }

    // legacy shape
    res.json(safeTransactions);
  } catch (error) {
    console.error('Error in getTellerTransactions:', error);
    res.status(500).json({ error: error.message });
  }
};
