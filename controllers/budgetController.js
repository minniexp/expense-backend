const Budget = require('../models/Budget');
const Transaction = require('../models/Transaction');
const { summariseBudgets } = require('../services/budgetSummary');

/** Whose budget. The same person the ingest path writes for. */
const ownerId = (req) => (req.user && req.user.userId) || process.env.MINID;

/** GET /api/budgets — the monthly allowance for each budget category. */
exports.getBudgets = async (req, res) => {
  try {
    const doc = await Budget.findOne({ userId: ownerId(req) }).lean();
    res.json({ monthly: (doc && doc.monthly) || {} });
  } catch (err) {
    console.error('Error reading budgets:', err);
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /api/budgets   Body: { monthly: { travel: 300, ... } }
 *
 * Replaces the whole map. A partial merge would leave no way to remove a category, and the caller
 * always holds the complete set — it just rendered it.
 */
exports.putBudgets = async (req, res) => {
  try {
    const incoming = (req.body && req.body.monthly) || {};
    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ message: 'Send { monthly: { category: amount } }' });
    }

    const monthly = {};
    for (const [name, value] of Object.entries(incoming)) {
      const amount = Number(value);
      // A category budgeted NaN would poison every total it appears in, silently.
      if (!name.trim() || !Number.isFinite(amount) || amount < 0) continue;
      monthly[name.trim()] = Math.round(amount * 100) / 100;
    }

    const doc = await Budget.findOneAndUpdate(
      { userId: ownerId(req) },
      { $set: { monthly } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({ monthly: doc.monthly || {} });
  } catch (err) {
    console.error('Error saving budgets:', err);
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/budgets/summary?year=&month=
 *
 * Computed here rather than in the browser because `accumulated` needs every transaction since
 * January, and the arithmetic is unit-tested where a component would not be.
 */
exports.getSummary = async (req, res) => {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || now.getMonth() + 1;

    const [doc, transactions] = await Promise.all([
      Budget.findOne({ userId: ownerId(req) }).lean(),
      Transaction.find({ year, month: { $lte: month }, transactionType: 'expense' })
        .select('year month amount transactionType category')
        .lean(),
    ]);

    const monthly = doc && doc.monthly ? Object.fromEntries(Object.entries(doc.monthly)) : {};
    res.json(summariseBudgets({ transactions, budgets: monthly, year, month }));
  } catch (err) {
    console.error('Error building budget summary:', err);
    res.status(500).json({ message: err.message });
  }
};
