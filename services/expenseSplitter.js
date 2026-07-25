/**
 * Trip expense splitter — who paid what, who owes whom.
 *
 * DESIGN RULE #1: ALL MONEY IS INTEGER CENTS.
 * Dollars are floats and floats do not add up. `0.1 + 0.2 !== 0.3`, and `(100/3).toFixed(2) * 3`
 * is 99.99, not 100. In a splitter that discrepancy is invisible per-expense and compounds over
 * a trip until the balances refuse to reconcile. Cents are converted at the edges and never
 * used for arithmetic in between.
 *
 * DESIGN RULE #2: SPLITS MUST SUM TO THE TOTAL, EXACTLY.
 * Every split function distributes the rounding remainder rather than dropping it, and every
 * one is asserted against its total. If a split cannot be made to reconcile, this module throws
 * instead of returning something plausible — a wrong number that looks right is the worst
 * possible outcome here.
 *
 * DESIGN RULE #3: DETERMINISM.
 * The same inputs always produce the same output, including which person absorbs a leftover
 * cent. Remainders go to participants in sorted-id order, so the result never depends on object
 * key order or array ordering from the database.
 *
 * Pure functions only: no database, no HTTP, no clock. See tests/expenseSplitter.test.js.
 */

const SPLIT_TYPES = ['equal', 'custom', 'itemized', 'by_nights'];

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Convert a dollar amount (number or string, as Teller sends) to integer cents.
 *
 * `Math.round(value * 100)` alone is not enough: 1.005 * 100 is 100.49999999999999 in binary
 * floating point, which rounds to 100 rather than 101. Rounding the scaled value to a few
 * decimals first removes that representation error before the final round.
 */
