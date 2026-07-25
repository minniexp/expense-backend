const IgnoredTransaction = require('../models/IgnoredTransaction');

/**
 * Dismissed-transaction management.
 *
 * The Teller sync is deliberately self-healing: anything Chase has that the ledger does not
 * comes back on every fetch. That is correct for a backlog and wrong for the transactions you
 * looked at and decided you never want to log. These endpoints are the "I've dealt with this"
 * signal that makes the review queue converge on zero.
 *
 * Nothing here touches the Transaction collection. Ignoring is not logging: an ignored
 * transaction contributes nothing to totals, returns or points. It is only removed from the
 * review queue, and it can always be restored.
 */

const MAX_BATCH = 2000; // a fetch tops out around 2.7k rows; this bounds a malformed request

/**
 * POST /api/teller/ignored
 * Body: { transactions: [{ tellerTransactionId, date, amount, description, paymentMethod }], note? }
 *    or { ids: ["txn_…"], note? }
 *
 * Idempotent: re-ignoring an already-ignored transaction updates its snapshot rather than
 * erroring, so a double-click or a retry is harmless.
 */
exports.ignoreTransactions = async (req, res) => {
  try {
    const { transactions, ids, note } = req.body || {};

    let records;
    if (Array.isArray(transactions) && transactions.length > 0) {
      records = transactions;
    } else if (Array.isArray(ids) && ids.length > 0) {
      records = ids.map((id) => ({ tellerTransactionId: id }));
    } else {
      return res.status(400).json({
        message: 'Provide a non-empty `transactions` array or `ids` array.',
      });
    }

    if (records.length > MAX_BATCH) {
      return res.status(400).json({
        message: `Too many transactions in one request (${records.length}; max ${MAX_BATCH}).`,
      });
    }

    const operations = [];
    const skipped = [];
    for (const t of records) {
      const id = t && t.tellerTransactionId;
      if (!id || typeof id !== 'string') {
        skipped.push(t);
        continue;
      }
      const fields = {
        userId: t.userId || process.env.MONGODB_USERID,
        tellerTransactionId: id,
        date: t.date,
        // Teller sends amounts as strings; store a Number or nothing at all.
        amount: Number.isFinite(Number(t.amount)) ? Number(t.amount) : undefined,
        description: t.description || '',
        paymentMethod: t.paymentMethod || '',
      };

      // Only write `note` when one was actually supplied. Because this is an upsert, an
      // unconditional `$set: { note: '' }` would silently erase the reason recorded the first
      // time round the moment the same row was re-ignored without one — and re-ignoring is
      // expected to be a harmless no-op.
      const incomingNote = (typeof note === 'string' && note.trim())
        ? note.trim()
        : (typeof t.note === 'string' ? t.note.trim() : '');
      if (incomingNote) fields.note = incomingNote;

      operations.push({
        updateOne: {
          filter: { tellerTransactionId: id },
          update: { $set: fields },
          upsert: true,
        },
      });
    }

    if (operations.length === 0) {
      return res.status(400).json({
        message: 'No valid tellerTransactionId values in the request.',
        skipped: skipped.length,
      });
    }

    const result = await IgnoredTransaction.bulkWrite(operations, { ordered: false });
    const ignoredCount = (result.upsertedCount || 0) + (result.modifiedCount || 0)
      + (result.matchedCount || 0);

    console.log(
      `[POST /teller/ignored] requested=${records.length} written=${operations.length} ` +
      `newlyIgnored=${result.upsertedCount || 0} alreadyIgnored=${result.matchedCount || 0} ` +
      `skipped=${skipped.length}`
    );

    res.status(201).json({
      message: `Ignored ${operations.length} transaction(s).`,
      newlyIgnored: result.upsertedCount || 0,
      alreadyIgnored: result.matchedCount || 0,
      skipped: skipped.length,
      total: ignoredCount,
    });
  } catch (err) {
    console.error('Error ignoring transactions:', err);
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/teller/ignored
 * Lists dismissed transactions, newest dismissal first, so the decision is auditable and
 * reversible rather than a black hole.
 */
exports.listIgnoredTransactions = async (req, res) => {
  try {
    const ignored = await IgnoredTransaction.find({}).sort({ createdAt: -1 }).lean();
    res.json({ count: ignored.length, ignored });
  } catch (err) {
    console.error('Error listing ignored transactions:', err);
    res.status(500).json({ message: err.message });
  }
};

/**
 * DELETE /api/teller/ignored
 * Body: { ids: ["txn_…"] }
 *
 * Restores transactions to the review queue. The next fetch will offer them again, because
 * the diff is computed fresh from Teller each time rather than from a stored cursor.
 */
exports.restoreIgnoredTransactions = async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Provide a non-empty `ids` array.' });
    }

    const result = await IgnoredTransaction.deleteMany({ tellerTransactionId: { $in: ids } });
    console.log(`[DELETE /teller/ignored] requested=${ids.length} restored=${result.deletedCount}`);

    res.json({
      message: `Restored ${result.deletedCount} transaction(s) to the review queue.`,
      restored: result.deletedCount,
    });
  } catch (err) {
    console.error('Error restoring ignored transactions:', err);
    res.status(500).json({ message: err.message });
  }
};
