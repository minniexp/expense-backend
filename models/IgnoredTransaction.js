const mongoose = require('mongoose');

/**
 * A Teller transaction the user has reviewed and deliberately dismissed.
 *
 * The sync answers "what does Chase have that my ledger does not?" by set-differencing on
 * `tellerTransactionId`. That is self-healing — anything unsaved keeps coming back — which is
 * exactly right for transactions you have not got to yet, and exactly wrong for the ones you
 * looked at and decided you never want. Without this collection, every transaction you choose
 * not to log reappears on every future fetch, forever.
 *
 * Two rules this model exists to enforce:
 *
 *   1. **Ignoring is reversible.** Rows are kept, not deleted, so the dismissed set can be
 *      listed and restored. Silently dropping financial records with no way to audit what was
 *      dropped is how money goes missing unnoticed.
 *   2. **It never substitutes for the ledger.** An ignored transaction is NOT logged income or
 *      expense; it does not appear in totals, returns or points. It is only removed from the
 *      review queue.
 *
 * A snapshot of the transaction is stored alongside the id so the ignored list is readable on
 * its own, without a round-trip to Teller — and so it still makes sense if the transaction
 * ages out of Teller's window entirely.
 */
const ignoredTransactionSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: false
  },
  tellerTransactionId: {
    type: String,
    required: true,
    unique: true,   // one row per transaction; re-ignoring is an idempotent upsert
    index: true
  },

  // --- snapshot of the transaction at the moment it was dismissed ---
  date: {
    type: String,
    required: false
  },
  amount: {
    type: Number,
    required: false
  },
  description: {
    type: String,
    default: ''
  },
  paymentMethod: {
    type: String,
    default: ''
  },

  // Why it was dismissed. Free text, entirely optional — but it is the only thing that will
  // explain the decision to you in six months.
  note: {
    type: String,
    default: ''
  }
}, {
  timestamps: true   // createdAt doubles as "when did I ignore this"
});

module.exports = mongoose.model('IgnoredTransaction', ignoredTransactionSchema);
