const Transaction = require('../models/Transaction');
const {
  buildManualTransaction, deriveTransactionId,
} = require('../services/manualTransaction');

/**
 * Ingest transactions submitted from outside the web UI — currently an iOS Shortcut.
 *
 * Create-only by design. There is no read, update or delete on this path, so the credential it
 * requires is worth far less than a session token: someone holding it can add rows, not read
 * bank data.
 *
 * All derivation lives in services/manualTransaction.js, which is pure and unit-tested. This
 * layer only validates the envelope, resolves duplicates against the database, and persists.
 */

const MAX_BATCH = 100;

const monthEnvKeys = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const returnIdForMonth = (year, month) => {
  const key = monthEnvKeys[month - 1];
  return key ? process.env[`${year}_${key}_RETURNID`] || null : null;
};

/**
 * Find a free ordinal for a content-derived id.
 *
 * The base id is the same for two genuinely identical purchases, and the live data proves
 * those are real — eleven groups share card, date, amount and description. So:
 *
 *   - if the base id already exists AND `allowDuplicate` was requested, take the next ordinal
 *   - otherwise reuse the base id, which makes a retried request upsert rather than duplicate
 */
async function resolveOrdinal(candidate, allowDuplicate) {
  if (!allowDuplicate) return 0;
  for (let ordinal = 0; ordinal < 50; ordinal++) {
    const id = deriveTransactionId(candidate, ordinal);
    const exists = await Transaction.exists({ tellerTransactionId: id });
    if (!exists) return ordinal;
  }
  throw new Error('Too many identical transactions on the same day');
}

/**
 * POST /api/ingest/transaction
 *
 * Body: a single transaction object, or an array of them.
 *   { amount, date, description, notes?, transactionType?, paymentMethod?,
 *     category?, purchaseCategory?, points?, allowDuplicate? }
 */
exports.ingestTransactions = async (req, res) => {
  try {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];

    if (items.length === 0 || (items.length === 1 && (!items[0] || typeof items[0] !== 'object'))) {
      return res.status(400).json({
        message: 'Send a transaction object, or an array of them.',
        example: {
          amount: 37.57, description: 'Zelle payment from HYEON M YANG',
          date: '2026-07-25', notes: 'gas',
        },
      });
    }
    if (items.length > MAX_BATCH) {
      return res.status(400).json({ message: `Too many transactions (${items.length}; max ${MAX_BATCH}).` });
    }

    const saved = [];
    const errors = [];

    for (const [index, item] of items.entries()) {
      let record;
      try {
        const base = buildManualTransaction(item, {
          userId: (item && item.userId) || process.env.MONGODB_USERID,
          returnIdForMonth,
          source: 'phone',
        });
        const ordinal = await resolveOrdinal(
          { date: base.date, amount: base.amount, description: base.description,
            paymentMethod: base.paymentMethod },
          Boolean(item && item.allowDuplicate)
        );
        record = ordinal === 0
          ? base
          : buildManualTransaction(item, {
            userId: (item && item.userId) || process.env.MONGODB_USERID,
            returnIdForMonth, source: 'phone', ordinal,
          });
      } catch (e) {
        // Validation failures are the sender's to fix, not a 500.
        errors.push({ index, message: e.message });
        continue;
      }

      // Upsert on the derived id, so a retried request updates the same row rather than
      // creating a second one. This is what makes the endpoint safe to call from a phone on a
      // flaky connection.
      const result = await Transaction.findOneAndUpdate(
        { tellerTransactionId: record.tellerTransactionId },
        { $set: record },
        { upsert: true, new: true, setDefaultsOnInsert: true, rawResult: true }
      );
      const doc = result.value || result;
      const created = Boolean(result.lastErrorObject && result.lastErrorObject.upserted);
      saved.push({ created, transaction: doc });
    }

    // Never log the payload's amounts or descriptions — this runs on a hosted log stream.
    console.log(`[POST /ingest/transaction] received=${items.length} `
      + `saved=${saved.length} created=${saved.filter((s) => s.created).length} `
      + `errors=${errors.length}`);

    if (saved.length === 0) {
      return res.status(400).json({ message: 'Nothing was saved.', errors });
    }

    res.status(201).json({
      message: `Saved ${saved.length} transaction(s).`,
      created: saved.filter((s) => s.created).length,
      updated: saved.filter((s) => !s.created).length,
      transactions: saved.map((s) => s.transaction),
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    console.error('Error ingesting transactions:', err);
    res.status(500).json({ message: err.message });
  }
};