function toCents(value) {
  // Reject anything that is not explicitly a number or a numeric string BEFORE coercing.
  // JavaScript turns `null`, `''`, `[]` and `false` all into 0, so a missing amount would
  // otherwise sail through as a perfectly valid $0.00 expense — an entire dinner recorded as
  // free, with no error anywhere.
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value.trim());
  } else {
    throw new Error(`Invalid amount: ${JSON.stringify(value)}`);
  }
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid amount: ${JSON.stringify(value)}`);
  }
  return Math.round(Number((n * 100).toFixed(4)));
}

/** Integer cents back to a dollar number with exactly two decimals. */
function fromCents(cents) {
  if (!Number.isInteger(cents)) throw new Error(`Invalid cents: ${JSON.stringify(cents)}`);
  return Number((cents / 100).toFixed(2));
}

// ---------------------------------------------------------------------------
// Even division with remainder
// ---------------------------------------------------------------------------

/**
 * Divide `totalCents` across `memberIds` as evenly as integer cents allow.
 *
 * The remainder is the whole point. $100 across three people is 3333, 3333, 3334 — never
 * 3333 x 3, which silently loses a cent. Extra cents go to the lowest member ids so the result
 * is stable across calls and independent of input ordering.
 *
 * Negative totals (refunds) are handled by splitting the magnitude and re-applying the sign, so
 * a refund distributes the same way the charge did.
 */
function splitEvenly(totalCents, memberIds) {
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw new Error('Cannot split an expense among at least one participant: none given');
  }
  const ids = [...new Set(memberIds.map(String))];
  const sign = totalCents < 0 ? -1 : 1;
  const magnitude = Math.abs(totalCents);

  const base = Math.floor(magnitude / ids.length);
  let remainder = magnitude - base * ids.length;

  // Deterministic: sorted ids receive the leftover cents.
  const order = [...ids].sort();
  const extra = new Set(order.slice(0, remainder));

  return ids.map((memberId) => ({
    memberId,
    amountCents: sign * (base + (extra.has(memberId) ? 1 : 0)),
  }));
}

/**
 * Divide `totalCents` in proportion to per-member weights.
 *
 * Used by by-nights and by tip/tax apportionment. Largest-remainder method: floor every share,
 * then hand the leftover cents to whoever was rounded down hardest. That keeps the sum exact
 * and puts the extra cents where they are least unfair.
 */
function splitByWeight(totalCents, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const totalWeight = entries.reduce((s, [, w]) => s + w, 0);
  if (entries.length === 0 || totalWeight <= 0) {
    throw new Error('Cannot split by weight: total weight is zero');
  }

  const sign = totalCents < 0 ? -1 : 1;
  const magnitude = Math.abs(totalCents);

  const provisional = entries.map(([memberId, w]) => {
    const exact = (magnitude * w) / totalWeight;
    const floor = Math.floor(exact);
    return { memberId, floor, fraction: exact - floor };
  });

  let remainder = magnitude - provisional.reduce((s, p) => s + p.floor, 0);
  // Biggest fractional part first; member id breaks ties so the result is deterministic.
  const order = [...provisional].sort((a, b) =>
    (b.fraction - a.fraction) || a.memberId.localeCompare(b.memberId));
  const bonus = new Set();
  for (let i = 0; i < remainder; i++) bonus.add(order[i % order.length].memberId);

  return provisional.map((p) => ({
    memberId: p.memberId,
    amountCents: sign * (p.floor + (bonus.has(p.memberId) ? 1 : 0)),
  }));
}

/** Fold duplicate member entries together and drop zero shares. */
function consolidate(parts) {
  const totals = new Map();
  const reasons = new Map();
  for (const { memberId, amountCents, reason } of parts) {
    totals.set(memberId, (totals.get(memberId) || 0) + amountCents);
    if (reason) {
      const list = reasons.get(memberId) || [];
      list.push(reason);
      reasons.set(memberId, list);
    }
  }
  return [...totals.entries()]
    .filter(([, cents]) => cents !== 0)
    .map(([memberId, amountCents]) => ({
      memberId,
      amountCents,
      breakdown: (reasons.get(memberId) || []).join(' + ') || 'Share',
    }))
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
}

// ---------------------------------------------------------------------------
// Split calculation
// ---------------------------------------------------------------------------

/**
 * Work out what each participant owes for one expense.
 *
 * @param {object} args
 * @param {'equal'|'custom'|'itemized'|'by_nights'} args.splitType
 * @param {number} args.amountCents        the expense total, in cents
 * @param {string} args.paidByMemberId     who actually paid (may or may not be a participant)
 * @param {string[]} [args.splitAmong]     participants; required except for `custom`
 * @param {Array}  [args.lineItems]        itemized: {label, amountCents, assignedToMemberId | isShared, sharedAmongMemberIds}
 * @param {number} [args.tipCents]         itemized: apportioned pro-rata
 * @param {number} [args.taxCents]         itemized: apportioned pro-rata
 * @param {Array}  [args.guestStays]       by_nights: {memberId, nights}
 * @param {Array}  [args.customSplits]     custom: {memberId, amountCents} — must sum to the total
 * @returns {{splits: Array<{memberId,amountCents,breakdown}>, warnings: string[]}}
 */
function computeExpenseSplits(args) {
  const {
    splitType, amountCents, paidByMemberId, splitAmong = [],
    lineItems = [], tipCents = 0, taxCents = 0, guestStays = [], customSplits = [],
  } = args || {};

  if (!SPLIT_TYPES.includes(splitType)) {
    throw new Error(`Unknown split type: ${JSON.stringify(splitType)}`);
  }
  if (!Number.isInteger(amountCents)) {
    throw new Error('amountCents must be an integer number of cents');
  }
  if (!paidByMemberId) throw new Error('paidByMemberId is required');

  const participants = [...new Set(splitAmong.map(String))];
  const warnings = [];
  let splits;

  if (splitType === 'equal') {
    splits = consolidate(splitEvenly(amountCents, participants)
      .map((s) => ({ ...s, reason: 'Equal share' })));

  } else if (splitType === 'custom') {
    const total = customSplits.reduce((s, c) => s + c.amountCents, 0);
    if (total !== amountCents) {
      // Never reconcile this silently: the difference is money that would vanish or appear.
      throw new Error(
        `Custom splits must sum to the total: got ${fromCents(total)}, expected ${fromCents(amountCents)}`
      );
    }
    splits = consolidate(customSplits.map((c) => ({
      memberId: String(c.memberId), amountCents: c.amountCents, reason: 'Custom amount',
    })));

  } else if (splitType === 'itemized') {
    if (lineItems.length === 0) throw new Error('Itemized split requires at least one line item');

    const subtotal = lineItems.reduce((s, li) => s + li.amountCents, 0);
    if (subtotal + tipCents + taxCents !== amountCents) {
      throw new Error(
        `Line items do not reconcile with the total: items ${fromCents(subtotal)} + tip ` +
        `${fromCents(tipCents)} + tax ${fromCents(taxCents)} != ${fromCents(amountCents)}`
      );
    }

    const parts = [];
    for (const li of lineItems) {
      if (li.assignedToMemberId) {
        const id = String(li.assignedToMemberId);
        if (participants.length && !participants.includes(id)) {
          throw new Error(`Line item "${li.label}" is assigned to a non-participant member`);
        }
        parts.push({ memberId: id, amountCents: li.amountCents, reason: li.label });
      } else {
        const among = (li.sharedAmongMemberIds && li.sharedAmongMemberIds.length)
          ? li.sharedAmongMemberIds.map(String) : participants;
        for (const bad of among) {
          if (participants.length && !participants.includes(bad)) {
            throw new Error(`Line item "${li.label}" is shared with a non-participant member`);
          }
        }
        splitEvenly(li.amountCents, among)
          .forEach((s) => parts.push({ ...s, reason: `${li.label} (shared)` }));
      }
    }

    // Tip and tax follow what each person actually ordered. Splitting them equally would
    // overcharge whoever ordered least, which is the usual complaint about itemized bills.
    const extras = tipCents + taxCents;
    if (extras !== 0) {
      const weights = {};
      for (const p of parts) weights[p.memberId] = (weights[p.memberId] || 0) + p.amountCents;
      splitByWeight(extras, weights)
        .forEach((s) => parts.push({ ...s, reason: 'tip/tax share' }));
    }
    splits = consolidate(parts);

  } else { // by_nights
    if (guestStays.length === 0) throw new Error('A by-nights split requires guest stays');
    const weights = {};
    for (const g of guestStays) {
      const id = String(g.memberId);
      if (participants.length && !participants.includes(id)) {
        throw new Error(`Guest stay refers to a non-participant member: ${id}`);
      }
      const nights = Number(g.nights);
      if (!Number.isFinite(nights) || nights < 0) {
        throw new Error(`Invalid nights for member ${id}: ${JSON.stringify(g.nights)}`);
      }
      weights[id] = (weights[id] || 0) + nights;
    }
    const totalNights = Object.values(weights).reduce((s, n) => s + n, 0);
    if (totalNights <= 0) {
      throw new Error('A by-nights split needs at least one night across all guests');
    }
    splits = consolidate(splitByWeight(amountCents, weights).map((s) => ({
      ...s, reason: `${weights[s.memberId]} night${weights[s.memberId] === 1 ? '' : 's'}`,
    })));
  }

  // The invariant, enforced rather than assumed. If this ever fires it is a bug in the branch
  // above, and failing loudly beats returning a total that does not add up.
  const sum = splits.reduce((s, x) => s + x.amountCents, 0);
  if (sum !== amountCents) {
    throw new Error(
      `Internal error: splits sum to ${fromCents(sum)} but the expense is ${fromCents(amountCents)}`
    );
  }

  return { splits, warnings };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * Roll expenses and settlements up into a per-member position.
 *
 *   net = (what they paid out) - (their share of the spending)
 *       + (settlements they have paid) - (settlements they have received)
 *
 * Positive net means the group owes them. Negative means they owe the group. Across all
 * members the net always sums to zero — that is the invariant the tests check hardest,
 * because a non-zero sum means money was invented or lost somewhere upstream.
 */
function computeTripBalances({ memberIds = [], expenses = [], settlements = [] } = {}) {
  const ids = [...new Set(memberIds.map(String))];
  const paid = Object.fromEntries(ids.map((id) => [id, 0]));
  const owes = Object.fromEntries(ids.map((id) => [id, 0]));
  const settledOut = Object.fromEntries(ids.map((id) => [id, 0]));
  const settledIn = Object.fromEntries(ids.map((id) => [id, 0]));

  const ensure = (id) => {
    if (!(id in paid)) { paid[id] = 0; owes[id] = 0; settledOut[id] = 0; settledIn[id] = 0; }
  };

  let totalCents = 0;
  for (const e of expenses) {
    const payer = String(e.paidByMemberId);
    ensure(payer);
    paid[payer] += e.amountCents;
    totalCents += e.amountCents;
    for (const s of e.splits || []) {
      const id = String(s.memberId);
      ensure(id);
      owes[id] += s.amountCents;
    }
  }

  for (const s of settlements) {
    const from = String(s.fromMemberId), to = String(s.toMemberId);
    ensure(from); ensure(to);
    settledOut[from] += s.amountCents;
    settledIn[to] += s.amountCents;
  }

  const balances = Object.keys(paid).sort().map((memberId) => {
    const netCents = paid[memberId] - owes[memberId] + settledOut[memberId] - settledIn[memberId];
    return {
      memberId,
      paidCents: paid[memberId],
      owesCents: owes[memberId],
      settledOutCents: settledOut[memberId],
      settledInCents: settledIn[memberId],
      netCents,
      status: netCents === 0 ? 'settled' : (netCents > 0 ? 'owed' : 'owes'),
    };
  });

  return {
    balances,
    totalCents,
    isFullySettled: balances.every((b) => b.netCents === 0),
  };
}

// ---------------------------------------------------------------------------
// Debt simplification
// ---------------------------------------------------------------------------

/**
 * Turn a set of balances into the fewest payments that clear them.
 *
 * Without this, a trip produces a payment for every expense pair — "you owe me $12 for lunch,
 * I owe you $8 for petrol, you owe me $30 for the taxi". Netting first and then greedily
 * matching the largest creditor against the largest debtor produces at most n-1 transfers
 * instead.
 *
 * Greedy largest-first is not guaranteed to find the theoretical minimum number of transfers
 * (that problem is NP-hard), but it is optimal in the common cases, always terminates, and
 * always clears every balance exactly — which matters far more here than shaving off one
 * hypothetical payment.
 */
function simplifyDebts(balances) {
  const total = balances.reduce((s, b) => s + b.netCents, 0);
  if (total !== 0) {
    // Refusing beats emitting transfers that leave someone short.
    throw new Error(`Balances do not sum to zero (off by ${fromCents(total)}) — cannot settle`);
  }

  // Sorted by id first so equal amounts resolve deterministically.
  const creditors = balances.filter((b) => b.netCents > 0)
    .map((b) => ({ id: String(b.memberId), amount: b.netCents }))
    .sort((a, b) => (b.amount - a.amount) || a.id.localeCompare(b.id));
  const debtors = balances.filter((b) => b.netCents < 0)
    .map((b) => ({ id: String(b.memberId), amount: -b.netCents }))
    .sort((a, b) => (b.amount - a.amount) || a.id.localeCompare(b.id));

  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci], d = debtors[di];
    const amount = Math.min(c.amount, d.amount);
    if (amount > 0 && c.id !== d.id) {
      transfers.push({ fromMemberId: d.id, toMemberId: c.id, amountCents: amount });
    }
    c.amount -= amount;
    d.amount -= amount;
    if (c.amount === 0) ci++;
    if (d.amount === 0) di++;
  }

  return transfers;
}

module.exports = {
  SPLIT_TYPES,
  toCents,
  fromCents,
  splitEvenly,
  splitByWeight,
  computeExpenseSplits,
  computeTripBalances,
  simplifyDebts,
};
