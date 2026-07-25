const mongoose = require('mongoose');

/** A trip: the container everything is split within. */
const tripSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  startDate: { type: String, default: '' },  // YYYY-MM-DD, consistent with Transaction.date
  endDate: { type: String, default: '' },
  // Participants, drawn from the reusable roster. Members can be added later; expenses keep
  // their own splitAmong list, so adding someone never silently rewrites past splits.
  memberIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TripMember' }],
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  createdByUserId: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.models.Trip || mongoose.model('Trip', tripSchema);
