const mongoose = require('mongoose');
const TripMember = require('../models/TripMember');
const Trip = require('../models/Trip');
const TripExpense = require('../models/TripExpense');
const TripSettlement = require('../models/TripSettlement');
const {
  toCents, fromCents, computeExpenseSplits, computeTripBalances, simplifyDebts,
} = require('../services/expenseSplitter');

/**
 * Trip expense splitter.
 *
 * BOUNDARY RULE: dollars come in and go out; cents are used everywhere in between. Conversion
 * happens here and nowhere else, so no downstream code has to wonder which unit it holds.
 *
 * The splitter itself (services/expenseSplitter.js) is pure and unit-tested. This layer does
 * persistence and validation only — it deliberately contains no arithmetic beyond conversion.
 */

const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const oops = (res, code, message, extra = {}) => res.status(code).json({ message, ...extra });

/** Present an expense to the client in dollars. */
function expenseOut(e) {
  const o = e.toObject ? e.toObject() : e;
  return {
    ...o,
    amount: fromCents(o.amountCents),
    tip: fromCents(o.tipCents || 0),
    tax: fromCents(o.taxCents || 0),
    lineItems: (o.lineItems || []).map((li) => ({ ...li, amount: fromCents(li.amountCents) })),
    splits: (o.splits || []).map((s) => ({ ...s, amount: fromCents(s.amountCents) })),
  };
}

// ---------------------------------------------------------------------------
// Members (the reusable roster)
// ---------------------------------------------------------------------------

exports.listMembers = async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const members = await TripMember.find(includeArchived ? {} : { archived: false })
      .sort({ name: 1 }).lean();
    res.json(members);
  } catch (err) { oops(res, 500, err.message); }
};

exports.createMember = async (req, res) => {
  try {
    const { name, linkedUserId, color, notes } = req.body || {};
    if (!name || !String(name).trim()) return oops(res, 400, 'A member name is required');
    const member = await TripMember.create({
      name: String(name).trim(), linkedUserId: linkedUserId || null,
      color: color || '', notes: notes || '',
    });
    res.status(201).json(member);
  } catch (err) {
    // The unique index is case-insensitive, so this is how "Sharon" vs "sharon" is caught.
    if (err.code === 11000) return oops(res, 409, `A member named "${req.body.name}" already exists`);
    oops(res, 400, err.message);
  }
};

exports.updateMember = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return oops(res, 400, 'Invalid member id');
    const { name, linkedUserId, color, archived, notes } = req.body || {};
    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (linkedUserId !== undefined) update.linkedUserId = linkedUserId || null;
    if (color !== undefined) update.color = color;
    if (archived !== undefined) update.archived = Boolean(archived);
    if (notes !== undefined) update.notes = notes;
    const member = await TripMember.findByIdAndUpdate(id, update, { new: true, runValidators: true });
    if (!member) return oops(res, 404, 'Member not found');
    res.json(member);
  } catch (err) {
    if (err.code === 11000) return oops(res, 409, 'Another member already has that name');
    oops(res, 400, err.message);
  }
};

/**
 * Members are archived, never deleted, when they appear on a trip.
 *
 * Deleting one would orphan every split and settlement that references them, leaving balances
 * that cannot be explained or reconciled. Archiving hides them from pickers while keeping the
 * history intact.
 */
exports.deleteMember = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return oops(res, 400, 'Invalid member id');
    const inUse = await Trip.countDocuments({ memberIds: id })
      + await TripExpense.countDocuments({ $or: [{ paidByMemberId: id }, { splitAmong: id }] });
    if (inUse > 0) {
      const member = await TripMember.findByIdAndUpdate(id, { archived: true }, { new: true });
      if (!member) return oops(res, 404, 'Member not found');
      return res.json({
        message: 'Member is used by existing trips, so they were archived rather than deleted. '
          + 'Their history stays intact and they no longer appear in pickers.',
        archived: true, member,
      });
    }
    const deleted = await TripMember.findByIdAndDelete(id);
    if (!deleted) return oops(res, 404, 'Member not found');
    res.json({ message: 'Member deleted', archived: false });
  } catch (err) { oops(res, 500, err.message); }
};

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

