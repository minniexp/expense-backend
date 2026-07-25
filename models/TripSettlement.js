const mongoose = require('mongoose');

/**
 * A payment one member made to another to reduce what they owe.
 *
 * Partial payments are the normal case, not an edge case — people pay back in instalments. So
 * a settlement is simply an amount, and the balance calculation nets them; there is no
 * "settled" flag to keep in sync with reality.
 */
const tripSettlementSchema = new mongoose.Schema({
  tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  fromMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'TripMember', required: true },
  toMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'TripMember', required: true },
  amountCents: { type: Number, required: true },
  date: { type: String, default: '' },   // YYYY-MM-DD
  note: { type: String, default: '' },   // "Venmo 3 Jul"
}, { timestamps: true });

module.exports = mongoose.models.TripSettlement
  || mongoose.model('TripSettlement', tripSettlementSchema);
