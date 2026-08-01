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

/**
 * Teller Connect widget configuration.
 *
 * `environment` matters more than it looks. It tells Teller Connect WHICH environment to look
 * the enrollment up in, and enrollments do not exist across environments. Pointing Connect at
 * `sandbox` while holding a production enrollment produces Teller's own error —
 * "an enrollment with that id could not be found" — which reads like a bad or missing id and
 * sends you hunting through the wrong config entirely. The id is fine; the lookup is happening
 * in the wrong place.
 *
 * There is deliberately no default. Falling back to 'sandbox' is what allowed a production
 * setup to silently misconfigure itself.
 */
exports.getEnrollmentToken = async (req, res) => {
  try {
    const enrollmentId = process.env.TELLER_ENROLLMENT_ID || null;
    const environment = process.env.TELLER_ENV;

    // Teller has THREE environments, and an enrollment exists in exactly one of them:
    //   sandbox     — fake test data, free
    //   development — REAL bank data, free, limited number of enrollments
    //   production  — REAL bank data, requires payment setup on the Teller application
    // Point Connect at the wrong one and it reports "an enrollment with that id could not be
    // found", which reads like a bad id and is not. Real data plus an application without
    // payment setup means "development", not "production".
    const VALID_ENVIRONMENTS = ['sandbox', 'development', 'production'];

    const warnings = [];
    if (!environment) {
      warnings.push('TELLER_ENV is not set. Teller Connect needs to know which environment to '
        + 'look the enrollment up in — one of: ' + VALID_ENVIRONMENTS.join(', ') + '.');
    } else if (!VALID_ENVIRONMENTS.includes(environment)) {
      warnings.push(`TELLER_ENV is "${environment}", which is not a Teller environment. `
        + 'Expected one of: ' + VALID_ENVIRONMENTS.join(', ') + '.');
    } else if (environment === 'sandbox' && enrollmentId) {
      warnings.push('TELLER_ENV is "sandbox" but an enrollment id is configured. If that '
        + 'enrollment was created against real bank data it lives in "development" or '
        + '"production", and Connect will report that the enrollment cannot be found.');
    } else if (environment === 'production') {
      warnings.push('TELLER_ENV is "production". That requires payment setup on the Teller '
        + 'application; without it Connect reports "your application needs payment setup '
        + 'before it can be used in production". If your enrollment is on the free tier with '
        + 'real bank data, the correct value is "development".');
    }
    if (!process.env.TELLER_APPLICATION_ID) {
      warnings.push('TELLER_APPLICATION_ID is not set — Teller Connect cannot start.');
    }
    warnings.forEach((w) => console.warn('[GET /enrollment-config] ' + w));

    // Log whether things are configured, never the values. These identify the bank
    // connection, and server logs are the easiest place for them to end up somewhere
    // unintended — a Vercel log stream, a pasted stack trace, a screenshot.
    console.log('[GET /enrollment-config]', {
      applicationIdSet: Boolean(process.env.TELLER_APPLICATION_ID),
      environment: environment || '(unset)',
      enrollmentIdSet: Boolean(enrollmentId),
    });

    res.json({
      applicationId: process.env.TELLER_APPLICATION_ID,
      environment,
      enrollmentId,
      warnings,
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
      // Freshness. A Teller enrollment can stop syncing with the bank while still reporting
      // status=open and happily serving the data it already has. From the app's side that is
      // indistinguishable from "you have no new spending" — which is exactly how a broken bank
      // connection gets mistaken for a filtering bug.
      const dates = r.transactions.map((t) => t && t.date).filter(Boolean).sort();
      const newestDate = dates.length ? dates[dates.length - 1] : null;

      accountReports.push({
        card: r.cardName,
        fetched: r.transactions.length,
        newestDate,
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

    // Days since the most recent transaction Teller knows about, across all accounts.
    const todayIso = new Date().toISOString().slice(0, 10);
    const newestOverall = accountReports
      .map((a) => a.newestDate).filter(Boolean).sort().pop() || null;
    const staleDays = newestOverall
      ? Math.round((Date.parse(todayIso) - Date.parse(newestOverall)) / 86400000)
      : null;

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
          newestTransactionDate: newestOverall,
          staleDays,
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

/**
 * GET /api/teller/live-enrollments   — LOCAL DIAGNOSTIC, NOT COMMITTED.
 *
 * Reports the enrollment(s) reachable with the CURRENT access token, derived from the accounts
 * API, which returns `enrollment_id` on every account.
 *
 * This is the only way to see an enrollment id without going through Teller Connect: Connect
 * creates and updates enrollments, it never lists them. Note this shows only the enrollment
 * belonging to the token we hold — to see every enrollment an application has, use the Teller
 * dashboard.
 */
exports.getLiveEnrollments = async (req, res) => {
  try {
    const token = process.env.TELLER_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'TELLER_ACCESS_TOKEN is not set' });

    const r = await tellerGet('/accounts', token);
    if (!r.ok) {
      return res.status(502).json({
        error: `Teller returned HTTP ${r.status}`,
        detail: (await r.text().catch(() => '')).slice(0, 300),
      });
    }
    const accounts = await r.json();
    const byEnrollment = {};
    for (const a of accounts) {
      const key = a.enrollment_id || '(none)';
      (byEnrollment[key] = byEnrollment[key] || []).push({
        name: a.name, lastFour: a.last_four, status: a.status,
        institution: a.institution && a.institution.name,
      });
    }
    res.json({
      configuredEnrollmentId: process.env.TELLER_ENROLLMENT_ID || null,
      environment: process.env.TELLER_ENV || null,
      enrollments: Object.entries(byEnrollment).map(([enrollmentId, accts]) => ({
        enrollmentId,
        institution: accts[0] && accts[0].institution,
        accountCount: accts.length,
        accounts: accts,
        matchesConfigured: enrollmentId === process.env.TELLER_ENROLLMENT_ID,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
