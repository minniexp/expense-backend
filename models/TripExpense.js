const mongoose = require('mongoose');

/**
 * One cost within a trip.
 *
 * MONEY IS STORED IN INTEGER CENTS. Floats do not add up, and a splitter that loses a cent per
 * expense produces balances that refuse to reconcile by the end of a trip. Dollars are
 * converted at the API boundary only.
 *
 * `splits` is computed by services/expenseSplitter.js and persisted rather than recalculated on
 * read: it is the record of what was agreed at the time. Editing the expense recomputes it.
 */
const splitSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'TripMember', required: true },
  amountCents: { type: Number, required: true },
  breakdown: { type: String, default: '' },
}, { _id: false });

const lineItemSchema = new mongoose.Schema({
  label: { type: String, default: '' },
  amountCents: { type: Number, required: true },
  isShared: { type: Boolean, default: false },
  assignedToMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'TripMember', default: null },
  sharedAmongMemberIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TripMember' }],
}, { _id: false });

const tripExpenseSchema = new mongoose.Schema({
  tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  description: { type: String, required: true, trim: true },
  date: { type: String, required: true },     // YYYY-MM-DD
  amountCents: { type: Number, required: true },
  category: { type: String, default: '' },    // dining / lodging / transport / activity / other

  paidByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'TripMember', required: true },
  splitType: { type: String, enum: ['equal', 'custom', 'itemized', 'by_nights'], required: true },
  splitAmong: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TripMember' }],

  // Type-specific inputs, kept so an expense can be edited without re-entering everything.
  lineItems: { type: [lineItemSchema], default: [] },
  tipCents: { type: Number, default: 0 },
  taxCents: { type: Number, default: 0 },
  guestStays: { type: [{ memberId: mongoose.Schema.Types.ObjectId, nights: Number }], default: [] },
  customSplits: { type: [{ memberId: mongoose.Schema.Types.ObjectId, amountCents: Number }], default: [] },

  // The computed result.
  splits: { type: [splitSchema], default: [] },

  // Optional link to a real transaction already in the ledger, so a Chase charge and the trip
  // expense it funded stay connected. Null for cash and for costs somebody else paid — both
  // entry paths are supported by design.
  linkedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
  tellerTransactionId: { type: String, default: null },

  notes: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.models.TripExpense || mongoose.model('TripExpense', tripExpenseSchema);
