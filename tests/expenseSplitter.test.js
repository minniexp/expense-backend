/**
 * Tests for the trip expense splitter.
 *
 * THE INVARIANT EVERYTHING ELSE SERVES: splits must sum to the expense total, and balances
 * must sum to zero. A splitter that loses or invents a cent is worse than no splitter, because
 * the error is small enough to go unnoticed and compounds across a trip.
 *
 * All money is handled in integer cents internally. Dollars are floats, and floats do not add
 * up — 0.1 + 0.2 !== 0.3 — which is exactly how a "$0.01 unaccounted" bug is born.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  toCents,
  fromCents,
  splitEvenly,
  computeExpenseSplits,
  computeTripBalances,
  simplifyDebts,
} = require('../services/expenseSplitter');

// --- helpers --------------------------------------------------------------------------------

const A = 'mem_alice', B = 'mem_bob', C = 'mem_carol', D = 'mem_dave';
const sumOf = (splits) => splits.reduce((s, x) => s + x.amountCents, 0);
const byMember = (splits) => Object.fromEntries(splits.map((s) => [s.memberId, s.amountCents]));

// --- money conversion -------------------------------------------------------------------------

test('toCents handles the float cases that break naive money code', () => {
  assert.strictEqual(toCents(0.1), 10);
  assert.strictEqual(toCents(0.2), 20);
  assert.strictEqual(toCents(1.005), 101, '1.005 must not round down via float error');
  assert.strictEqual(toCents(19.99), 1999);
  assert.strictEqual(toCents('19.99'), 1999, 'Teller sends amounts as strings');
  assert.strictEqual(toCents(-8.55), -855);
  assert.strictEqual(toCents(0), 0);
});

test('toCents rejects values that are not money', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'abc', null, undefined, {}]) {
    assert.throws(() => toCents(bad), /amount/i, `${JSON.stringify(bad)} must throw`);
  }
});

test('fromCents round-trips', () => {
  for (const v of [0, 1, 999, 100000, -855]) {
    assert.strictEqual(toCents(fromCents(v)), v);
  }
  assert.strictEqual(fromCents(1999), 19.99);
});

// --- even split with remainder ------------------------------------------------------------------

test('an evenly divisible amount splits exactly', () => {
  const out = splitEvenly(12000, [A, B, C, D]);
  assert.deepStrictEqual(Object.values(byMember(out)), [3000, 3000, 3000, 3000]);
  assert.strictEqual(sumOf(out), 12000);
});

test('THE ROUNDING CASE: an indivisible amount still sums to the total', () => {
  // $100 across 3 people is 33.333... Naive rounding gives 33.33 x 3 = 99.99 and loses a cent.
  const out = splitEvenly(10000, [A, B, C]);
  assert.strictEqual(sumOf(out), 10000, 'not one cent may be lost');
  const amounts = Object.values(byMember(out)).sort();
  assert.deepStrictEqual(amounts, [3333, 3333, 3334], 'the extra cent goes to exactly one person');
});

test('remainder distribution is deterministic, not random', () => {
  const a = splitEvenly(10000, [A, B, C]);
  const b = splitEvenly(10000, [C, B, A]);   // same people, different order
  assert.deepStrictEqual(byMember(a), byMember(b),
    'the same set of people must always produce the same split');
});

test('remainder spreads across several people when it exceeds one cent', () => {
  const out = splitEvenly(10001, [A, B, C, D]); // 100.01 / 4 = 25.0025
  assert.strictEqual(sumOf(out), 10001);
  const counts = Object.values(byMember(out));
  assert.strictEqual(counts.filter((c) => c === 2501).length, 1);
  assert.strictEqual(counts.filter((c) => c === 2500).length, 3);
});

test('a negative total (a refund) splits without losing a cent', () => {
  const out = splitEvenly(-10000, [A, B, C]);
  assert.strictEqual(sumOf(out), -10000);
});

test('splitting among one person gives them everything', () => {
  const out = splitEvenly(9999, [A]);
  assert.deepStrictEqual(byMember(out), { [A]: 9999 });
});

test('splitting among nobody throws rather than silently dropping the money', () => {
  assert.throws(() => splitEvenly(1000, []), /at least one/i);
});

// --- equal split ---------------------------------------------------------------------------------

test('equal split assigns every participant a share', () => {
  const { splits } = computeExpenseSplits({
    splitType: 'equal', amountCents: 12000, paidByMemberId: A, splitAmong: [A, B, C, D],
  });
  assert.strictEqual(sumOf(splits), 12000);
  assert.strictEqual(splits.length, 4);
  assert.ok(splits.every((s) => s.breakdown));
});

test('the payer still owes their own share', () => {
  // A common misunderstanding: paying does not exempt you from your portion.
  const { splits } = computeExpenseSplits({
    splitType: 'equal', amountCents: 10000, paidByMemberId: A, splitAmong: [A, B],
  });
  assert.strictEqual(byMember(splits)[A], 5000);
});

test('the payer need not be a participant', () => {
  // Someone can pay for a meal they did not eat.
  const { splits } = computeExpenseSplits({
    splitType: 'equal', amountCents: 9000, paidByMemberId: D, splitAmong: [A, B, C],
  });
  assert.strictEqual(byMember(splits)[D], undefined);
  assert.strictEqual(sumOf(splits), 9000);
});

// --- custom split ----------------------------------------------------------------------------------

test('custom split uses the exact amounts given', () => {
  const { splits } = computeExpenseSplits({
    splitType: 'custom', amountCents: 50000, paidByMemberId: A,
    customSplits: [{ memberId: A, amountCents: 20000 }, { memberId: B, amountCents: 15000 },
                   { memberId: C, amountCents: 15000 }],
  });
  assert.deepStrictEqual(byMember(splits), { [A]: 20000, [B]: 15000, [C]: 15000 });
});

test('custom split that does not sum to the total is REJECTED', () => {
  // Accepting this would silently create or destroy money.
  assert.throws(() => computeExpenseSplits({
    splitType: 'custom', amountCents: 50000, paidByMemberId: A,
    customSplits: [{ memberId: A, amountCents: 20000 }, { memberId: B, amountCents: 10000 }],
  }), /sum|match|total/i);
});

test('custom split off by a single cent is still rejected', () => {
  assert.throws(() => computeExpenseSplits({
    splitType: 'custom', amountCents: 10000, paidByMemberId: A,
    customSplits: [{ memberId: A, amountCents: 5000 }, { memberId: B, amountCents: 4999 }],
  }), /sum|match|total/i);
});

// --- itemized split -----------------------------------------------------------------------------------

test('itemized: assigned items go to their owner, shared items split', () => {
  const { splits } = computeExpenseSplits({
    splitType: 'itemized', amountCents: 6000, paidByMemberId: A, splitAmong: [A, B, C],
    lineItems: [
      { label: 'Steak',      amountCents: 3000, assignedToMemberId: B },
      { label: 'Salad',      amountCents: 1500, assignedToMemberId: C },
      { label: 'Wine',       amountCents: 1500, isShared: true },
    ],
  });
  const m = byMember(splits);
  assert.strictEqual(m[B], 3000 + 500);
  assert.strictEqual(m[C], 1500 + 500);
  assert.strictEqual(m[A], 500);
  assert.strictEqual(sumOf(splits), 6000);
});

test('itemized: a shared item can be limited to a subset', () => {
  const { splits } = computeExpenseSplits({
    splitType: 'itemized', amountCents: 3000, paidByMemberId: A, splitAmong: [A, B, C],
    lineItems: [
      { label: 'Bottle', amountCents: 2000, isShared: true, sharedAmongMemberIds: [A, B] },
      { label: 'Coffee', amountCents: 1000, assignedToMemberId: C },
    ],
  });
  assert.deepStrictEqual(byMember(splits), { [A]: 1000, [B]: 1000, [C]: 1000 });
});

test('itemized: tip and tax are apportioned in proportion to what each person ordered', () => {
  // Splitting tax equally would overcharge whoever ordered least.
  const { splits } = computeExpenseSplits({
    splitType: 'itemized', amountCents: 12000, paidByMemberId: A, splitAmong: [A, B],
    lineItems: [
      { label: 'Expensive', amountCents: 7500, assignedToMemberId: A },
      { label: 'Cheap',     amountCents: 2500, assignedToMemberId: B },
    ],
    tipCents: 1500, taxCents: 500,
  });
  const m = byMember(splits);
  assert.strictEqual(sumOf(splits), 12000);
  assert.strictEqual(m[A], 9000, 'A ordered 75% of the food so carries 75% of tip+tax');
  assert.strictEqual(m[B], 3000);
});

test('itemized: line items that do not reconcile with the total are rejected', () => {
  assert.throws(() => computeExpenseSplits({
    splitType: 'itemized', amountCents: 9999, paidByMemberId: A, splitAmong: [A, B],
    lineItems: [{ label: 'X', amountCents: 1000, isShared: true }],
  }), /line item|reconcile|total/i);
});

test('itemized: an item assigned to a non-participant is rejected', () => {
  assert.throws(() => computeExpenseSplits({
    splitType: 'itemized', amountCents: 1000, paidByMemberId: A, splitAmong: [A, B],
    lineItems: [{ label: 'X', amountCents: 1000, assignedToMemberId: D }],
  }), /participant|member/i);
});

// --- by-nights split ---------------------------------------------------------------------------------

test('by-nights: cost is weighted by how many nights each guest stayed', () => {
  // $900, 3 nights. Alice 3, Bob 3, Carol 2 => 8 guest-nights => 112.50/night-person.
  const { splits } = computeExpenseSplits({
    splitType: 'by_nights', amountCents: 90000, paidByMemberId: A, splitAmong: [A, B, C],
    guestStays: [{ memberId: A, nights: 3 }, { memberId: B, nights: 3 }, { memberId: C, nights: 2 }],
  });
  const m = byMember(splits);
  assert.strictEqual(sumOf(splits), 90000);
  assert.strictEqual(m[A], 33750);
  assert.strictEqual(m[B], 33750);
  assert.strictEqual(m[C], 22500);
});

test('by-nights: an indivisible total still reconciles exactly', () => {
  const { splits } = computeExpenseSplits({
    splitType: 'by_nights', amountCents: 10000, paidByMemberId: A, splitAmong: [A, B, C],
    guestStays: [{ memberId: A, nights: 1 }, { memberId: B, nights: 1 }, { memberId: C, nights: 1 }],
  });
  assert.strictEqual(sumOf(splits), 10000);
});

test('by-nights: equal nights is equivalent to an equal split', () => {
  const nights = computeExpenseSplits({
    splitType: 'by_nights', amountCents: 30000, paidByMemberId: A, splitAmong: [A, B, C],
    guestStays: [{ memberId: A, nights: 2 }, { memberId: B, nights: 2 }, { memberId: C, nights: 2 }],
  });
  const equal = computeExpenseSplits({
    splitType: 'equal', amountCents: 30000, paidByMemberId: A, splitAmong: [A, B, C],
  });
  assert.deepStrictEqual(byMember(nights.splits), byMember(equal.splits));
});

test('by-nights: a guest with zero nights owes nothing', () => {
  const { splits } = computeExpenseSplits({
    splitType: 'by_nights', amountCents: 20000, paidByMemberId: A, splitAmong: [A, B, C],
    guestStays: [{ memberId: A, nights: 2 }, { memberId: B, nights: 2 }, { memberId: C, nights: 0 }],
  });
  assert.strictEqual(byMember(splits)[C] || 0, 0);
  assert.strictEqual(sumOf(splits), 20000);
});

test('by-nights: zero total guest-nights is rejected rather than dividing by zero', () => {
  assert.throws(() => computeExpenseSplits({
    splitType: 'by_nights', amountCents: 20000, paidByMemberId: A, splitAmong: [A, B],
    guestStays: [{ memberId: A, nights: 0 }, { memberId: B, nights: 0 }],
  }), /night/i);
});

// --- balances --------------------------------------------------------------------------------------------

test('balances: the classic case — one person pays, everyone shares', () => {
  const { balances } = computeTripBalances({
    memberIds: [A, B, C],
    expenses: [{ amountCents: 30000, paidByMemberId: A,
                 splits: [{ memberId: A, amountCents: 10000 }, { memberId: B, amountCents: 10000 },
                          { memberId: C, amountCents: 10000 }] }],
    settlements: [],
  });
  const m = Object.fromEntries(balances.map((b) => [b.memberId, b]));
  assert.strictEqual(m[A].netCents, 20000, 'A is owed what they covered for others');
  assert.strictEqual(m[B].netCents, -10000);
  assert.strictEqual(m[C].netCents, -10000);
  assert.strictEqual(m[A].status, 'owed');
  assert.strictEqual(m[B].status, 'owes');
});

test('THE ZERO-SUM INVARIANT: balances always sum to zero', () => {
  const { balances } = computeTripBalances({
    memberIds: [A, B, C, D],
    expenses: [
      { amountCents: 10000, paidByMemberId: A, splits: [{ memberId: A, amountCents: 3333 }, { memberId: B, amountCents: 3333 }, { memberId: C, amountCents: 3334 }] },
      { amountCents: 7777,  paidByMemberId: B, splits: [{ memberId: B, amountCents: 2592 }, { memberId: C, amountCents: 2592 }, { memberId: D, amountCents: 2593 }] },
      { amountCents: 45,    paidByMemberId: D, splits: [{ memberId: A, amountCents: 15 }, { memberId: B, amountCents: 15 }, { memberId: D, amountCents: 15 }] },
    ],
    settlements: [{ fromMemberId: B, toMemberId: A, amountCents: 1234 }],
  });
  assert.strictEqual(balances.reduce((s, b) => s + b.netCents, 0), 0,
    'money can neither be created nor destroyed');
});

test('a settlement moves the balance and can fully clear a debt', () => {
  const args = {
    memberIds: [A, B],
    expenses: [{ amountCents: 10000, paidByMemberId: A,
                 splits: [{ memberId: A, amountCents: 5000 }, { memberId: B, amountCents: 5000 }] }],
  };
  const before = computeTripBalances({ ...args, settlements: [] });
  assert.strictEqual(before.balances.find((b) => b.memberId === B).netCents, -5000);

  const after = computeTripBalances({
    ...args, settlements: [{ fromMemberId: B, toMemberId: A, amountCents: 5000 }],
  });
  assert.ok(after.balances.every((b) => b.netCents === 0));
  assert.strictEqual(after.isFullySettled, true);
});

test('a PARTIAL settlement leaves the remainder outstanding', () => {
  const { balances, isFullySettled } = computeTripBalances({
    memberIds: [A, B],
    expenses: [{ amountCents: 10000, paidByMemberId: A,
                 splits: [{ memberId: A, amountCents: 5000 }, { memberId: B, amountCents: 5000 }] }],
    settlements: [{ fromMemberId: B, toMemberId: A, amountCents: 2000 }],
  });
  assert.strictEqual(balances.find((b) => b.memberId === B).netCents, -3000);
  assert.strictEqual(isFullySettled, false);
});

test('totalPaid and totalOwes are reported separately from the net', () => {
  const { balances } = computeTripBalances({
    memberIds: [A, B],
    expenses: [{ amountCents: 10000, paidByMemberId: A,
                 splits: [{ memberId: A, amountCents: 5000 }, { memberId: B, amountCents: 5000 }] }],
    settlements: [],
  });
  const a = balances.find((b) => b.memberId === A);
  assert.strictEqual(a.paidCents, 10000, 'how much they actually paid out');
  assert.strictEqual(a.owesCents, 5000, 'their share of the spending');
  assert.strictEqual(a.netCents, 5000);
});

test('a member with no activity appears with a zero balance', () => {
  const { balances } = computeTripBalances({ memberIds: [A, B, C], expenses: [], settlements: [] });
  assert.strictEqual(balances.length, 3);
  assert.ok(balances.every((b) => b.netCents === 0 && b.status === 'settled'));
});

// --- debt simplification ---------------------------------------------------------------------------------

test('debt simplification produces transfers that clear every balance', () => {
  const balances = [
    { memberId: A, netCents: 26533 },
    { memberId: B, netCents: 119033 },
    { memberId: C, netCents: -145566 },
  ];
  const transfers = simplifyDebts(balances);
  const net = Object.fromEntries(balances.map((b) => [b.memberId, b.netCents]));
  for (const t of transfers) { net[t.fromMemberId] += t.amountCents; net[t.toMemberId] -= t.amountCents; }
  assert.ok(Object.values(net).every((v) => v === 0), 'every balance must land on zero');
});

test('THE POINT OF SIMPLIFICATION: fewer transfers than naive pairwise debts', () => {
  // Four people, everyone owed by everyone: naive is 6 transfers, minimised is at most 3.
  const balances = [
    { memberId: A, netCents: 15000 }, { memberId: B, netCents: 5000 },
    { memberId: C, netCents: -8000 }, { memberId: D, netCents: -12000 },
  ];
  const transfers = simplifyDebts(balances);
  assert.ok(transfers.length <= 3, `expected <= 3 transfers, got ${transfers.length}`);
  assert.ok(transfers.every((t) => t.amountCents > 0), 'no zero or negative transfers');
});

test('nobody pays themselves', () => {
  const transfers = simplifyDebts([
    { memberId: A, netCents: 5000 }, { memberId: B, netCents: -5000 },
  ]);
  assert.ok(transfers.every((t) => t.fromMemberId !== t.toMemberId));
});

test('an already-settled group needs no transfers', () => {
  assert.deepStrictEqual(simplifyDebts([
    { memberId: A, netCents: 0 }, { memberId: B, netCents: 0 },
  ]), []);
});

test('simplification is deterministic', () => {
  const balances = [
    { memberId: A, netCents: 10000 }, { memberId: B, netCents: 10000 },
    { memberId: C, netCents: -20000 },
  ];
  assert.deepStrictEqual(simplifyDebts(balances), simplifyDebts([...balances].reverse()),
    'the same balances must always produce the same instructions');
});

test('simplification never invents money', () => {
  const balances = [
    { memberId: A, netCents: 3333 }, { memberId: B, netCents: 3333 },
    { memberId: C, netCents: 3334 }, { memberId: D, netCents: -10000 },
  ];
  const transfers = simplifyDebts(balances);
  assert.strictEqual(transfers.reduce((s, t) => s + t.amountCents, 0), 10000);
});

test('unbalanced input is rejected rather than producing nonsense transfers', () => {
  assert.throws(() => simplifyDebts([
    { memberId: A, netCents: 5000 }, { memberId: B, netCents: -3000 },
  ]), /balance|sum|zero/i);
});

// --- end to end ---------------------------------------------------------------------------------------------

test('END TO END: a whole trip reconciles', () => {
  const members = [A, B, C];
  const e1 = computeExpenseSplits({ splitType: 'equal', amountCents: 42500, paidByMemberId: A, splitAmong: members });
  const e2 = computeExpenseSplits({
    splitType: 'by_nights', amountCents: 129600, paidByMemberId: A, splitAmong: members,
    guestStays: [{ memberId: A, nights: 3 }, { memberId: B, nights: 3 }, { memberId: C, nights: 2 }],
  });
  const e3 = computeExpenseSplits({
    splitType: 'itemized', amountCents: 26460, paidByMemberId: B, splitAmong: members,
    lineItems: [
      { label: 'VIP',  amountCents: 9990, assignedToMemberId: A },
      { label: 'GA',   amountCents: 4990, assignedToMemberId: B },
      { label: 'GA',   amountCents: 4990, assignedToMemberId: C },
      { label: 'Parking', amountCents: 1500, isShared: true },
    ],
    tipCents: 0, taxCents: 4990,
  });

  const expenses = [
    { amountCents: 42500,  paidByMemberId: A, splits: e1.splits },
    { amountCents: 129600, paidByMemberId: A, splits: e2.splits },
    { amountCents: 26460,  paidByMemberId: B, splits: e3.splits },
  ];
  for (const e of expenses) {
    assert.strictEqual(sumOf(e.splits), e.amountCents, 'each expense must reconcile');
  }

  const { balances, totalCents, isFullySettled } = computeTripBalances({
    memberIds: members, expenses, settlements: [],
  });
  assert.strictEqual(totalCents, 42500 + 129600 + 26460);
  assert.strictEqual(balances.reduce((s, b) => s + b.netCents, 0), 0);
  assert.strictEqual(isFullySettled, false);

  const transfers = simplifyDebts(balances);
  const net = Object.fromEntries(balances.map((b) => [b.memberId, b.netCents]));
  for (const t of transfers) { net[t.fromMemberId] += t.amountCents; net[t.toMemberId] -= t.amountCents; }
  assert.ok(Object.values(net).every((v) => v === 0), 'settling the transfers clears the trip');

  const settled = computeTripBalances({
    memberIds: members, expenses,
    settlements: transfers.map((t) => ({ fromMemberId: t.fromMemberId, toMemberId: t.toMemberId, amountCents: t.amountCents })),
  });
  assert.strictEqual(settled.isFullySettled, true, 'paying the suggested transfers settles the trip');
});
