const mongoose = require('mongoose');

/**
 * Monthly allowances, one document per person.
 *
 * A Map rather than a fixed set of fields because the categories are the purchase categories, and
 * those change: adding one should not need a migration. A category with no entry simply budgets
 * nothing, which is the honest default — it is not the same as budgeting zero deliberately, but the
 * arithmetic is identical and inventing a distinction would only complicate the UI.
 *
 * Amounts are dollars, not cents. The trip splitter uses cents because it divides money between
 * people and a lost cent refuses to reconcile; a budget is only ever compared against a total, so
 * the extra conversion would buy nothing.
 */
const budgetSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  monthly: { type: Map, of: Number, default: {} },
}, { timestamps: true });

module.exports = mongoose.model('Budget', budgetSchema);
