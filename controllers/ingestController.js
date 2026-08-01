const Transaction = require('../models/Transaction');
const {
  buildManualTransaction, deriveTransactionId, parseCardLast4Map,
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
 * Body: a single transaction object, or an array of them, in either of two spellings.
 *
 * The ledger's own:
 *   { amount, date, description, notes?, time?, cardLast4?, transactionType?, paymentMethod?,
 *     category?, purchaseCategory?, points?, needToBePaidback?, allowDuplicate? }
 *
 * Or the names an iOS Shortcut already has for the values it parsed out of a bank alert, which it
 * can then send without a renaming step:
 *   { "DateText": "Jul 29, 2026", "Amount": 168.00,
 *     "Merchant": "WWW.SWAN-DIVEPILATES", "Last4": "8923" }
 *
 * Both are normalised to one shape by normalizeIngestInput() in services/manualTransaction.js; a
 * lowercase key always wins if both are present. Everything absent is derived: `Last4` becomes the
 * payment method, which fixes the amount's sign and its points; the description picks the category.
 */
exports.ingestTransactions = async (req, res) => {
  try {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];

    console.log('items', JSON.stringify(items, null, 2));

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

    // Whose ledger these rows belong to. Fixed to MINID rather than read from the payload: the
    // ingest credential is create-only and lives on a phone, so letting a request name its own
    // userId would let whoever holds that token write into anybody's ledger. One person posts here.
    //
    // Fails closed for the same reason the token checks do — a row with no owner is invisible in
    // every view that filters by user, so it would look like the transaction was simply lost.
    const userId = process.env.MINID;
    if (!userId) {
      console.error('MINID is not set — refusing to write rows with no owner');
      return res.status(503).json({ error: 'Server is not configured for this request' });
    }

    const saved = [];
    const errors = [];

    // Parsed once per request, and passed to BOTH buildManualTransaction calls below. The second
    // one re-derives the whole record for the duplicate path, so options that differ between the two
    // would resolve a retried duplicate onto a different card than the original.
    const cardLast4Map = parseCardLast4Map(process.env.CARD_LAST4_MAP);

    for (const [index, item] of items.entries()) {
      let record;
      try {
        const buildOptions = {
          userId,
          returnIdForMonth,
          source: 'phone',
          cardLast4Map,
        };
        const base = buildManualTransaction(item, buildOptions);
        const ordinal = await resolveOrdinal(
          { date: base.date, amount: base.amount, description: base.description,
            paymentMethod: base.paymentMethod },
          Boolean(item && item.allowDuplicate)
        );
        record = ordinal === 0
          ? base
          : buildManualTransaction(item, { ...buildOptions, ordinal });
      } catch (e) {
        // Validation failures are the sender's to fix, not a 500.
        errors.push({ index, message: e.message });
        continue;
      }

      // Upsert on the derived id, so a retried request updates the same row rather than
      // creating a second one. This is what makes the endpoint safe to call from a phone on a
      // flaky connection.
      //
      // `reviewed` is the one field that must NOT be re-set on update. Two ordinary things send the
      // same transaction twice — a retry over a bad connection, and the second post carrying the
      // category you picked — and either would silently mark an already-reviewed row unreviewed
      // again. $setOnInsert writes it once, when the row is created, and never touches it after.
      const { reviewed, ...mutable } = record;
      const result = await Transaction.findOneAndUpdate(
        { tellerTransactionId: record.tellerTransactionId },
        { $set: mutable, $setOnInsert: { reviewed } },
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