exports.listTrips = async (req, res) => {
  try {
    const trips = await Trip.find({}).sort({ startDate: -1, createdAt: -1 })
      .populate('memberIds', 'name color archived').lean();

    // Attach a headline total and settled flag so the index page needs one request.
    const ids = trips.map((t) => t._id);
    const expenses = await TripExpense.find({ tripId: { $in: ids } },
      'tripId amountCents paidByMemberId splits').lean();
    const settlements = await TripSettlement.find({ tripId: { $in: ids } },
      'tripId fromMemberId toMemberId amountCents').lean();

    const byTrip = (arr) => arr.reduce((m, x) => {
      (m[String(x.tripId)] = m[String(x.tripId)] || []).push(x); return m;
    }, {});
    const eByTrip = byTrip(expenses), sByTrip = byTrip(settlements);

    res.json(trips.map((t) => {
      const es = eByTrip[String(t._id)] || [];
      const ss = sByTrip[String(t._id)] || [];
      const { totalCents, isFullySettled } = computeTripBalances({
        memberIds: (t.memberIds || []).map((m) => String(m._id)),
        expenses: es, settlements: ss,
      });
      return {
        ...t,
        total: fromCents(totalCents),
        expenseCount: es.length,
        isFullySettled,
      };
    }));
  } catch (err) { oops(res, 500, err.message); }
};

exports.createTrip = async (req, res) => {
  try {
    const { name, description, startDate, endDate, memberIds } = req.body || {};
    if (!name || !String(name).trim()) return oops(res, 400, 'A trip name is required');
    const ids = (memberIds || []).filter(isId);
    if (ids.length > 0) {
      const found = await TripMember.countDocuments({ _id: { $in: ids } });
      if (found !== ids.length) return oops(res, 400, 'One or more members do not exist');
    }
    const trip = await Trip.create({
      name: String(name).trim(), description: description || '',
      startDate: startDate || '', endDate: endDate || '', memberIds: ids,
      createdByUserId: process.env.MONGODB_USERID || null,
    });
    res.status(201).json(trip);
  } catch (err) { oops(res, 400, err.message); }
};

exports.updateTrip = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return oops(res, 400, 'Invalid trip id');
    const { name, description, startDate, endDate, memberIds, status } = req.body || {};
    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (description !== undefined) update.description = description;
    if (startDate !== undefined) update.startDate = startDate;
    if (endDate !== undefined) update.endDate = endDate;
    if (status !== undefined) update.status = status;

    if (memberIds !== undefined) {
      const ids = memberIds.filter(isId).map(String);
      // Removing someone who already appears in an expense would strand their share and break
      // the zero-sum invariant. Refuse rather than corrupt the trip.
      const current = await Trip.findById(id).lean();
      if (!current) return oops(res, 404, 'Trip not found');
      const removed = (current.memberIds || []).map(String).filter((m) => !ids.includes(m));
      if (removed.length) {
        const used = await TripExpense.countDocuments({
          tripId: id, $or: [{ paidByMemberId: { $in: removed } }, { splitAmong: { $in: removed } }],
        });
        if (used > 0) {
          return oops(res, 409,
            'Cannot remove a member who already appears in an expense on this trip. '
            + 'Delete or edit those expenses first.');
        }
      }
      update.memberIds = ids;
    }

    const trip = await Trip.findByIdAndUpdate(id, update, { new: true, runValidators: true });
    if (!trip) return oops(res, 404, 'Trip not found');
    res.json(trip);
  } catch (err) { oops(res, 400, err.message); }
};

exports.deleteTrip = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return oops(res, 400, 'Invalid trip id');
    const trip = await Trip.findByIdAndDelete(id);
    if (!trip) return oops(res, 404, 'Trip not found');
    // Cascade: orphaned expenses would otherwise linger and be counted by nothing.
    const e = await TripExpense.deleteMany({ tripId: id });
    const s = await TripSettlement.deleteMany({ tripId: id });
    res.json({
      message: `Trip deleted, along with ${e.deletedCount} expense(s) and ${s.deletedCount} settlement(s).`,
    });
  } catch (err) { oops(res, 500, err.message); }
};

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/** Build the splitter input from a request body, converting dollars to cents. */
function buildSplitInput(body, trip) {
  const amountCents = toCents(body.amount);
  if (amountCents <= 0) throw new Error('Expense amount must be greater than zero');

  const tripMembers = (trip.memberIds || []).map(String);
  const splitAmong = (body.splitAmong && body.splitAmong.length
    ? body.splitAmong.map(String)
    : tripMembers);

  for (const id of splitAmong) {
    if (!tripMembers.includes(id)) throw new Error('A participant is not a member of this trip');
  }
  if (!tripMembers.includes(String(body.paidByMemberId))) {
    throw new Error('The payer is not a member of this trip');
  }

  return {
    splitType: body.splitType,
    amountCents,
    paidByMemberId: String(body.paidByMemberId),
    splitAmong,
    tipCents: body.tip ? toCents(body.tip) : 0,
    taxCents: body.tax ? toCents(body.tax) : 0,
    lineItems: (body.lineItems || []).map((li) => ({
      label: li.label || '',
      amountCents: toCents(li.amount),
      isShared: Boolean(li.isShared),
      assignedToMemberId: li.assignedToMemberId ? String(li.assignedToMemberId) : undefined,
      sharedAmongMemberIds: (li.sharedAmongMemberIds || []).map(String),
    })),
    guestStays: (body.guestStays || []).map((g) => ({
      memberId: String(g.memberId), nights: Number(g.nights),
    })),
    customSplits: (body.customSplits || []).map((c) => ({
      memberId: String(c.memberId), amountCents: toCents(c.amount),
    })),
  };
}

