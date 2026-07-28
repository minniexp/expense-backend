/**
 * Tests for manually-submitted transactions (the phone ingest path).
 *
 * These decide what a terse JSON body from a Shortcut becomes in the ledger:
 *
 *   {"amount": 37.57, "description": "Zelle payment from HYEON M YANG",
 *    "date": "2026-07-25", "notes": "gas"}
 *
 * Two things carry the most risk and get the most attention:
 *
 *   1. SIGN. Every one of the 906 existing rows follows a per-account convention — on the
 *      checking account income is positive, on credit cards a charge is positive. A manual row
 *      that ignores this reports correctly on its own row and wrongly in any total.
 *
 *   2. IDENTITY. Manual rows have no upstream id, and the id is what the whole dedupe, ignore
 *      and duplicate-detection system runs on. A phone retrying a request must not create a
 *      second row, while two genuinely identical purchases must both survive.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  DESCRIPTION_RULES,
  resolveDescriptionRule,
  normalizeAmountSign,
  deriveTransactionId,
  buildManualTransaction,
} = require('../services/manualTransaction');

const USER = 'user_abc';
const build = (input, opts = {}) =>
  buildManualTransaction(input, { userId: USER, returnIdForMonth: () => null, ...opts });

// ---------------------------------------------------------------------------
// description rules
// ---------------------------------------------------------------------------

test('"Zelle payment from" always resolves to income on the checking account', () => {
  const r = resolveDescriptionRule('Zelle payment from HYEON M YANG');
  assert.strictEqual(r.transactionType, 'income');
  assert.strictEqual(r.paymentMethod, 'Chase College');
});

test('THE SIGN TRAP: "Zelle payment to" with a POSITIVE amount is still an expense', () => {
  // Inferring from the amount alone would call this income. The description is the only
  // reliable signal for direction, which is why a rule table exists at all.
  const t = build({ amount: 37.57, description: 'Zelle payment to Anna Chee', date: '2026-07-25' });
  assert.strictEqual(t.transactionType, 'expense');
});

test('rules are case-insensitive and match within a longer description', () => {
  assert.strictEqual(resolveDescriptionRule('ZELLE PAYMENT FROM someone 12345').transactionType, 'income');
  assert.strictEqual(resolveDescriptionRule('  zelle payment to irene 999 ').transactionType, 'expense');
});

test('a description matching no rule returns null rather than guessing', () => {
  assert.strictEqual(resolveDescriptionRule('ARMO GRILL WHEELING'), null);
});

test('the rule table is ordered and every entry is usable', () => {
  assert.ok(DESCRIPTION_RULES.length > 0);
  for (const r of DESCRIPTION_RULES) {
    assert.ok(r.match instanceof RegExp, 'each rule needs a regex');
    assert.ok(r.transactionType || r.paymentMethod, 'a rule that sets nothing is dead weight');
  }
});

// ---------------------------------------------------------------------------
// precedence: explicit > rule > fallback
// ---------------------------------------------------------------------------

test('an explicit transactionType beats the description rule', () => {
  const t = build({
    amount: 50, description: 'Zelle payment from someone', date: '2026-07-25',
    transactionType: 'expense',
  });
  assert.strictEqual(t.transactionType, 'expense');
});

test('an explicit paymentMethod beats the description rule', () => {
  const t = build({
    amount: 50, description: 'Zelle payment from someone', date: '2026-07-25',
    paymentMethod: 'Freedom',
  });
  assert.strictEqual(t.paymentMethod, 'Freedom');
});

test('with no rule and no explicit values, the amount sign decides and payment defaults', () => {
  const spend = build({ amount: 12.5, description: 'ARMO GRILL', date: '2026-07-25' });
  assert.strictEqual(spend.paymentMethod, 'Cash');
  assert.strictEqual(spend.transactionType, 'expense', 'positive cash spend is an expense');

  const income = build({ amount: -12.5, description: 'ARMO GRILL', date: '2026-07-25' });
  assert.strictEqual(income.transactionType, 'income');
});

// ---------------------------------------------------------------------------
// sign normalisation
// ---------------------------------------------------------------------------

test('sign follows the checking-account convention: income positive, expense negative', () => {
  assert.strictEqual(normalizeAmountSign(37.57, 'Chase College', 'income'), 37.57);
  assert.strictEqual(normalizeAmountSign(37.57, 'Chase College', 'expense'), -37.57);
  assert.strictEqual(normalizeAmountSign(-37.57, 'Chase College', 'income'), 37.57);
});

test('sign follows the credit-card convention: charge positive, refund negative', () => {
  assert.strictEqual(normalizeAmountSign(37.57, 'Freedom', 'expense'), 37.57);
  assert.strictEqual(normalizeAmountSign(37.57, 'Freedom', 'income'), -37.57);
  assert.strictEqual(normalizeAmountSign(-37.57, 'Freedom', 'expense'), 37.57);
});

test('THE CONSISTENCY INVARIANT: a stored row re-derives to the type it was given', () => {
  // Every existing row satisfies this. If a manual row does not, the same transaction reads
  // one way from its type field and the opposite way from its amount.
  const { determineTransactionType } = require('../services/transactionSync');
  for (const method of ['Chase College', 'Cash', 'Freedom', 'Sapphire Reserve']) {
    for (const type of ['income', 'expense']) {
      const amount = normalizeAmountSign(42.42, method, type);
      assert.strictEqual(determineTransactionType(method, amount), type,
        `${method}/${type} stored as ${amount} re-derives wrongly`);
    }
  }
});

test('the submitted amount is unsigned in the payload but stored signed', () => {
  const t = build({ amount: 37.57, description: 'Zelle payment to irene', date: '2026-07-25' });
  assert.strictEqual(t.amount, -37.57, 'money leaving the checking account is negative');
  assert.strictEqual(Math.abs(t.amount), 37.57, 'magnitude is preserved');
});

test('a zero amount is rejected — it is never a real transaction', () => {
  assert.throws(() => build({ amount: 0, description: 'X', date: '2026-07-25' }), /amount/i);
});

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

test('year, month and day are derived from the date', () => {
  const t = build({ amount: 10, description: 'X', date: '2026-07-25' });
  assert.strictEqual(t.date, '2026-07-25');
  assert.strictEqual(t.year, 2026);
  assert.strictEqual(t.month, 7);
  assert.strictEqual(t.day, 25);
});

test('a malformed or impossible date is rejected', () => {
  for (const date of ['25/07/2026', '2026-7-5', '2026-02-30', 'yesterday', '', null, undefined]) {
    assert.throws(() => build({ amount: 10, description: 'X', date }), /date/i,
      `date ${JSON.stringify(date)} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// invalid input — the null-is-not-zero rule
// ---------------------------------------------------------------------------

test('a missing or non-numeric amount is rejected, never treated as zero', () => {
  // Number(null) is 0 and Number('') is 0, so an absent amount would otherwise be stored as a
  // free transaction with no error anywhere.
  for (const amount of [null, undefined, '', 'abc', {}, [], NaN, Infinity, true]) {
    assert.throws(() => build({ amount, description: 'X', date: '2026-07-25' }), /amount/i,
      `amount ${JSON.stringify(amount)} must be rejected`);
  }
});

test('numeric strings are accepted, since JSON from a Shortcut often quotes them', () => {
  const t = build({ amount: '37.57', description: 'X', date: '2026-07-25' });
  assert.strictEqual(Math.abs(t.amount), 37.57);
});

test('a missing description is rejected — the rules have nothing to work with', () => {
  for (const description of [undefined, null, '', '   ']) {
    assert.throws(() => build({ amount: 10, description, date: '2026-07-25' }), /description/i);
  }
});

test('an unknown transactionType is rejected rather than stored', () => {
  assert.throws(() => build({
    amount: 10, description: 'X', date: '2026-07-25', transactionType: 'refund',
  }), /transactiontype/i);
});

// ---------------------------------------------------------------------------
// deterministic identity
// ---------------------------------------------------------------------------

test('the same payload always derives the same id', () => {
  const input = { date: '2026-07-25', amount: 37.57, description: 'Zelle payment from X',
                  paymentMethod: 'Chase College' };
  assert.strictEqual(deriveTransactionId(input), deriveTransactionId({ ...input }));
});

test('ids are prefixed so their origin is obvious', () => {
  const id = deriveTransactionId({ date: '2026-07-25', amount: 1, description: 'X',
                                   paymentMethod: 'Cash' });
  assert.match(id, /^manual_[a-f0-9]{20}$/);
});

test('any field change produces a different id', () => {
  const base = { date: '2026-07-25', amount: 37.57, description: 'X', paymentMethod: 'Cash' };
  const id = deriveTransactionId(base);
  assert.notStrictEqual(id, deriveTransactionId({ ...base, date: '2026-07-26' }));
  assert.notStrictEqual(id, deriveTransactionId({ ...base, amount: 37.58 }));
  assert.notStrictEqual(id, deriveTransactionId({ ...base, description: 'Y' }));
  assert.notStrictEqual(id, deriveTransactionId({ ...base, paymentMethod: 'Freedom' }));
});

test('RETRY SAFETY: a resent payload reuses the id, so it upserts instead of duplicating', () => {
  const input = { amount: 37.57, description: 'Zelle payment from X', date: '2026-07-25' };
  assert.strictEqual(build(input).tellerTransactionId, build(input).tellerTransactionId);
});

test('an ordinal distinguishes two GENUINELY identical purchases', () => {
  // The live data contains eleven groups of real transactions sharing card, date, amount and
  // description. Collapsing those would delete real spending, so repeats stay addressable.
  const input = { date: '2026-07-25', amount: 6.25, description: 'METRA MOBILE',
                  paymentMethod: 'Freedom' };
  const first = deriveTransactionId(input, 0);
  const second = deriveTransactionId(input, 1);
  assert.notStrictEqual(first, second);
  assert.strictEqual(second, `${first}_1`);
  assert.strictEqual(deriveTransactionId(input, 2), `${first}_2`);
});

// ---------------------------------------------------------------------------
// classification reuse
// ---------------------------------------------------------------------------

test('the existing category rules run, so ALDI is still parents-monthly', () => {
  const t = build({ amount: 45.2, description: 'ALDI 00000', date: '2026-07-25',
                    paymentMethod: 'Freedom' });
  assert.strictEqual(t.category, 'parents-monthly');
  assert.deepStrictEqual(t.purchaseCategory, ['groceries']);
  assert.strictEqual(t.needToBePaidback, true);
});

test('points are computed by the existing rules', () => {
  const t = build({ amount: 20, description: 'Something', date: '2026-07-25',
                    paymentMethod: 'Freedom Unlimited' });
  assert.strictEqual(t.points, 1.5, 'Freedom Unlimited base rate');
});

test('an explicit category, purchaseCategory or points overrides the rules', () => {
  const t = build({
    amount: 45.2, description: 'ALDI 00000', date: '2026-07-25', paymentMethod: 'Freedom',
    category: 'personal', purchaseCategory: ['gift'], points: 7,
  });
  assert.strictEqual(t.category, 'personal');
  assert.deepStrictEqual(t.purchaseCategory, ['gift']);
  assert.strictEqual(t.points, 7);
});

test('a parents-monthly row still gets its return document id', () => {
  const t = build({ amount: 45.2, description: 'ALDI', date: '2026-07-25' },
    { returnIdForMonth: (y, m) => `ret_${y}_${m}` });
  assert.strictEqual(t.returnId, 'ret_2026_7');
});

// ---------------------------------------------------------------------------
// the whole record
// ---------------------------------------------------------------------------

test('the built record satisfies everything the Transaction schema requires', () => {
  const t = build({ amount: 37.57, description: 'Zelle payment from HYEON M YANG',
                    date: '2026-07-25', notes: 'gas' });
  for (const field of ['userId', 'date', 'year', 'month', 'day', 'amount', 'transactionType']) {
    assert.ok(t[field] !== undefined && t[field] !== null, `${field} must be set`);
  }
  assert.strictEqual(t.userId, USER);
  assert.strictEqual(t.notes, 'gas');
  assert.strictEqual(t.transactionType, 'income');
  assert.strictEqual(t.paymentMethod, 'Chase College');
  assert.strictEqual(t.amount, 37.57);
  assert.strictEqual(t.source, 'phone', 'provenance is recorded');
  assert.match(t.tellerTransactionId, /^manual_/);
});

test('unknown fields in the payload are ignored, not stored or rejected', () => {
  const t = build({ amount: 10, description: 'X', date: '2026-07-25',
                    somethingElse: 'ignore me', __proto__hack: 1 });
  assert.strictEqual(t.somethingElse, undefined);
  assert.strictEqual(t.transactionType, 'expense');
});

test('notes default to empty rather than undefined', () => {
  assert.strictEqual(build({ amount: 10, description: 'X', date: '2026-07-25' }).notes, '');
});