exports.listExpenses = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isId(tripId)) return oops(res, 400, 'Invalid trip id');
    const expenses = await TripExpense.find({ tripId }).sort({ date: -1, createdAt: -1 }).lean();
    res.json(expenses.map(expenseOut));
  } catch (err) { oops(res, 500, err.message); }
};

exports.createExpense = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isId(tripId)) return oops(res, 400, 'Invalid trip id');
    const trip = await Trip.findById(tripId).lean();
    if (!trip) return oops(res, 404, 'Trip not found');

    const body = req.body || {};
    if (!body.description) return oops(res, 400, 'A description is required');
    if (!body.date) return oops(res, 400, 'A date is required');

    let input, result;
    try {
      input = buildSplitInput(body, trip);
      result = computeExpenseSplits(input);
    } catch (e) {
      // Validation failures from the splitter are the user's problem to fix, not a 500.
      return oops(res, 400, e.message);
    }

    const expense = await TripExpense.create({
      tripId,
      description: String(body.description).trim(),
      date: body.date,
      amountCents: input.amountCents,
      category: body.category || '',
      paidByMemberId: input.paidByMemberId,
      splitType: input.splitType,
      splitAmong: input.splitAmong,
      lineItems: input.lineItems,
      tipCents: input.tipCents,
      taxCents: input.taxCents,
      guestStays: input.guestStays,
      customSplits: input.customSplits,
      splits: result.splits,
      linkedTransactionId: isId(body.linkedTransactionId) ? body.linkedTransactionId : null,
      tellerTransactionId: body.tellerTransactionId || null,
      notes: body.notes || '',
    });

    res.status(201).json(expenseOut(expense));
  } catch (err) { oops(res, 400, err.message); }
};

exports.updateExpense = async (req, res) => {
  try {
    const { tripId, expenseId } = req.params;
    if (!isId(tripId) || !isId(expenseId)) return oops(res, 400, 'Invalid id');
    const trip = await Trip.findById(tripId).lean();
    if (!trip) return oops(res, 404, 'Trip not found');
    const existing = await TripExpense.findOne({ _id: expenseId, tripId });
    if (!existing) return oops(res, 404, 'Expense not found');

    // Merge onto the stored expense so a partial edit does not wipe the split inputs.
    const merged = {
      ...expenseOut(existing),
      ...req.body,
    };

    let input, result;
    try {
      input = buildSplitInput(merged, trip);
      result = computeExpenseSplits(input);   // splits are always recomputed, never trusted from the client
    } catch (e) {
      return oops(res, 400, e.message);
    }

    Object.assign(existing, {
      description: merged.description,
      date: merged.date,
      amountCents: input.amountCents,
      category: merged.category || '',
      paidByMemberId: input.paidByMemberId,
      splitType: input.splitType,
      splitAmong: input.splitAmong,
      lineItems: input.lineItems,
      tipCents: input.tipCents,
      taxCents: input.taxCents,
      guestStays: input.guestStays,
      customSplits: input.customSplits,
      splits: result.splits,
      linkedTransactionId: isId(merged.linkedTransactionId) ? merged.linkedTransactionId : null,
      tellerTransactionId: merged.tellerTransactionId || null,
      notes: merged.notes || '',
    });
    await existing.save();
    res.json(expenseOut(existing));
  } catch (err) { oops(res, 400, err.message); }
};

exports.deleteExpense = async (req, res) => {
  try {
    const { tripId, expenseId } = req.params;
    if (!isId(tripId) || !isId(expenseId)) return oops(res, 400, 'Invalid id');
    const deleted = await TripExpense.findOneAndDelete({ _id: expenseId, tripId });
    if (!deleted) return oops(res, 404, 'Expense not found');
    res.json({ message: 'Expense deleted' });
  } catch (err) { oops(res, 500, err.message); }
};

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

exports.createSettlement = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isId(tripId)) return oops(res, 400, 'Invalid trip id');
    const trip = await Trip.findById(tripId).lean();
    if (!trip) return oops(res, 404, 'Trip not found');

    const { fromMemberId, toMemberId, amount, date, note } = req.body || {};
    if (!isId(fromMemberId) || !isId(toMemberId)) return oops(res, 400, 'Invalid member id');
    if (String(fromMemberId) === String(toMemberId)) {
      return oops(res, 400, 'A member cannot settle with themselves');
    }
    const members = (trip.memberIds || []).map(String);
    if (!members.includes(String(fromMemberId)) || !members.includes(String(toMemberId))) {
      return oops(res, 400, 'Both members must be on this trip');
    }

    let amountCents;
    try { amountCents = toCents(amount); } catch (e) { return oops(res, 400, e.message); }
    if (amountCents <= 0) return oops(res, 400, 'Settlement amount must be greater than zero');

    const settlement = await TripSettlement.create({
      tripId, fromMemberId, toMemberId, amountCents, date: date || '', note: note || '',
    });
    res.status(201).json({ ...settlement.toObject(), amount: fromCents(amountCents) });
  } catch (err) { oops(res, 400, err.message); }
};

exports.listSettlements = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isId(tripId)) return oops(res, 400, 'Invalid trip id');
    const rows = await TripSettlement.find({ tripId }).sort({ createdAt: -1 }).lean();
    res.json(rows.map((s) => ({ ...s, amount: fromCents(s.amountCents) })));
  } catch (err) { oops(res, 500, err.message); }
};

exports.deleteSettlement = async (req, res) => {
  try {
    const { tripId, settlementId } = req.params;
    if (!isId(tripId) || !isId(settlementId)) return oops(res, 400, 'Invalid id');
    const deleted = await TripSettlement.findOneAndDelete({ _id: settlementId, tripId });
    if (!deleted) return oops(res, 404, 'Settlement not found');
    res.json({ message: 'Settlement deleted' });
  } catch (err) { oops(res, 500, err.message); }
};

// ---------------------------------------------------------------------------
// The summary — who paid what, who owes whom
// ---------------------------------------------------------------------------

/**
 * GET /api/trips/:tripId/summary
 *
 * Computed fresh on every request rather than stored. A cached summary is a second source of
 * truth that goes stale the moment an expense is edited, and a stale balance is worse than a
 * slow one.
 */
exports.getTripSummary = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isId(tripId)) return oops(res, 400, 'Invalid trip id');

    const trip = await Trip.findById(tripId).populate('memberIds', 'name color archived').lean();
    if (!trip) return oops(res, 404, 'Trip not found');

    const [expenses, settlements] = await Promise.all([
      TripExpense.find({ tripId }).sort({ date: -1 }).lean(),
      TripSettlement.find({ tripId }).sort({ createdAt: -1 }).lean(),
    ]);

    const memberIds = (trip.memberIds || []).map((m) => String(m._id));
    const nameOf = Object.fromEntries((trip.memberIds || []).map((m) => [String(m._id), m.name]));

    const { balances, totalCents, isFullySettled } = computeTripBalances({
      memberIds, expenses, settlements,
    });

    let transfers = [];
    let transferError = null;
    try {
      transfers = simplifyDebts(balances);
    } catch (e) {
      // Should be impossible — balances are derived and always net to zero. Surface it rather
      // than showing an empty "who pays whom" list that looks like "all settled".
      transferError = e.message;
      console.error('[trip summary] debt simplification failed:', e.message);
    }

    const byCategory = {};
    for (const e of expenses) {
      const key = e.category || 'other';
      byCategory[key] = fromCents(toCents(byCategory[key] || 0) + e.amountCents);
    }

    res.json({
      trip: { ...trip, total: fromCents(totalCents) },
      totals: {
        total: fromCents(totalCents),
        expenseCount: expenses.length,
        byCategory,
      },
      balances: balances.map((b) => ({
        ...b,
        name: nameOf[b.memberId] || 'Unknown',
        paid: fromCents(b.paidCents),
        owes: fromCents(b.owesCents),
        net: fromCents(b.netCents),
      })),
      transfers: transfers.map((t) => ({
        ...t,
        fromName: nameOf[t.fromMemberId] || 'Unknown',
        toName: nameOf[t.toMemberId] || 'Unknown',
        amount: fromCents(t.amountCents),
      })),
      transferError,
      isFullySettled,
      expenses: expenses.map(expenseOut),
      settlements: settlements.map((s) => ({ ...s, amount: fromCents(s.amountCents) })),
    });
  } catch (err) { oops(res, 500, err.message); }
};
