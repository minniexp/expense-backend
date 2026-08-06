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
  DEFAULT_CATEGORY,
  MAX_TIME_LENGTH,
  resolveDescriptionRule,
  parseCardLast4Map,
  resolveCardFromLast4,
  parseAlertDate,
  splitAlertDateText,
  cleanDescription,
  normalizeIngestInput,
  buildManualTransaction,
  normalizeAmountSign,
  normalizeDescriptionKey,
  isSameTransaction,
  deriveTransactionId,
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

// ---------------------------------------------------------------------------
// bank alert emails: card last-four, and the clock time
//
// A Chase transaction alert names the card only by its last four digits, so the mapping to an
// account this ledger recognises happens here. The resolved name has to be exactly the Teller card
// name, because that string is the only thing tying an alert-sourced row to the charge the bank
// feed reports a day or two later — the descriptions never match.
// ---------------------------------------------------------------------------

const CARDS = { 8923: 'Freedom Unlimited', 1234: 'Chase College' };
const buildWithCards = (input, opts = {}) => build(input, { cardLast4Map: CARDS, ...opts });

test('CARD_LAST4_MAP parses pairs and tolerates spacing and blank entries', () => {
  assert.deepStrictEqual(
    parseCardLast4Map(' 8923:Freedom Unlimited , 1234:Chase College ,, '),
    { 8923: 'Freedom Unlimited', 1234: 'Chase College' }
  );
});

test('CARD_LAST4_MAP ignores malformed entries rather than storing junk', () => {
  // A key that is not four digits could never be matched against an alert, and a pair with no name
  // would resolve a real card to an empty payment method.
  assert.deepStrictEqual(parseCardLast4Map('89:Freedom,8923:,nocolon,88888:Freedom'), {});
  assert.deepStrictEqual(parseCardLast4Map(undefined), {});
  assert.deepStrictEqual(parseCardLast4Map(''), {});
});

test('a card name containing a colon survives parsing', () => {
  assert.deepStrictEqual(parseCardLast4Map('8923:Chase: Freedom'), { 8923: 'Chase: Freedom' });
});

test('resolveCardFromLast4 never guesses', () => {
  assert.strictEqual(resolveCardFromLast4('8923', CARDS), 'Freedom Unlimited');
  assert.strictEqual(resolveCardFromLast4('0000', CARDS), null);
  assert.strictEqual(resolveCardFromLast4('892', CARDS), null);
  assert.strictEqual(resolveCardFromLast4(undefined, CARDS), null);
  assert.strictEqual(resolveCardFromLast4('8923', {}), null);
});

test('THE ALERT CASE: a Chase alert resolves its card, keeps a charge positive, and earns points', () => {
  // Exactly the payload the iOS Shortcut builds from "You made a $168.00 transaction with
  // WWW.SWAN-DIVEPILATES" on the card ending 8923.
  const t = buildWithCards({
    date: '2026-07-29',
    time: '8:51 PM ET',
    amount: '168.00',
    description: 'WWW.SWAN-DIVEPILATES',
    transactionType: 'expense',
    cardLast4: '8923',
    category: 'personal',
    purchaseCategory: [],
  });
  assert.strictEqual(t.paymentMethod, 'Freedom Unlimited');
  assert.strictEqual(t.cardLast4, '8923');
  assert.strictEqual(t.amount, 168, 'a credit-card charge stores positive');
  assert.strictEqual(t.transactionType, 'expense');
  assert.strictEqual(t.time, '8:51 PM ET');
  assert.strictEqual(t.points, 1.5, 'the Freedom Unlimited base rate');
  assert.strictEqual(t.category, 'personal');
  assert.deepStrictEqual(t.purchaseCategory, []);
});

test('an unmapped card is REJECTED rather than filed as Cash', () => {
  // Falling through to Cash would flip the sign (Cash treats a positive figure as money arriving),
  // mis-compute points, and break the duplicate match against the bank feed — none of which is
  // visible in the row itself. The alert is still in the inbox and can be resent.
  assert.throws(
    () => buildWithCards({ amount: 168, description: 'X', date: '2026-07-29', cardLast4: '0000' }),
    /Unknown card \.\.\.0000/
  );
});

test('an explicit paymentMethod wins over the card last-four, and suppresses the rejection', () => {
  const t = buildWithCards({ amount: 50, description: 'X', date: '2026-07-29',
                             cardLast4: '0000', paymentMethod: 'Sapphire Reserve' });
  assert.strictEqual(t.paymentMethod, 'Sapphire Reserve');
});

test('a description rule beats the card last-four', () => {
  // A rule states something about one known description; a last-four map is a blanket mapping. The
  // more specific fact wins. This case shows why it has to: a Zelle transfer cannot come off a
  // credit card, so an alert naming one is describing the notification, not the account.
  const t = buildWithCards({ amount: 25, description: 'Zelle payment to Anna Chee',
                             date: '2026-07-29', cardLast4: '8923' });
  assert.strictEqual(t.paymentMethod, 'Chase College');
  assert.strictEqual(t.transactionType, 'expense');
  assert.strictEqual(t.amount, -25, 'and the account decides the sign');
});

test('the card last-four still decides when no rule has an opinion', () => {
  // Which is every ordinary card purchase — the overwhelming majority of what arrives here.
  const t = buildWithCards({ amount: 168, description: 'WWW.SWAN-DIVEPILATES',
                             date: '2026-07-29', cardLast4: '8923' });
  assert.strictEqual(t.paymentMethod, 'Freedom Unlimited');
  assert.strictEqual(t.points, 1.5);
});

test('an unmapped card is forgiven when a rule supplies the account anyway', () => {
  const t = buildWithCards({ amount: 2853.37, description: 'Direct Deposit - Payroll (UCC)',
                             date: '2026-07-31', cardLast4: '0000' });
  assert.strictEqual(t.paymentMethod, 'Chase College');
});

test('no card last-four leaves the existing precedence untouched', () => {
  const t = buildWithCards({ amount: 12.5, description: 'Street parking', date: '2026-07-29' });
  assert.strictEqual(t.paymentMethod, 'Cash');
  assert.strictEqual(t.cardLast4, '');
});

test('cardLast4 is stored only when it is four digits', () => {
  const t = buildWithCards({ amount: 10, description: 'X', date: '2026-07-29',
                             cardLast4: 'nonsense', paymentMethod: 'Cash' });
  assert.strictEqual(t.cardLast4, '');
});

test('time is stored verbatim, defaults to empty, and is length-capped', () => {
  const base = { amount: 10, description: 'X', date: '2026-07-29' };
  assert.strictEqual(buildWithCards(base).time, '', 'bank-feed rows have no time');
  assert.strictEqual(buildWithCards({ ...base, time: '  8:51 PM ET  ' }).time, '8:51 PM ET');
  assert.strictEqual(buildWithCards({ ...base, time: 'x'.repeat(200) }).time.length, MAX_TIME_LENGTH);
});

test('time is NOT converted to a timezone, so a late-evening purchase keeps its day', () => {
  // "11:40 PM CT" is 12:40 AM ET the following day. Storing an instant would need both zones and
  // would move the row onto the wrong date whenever the guess was wrong; `date` is authoritative.
  const t = buildWithCards({ amount: 10, description: 'X', date: '2026-07-29', time: '11:40 PM CT' });
  assert.strictEqual(t.time, '11:40 PM CT');
  assert.strictEqual(t.date, '2026-07-29');
  assert.strictEqual(t.day, 29);
});

test('a non-string time is rejected rather than coerced', () => {
  assert.throws(
    () => buildWithCards({ amount: 10, description: 'X', date: '2026-07-29', time: 2051 }),
    /Invalid time/
  );
});

test('the category, not the card, still decides the derived id — so re-posting UPDATES the row', () => {
  // The Shortcut posts once with category 'personal', then again with whatever the user picked.
  // The second post must land on the same row, which means category cannot be part of the id.
  const alert = { date: '2026-07-29', amount: '168.00', description: 'WWW.SWAN-DIVEPILATES',
                  transactionType: 'expense', cardLast4: '8923', time: '8:51 PM ET' };
  const first = buildWithCards({ ...alert, category: 'personal', purchaseCategory: [] });
  const second = buildWithCards({ ...alert, category: 'doctors', purchaseCategory: ['health'] });
  assert.strictEqual(first.tellerTransactionId, second.tellerTransactionId);
  assert.strictEqual(second.category, 'doctors');
  assert.deepStrictEqual(second.purchaseCategory, ['health']);
});

// ---------------------------------------------------------------------------
// needToBePaidback
// ---------------------------------------------------------------------------

test('needToBePaidback still defaults to whether the category is parents-monthly', () => {
  const base = { amount: 93.87, description: 'ALDI 12345', date: '2026-02-10' };
  assert.strictEqual(build({ ...base, category: 'parents-monthly' }).needToBePaidback, true);
  assert.strictEqual(build({ ...base, category: 'personal' }).needToBePaidback, false);
});

test('an explicit needToBePaidback overrides the category default', () => {
  const base = { amount: 93.87, description: 'ALDI 12345', date: '2026-02-10' };
  assert.strictEqual(
    build({ ...base, category: 'parents-monthly', needToBePaidback: false }).needToBePaidback,
    false
  );
  assert.strictEqual(
    build({ ...base, category: 'personal', needToBePaidback: true }).needToBePaidback,
    true
  );
});

test('overriding needToBePaidback does NOT sever the link to the month\'s return', () => {
  // A parents-monthly row belongs to that month's return whether or not this one is being claimed
  // back. Dropping returnId would orphan it in the UI.
  const t = build(
    { amount: 93.87, description: 'ALDI 12345', date: '2026-02-10',
      category: 'parents-monthly', needToBePaidback: false },
    { returnIdForMonth: () => 'return_feb_2026' }
  );
  assert.strictEqual(t.returnId, 'return_feb_2026');
  assert.strictEqual(t.needToBePaidback, false);
});

test('a non-boolean needToBePaidback falls back to the category default rather than coercing', () => {
  const t = build({ amount: 10, description: 'ALDI 1', date: '2026-02-10',
                    category: 'parents-monthly', needToBePaidback: 'no' });
  assert.strictEqual(t.needToBePaidback, true, "'no' is truthy — coercing it would be a silent lie");
});

// ---------------------------------------------------------------------------
// the Shortcut's own field names
//
// A Shortcut holds its parsed values in variables called Amount, Merchant, Last4 and DateText.
// Accepting those directly means the phone sends what it already has, with no renaming step and no
// date formatting — and the conversion lives here, where it is testable.
// ---------------------------------------------------------------------------

const ALL_CARDS = {
  8837: 'Chase College',
  3143: 'Freedom',
  8923: 'Freedom Unlimited',
  1731: 'Freedom Flex',
  '0419': 'Sapphire Reserve',
  1301: 'Amazon Visa',
};

test('THE SHORTCUT PAYLOAD: four fields become a complete ledger row', () => {
  const t = build({
    DateText: 'Jul 29, 2026',
    Amount: 168.00,
    Merchant: 'WWW.SWAN-DIVEPILATES',
    Last4: '8923',
  }, { cardLast4Map: ALL_CARDS });

  assert.strictEqual(t.date, '2026-07-29');
  assert.strictEqual(t.year, 2026);
  assert.strictEqual(t.month, 7);
  assert.strictEqual(t.day, 29);
  assert.strictEqual(t.amount, 168, 'a credit-card charge stores positive');
  assert.strictEqual(t.description, 'WWW.SWAN-DIVEPILATES');
  assert.strictEqual(t.paymentMethod, 'Freedom Unlimited');
  assert.strictEqual(t.cardLast4, '8923');
  assert.strictEqual(t.transactionType, 'expense', 'a bare positive amount is money spent');
  assert.strictEqual(t.category, 'bill', 'the description classifier still runs');
  assert.strictEqual(t.points, 1.5);
  assert.match(t.tellerTransactionId, /^manual_/);
});

test('every card in the map resolves, including the one with a leading zero', () => {
  for (const [last4, name] of Object.entries(ALL_CARDS)) {
    const t = build({ DateText: 'Jul 29, 2026', Amount: 10, Merchant: 'X', Last4: last4 },
      { cardLast4Map: ALL_CARDS });
    assert.strictEqual(t.paymentMethod, name, `${last4} should be ${name}`);
  }
});

test('THE SIGN TRAP AGAIN: the same payload on the checking account stores NEGATIVE', () => {
  // 8837 is Chase College, where a positive figure means money arriving. An expense there has to be
  // stored negative or every total that sums amounts reports the wrong way round.
  const t = build({ DateText: 'Jul 29, 2026', Amount: 168, Merchant: 'X', Last4: '8837' },
    { cardLast4Map: ALL_CARDS });
  assert.strictEqual(t.paymentMethod, 'Chase College');
  assert.strictEqual(t.transactionType, 'expense');
  assert.strictEqual(t.amount, -168);
  assert.strictEqual(t.points, 0, 'Chase College earns nothing');
});

test('parseAlertDate handles the wordings Chase uses', () => {
  assert.strictEqual(parseAlertDate('Jul 29, 2026'), '2026-07-29');
  assert.strictEqual(parseAlertDate('July 29, 2026'), '2026-07-29');
  assert.strictEqual(parseAlertDate('Sept. 3, 2026'), '2026-09-03');
  assert.strictEqual(parseAlertDate('  Jan 1 2026  '), '2026-01-01');
  assert.strictEqual(parseAlertDate('December 25, 2025'), '2025-12-25');
});

test('parseAlertDate zero-pads, so the month and day are always two digits', () => {
  assert.strictEqual(parseAlertDate('Feb 5, 2026'), '2026-02-05');
});

test('parseAlertDate returns null rather than guessing', () => {
  for (const bad of ['2026-07-29', 'Jul 2026', 'Foo 29, 2026', '29 Jul 2026', '', null, 12345]) {
    assert.strictEqual(parseAlertDate(bad), null, `${JSON.stringify(bad)} is not a Chase date`);
  }
});

test('an unparseable DateText is reported as such, not as a missing date', () => {
  assert.throws(
    () => build({ DateText: 'sometime last Tuesday', Amount: 10, Merchant: 'X', Last4: '8923' },
      { cardLast4Map: ALL_CARDS }),
    /Invalid DateText: "sometime last Tuesday"/
  );
});

test('an impossible calendar date is still caught by the one date validator', () => {
  // parseAlertDate composes the string; parseIsoDate rejects it. Two steps, one source of truth.
  assert.throws(
    () => build({ DateText: 'Feb 30, 2026', Amount: 10, Merchant: 'X', Last4: '8923' },
      { cardLast4Map: ALL_CARDS }),
    /Invalid date/
  );
});

test('a lowercase key always wins over the Shortcut spelling', () => {
  const t = build({
    DateText: 'Jul 29, 2026', date: '2026-01-02',
    Amount: 999, amount: 10,
    Merchant: 'FROM SHORTCUT', description: 'FROM LEDGER',
    Last4: '8923', paymentMethod: 'Cash',
  }, { cardLast4Map: ALL_CARDS });
  assert.strictEqual(t.date, '2026-01-02');
  assert.strictEqual(t.description, 'FROM LEDGER');
  assert.strictEqual(t.paymentMethod, 'Cash');
  assert.strictEqual(Math.abs(t.amount), 10);
});

test('the remaining Shortcut variable names are accepted too', () => {
  const t = build({
    DateText: 'Jul 29, 2026', Amount: 50, Merchant: 'X', Last4: '8923',
    Time: '8:51 PM ET', Category: 'doctors', PurchaseCats: ['health'], Notes: 'copay',
  }, { cardLast4Map: ALL_CARDS });
  assert.strictEqual(t.time, '8:51 PM ET');
  assert.strictEqual(t.category, 'doctors');
  assert.deepStrictEqual(t.purchaseCategory, ['health']);
  assert.strictEqual(t.notes, 'copay');
});

test('the old lowercase payload is completely unaffected', () => {
  const t = build({ amount: 37.57, description: 'Zelle payment from HYEON M YANG',
                    date: '2026-07-25', notes: 'gas' });
  assert.strictEqual(t.transactionType, 'income');
  assert.strictEqual(t.paymentMethod, 'Chase College');
  assert.strictEqual(t.date, '2026-07-25');
  assert.strictEqual(t.notes, 'gas');
});

test('normalizeIngestInput does not mutate what it was given', () => {
  const original = { DateText: 'Jul 29, 2026', Amount: 168, Merchant: 'X', Last4: '8923' };
  const copy = { ...original };
  normalizeIngestInput(original);
  assert.deepStrictEqual(original, copy, 'the caller\'s object must survive intact');
});

test('the same Shortcut payload sent twice derives the same id, so a retry updates', () => {
  const payload = { DateText: 'Jul 29, 2026', Amount: 168.00,
                    Merchant: 'WWW.SWAN-DIVEPILATES', Last4: '8923' };
  const a = build(payload, { cardLast4Map: ALL_CARDS });
  const b = build({ ...payload }, { cardLast4Map: ALL_CARDS });
  assert.strictEqual(a.tellerTransactionId, b.tellerTransactionId);
});

// ---------------------------------------------------------------------------
// what a Shortcut actually sends
//
// Match Text hands back the whole match; the value you wanted is capture group 1. A shortcut wired
// to the former sends the label and the trailing clock time along with the data. Both are cheap to
// absorb here, and rejecting them cost a real evening of debugging for no benefit.
// ---------------------------------------------------------------------------

test('THE LIVE PAYLOAD: whole-match capture on both fields still saves correctly', () => {
  const t = build({
    Merchant: 'Merchant\nWWW.SWAN-DIVEPILATES',
    DateText: 'Aug 1, 2026 at 1:36 AM',
    Amount: 168,
    Last4: '8923',
  }, { cardLast4Map: ALL_CARDS });

  assert.strictEqual(t.description, 'WWW.SWAN-DIVEPILATES', 'the label is dropped');
  assert.strictEqual(t.date, '2026-08-01');
  assert.strictEqual(t.month, 8);
  assert.strictEqual(t.day, 1);
  assert.strictEqual(t.time, '1:36 AM', 'the clock time is kept, not discarded');
  assert.strictEqual(t.amount, 168);
  assert.strictEqual(t.paymentMethod, 'Freedom Unlimited');
  assert.strictEqual(t.category, 'bill', 'the label would have broken this classifier too');
  assert.strictEqual(t.points, 1.5);
});

test('DateText keeps the time when there is one, and the zone when there is one', () => {
  assert.deepStrictEqual(splitAlertDateText('Jul 29, 2026'),
    { date: '2026-07-29', time: '' });
  assert.deepStrictEqual(splitAlertDateText('Aug 1, 2026 at 1:36 AM'),
    { date: '2026-08-01', time: '1:36 AM' });
  assert.deepStrictEqual(splitAlertDateText('Jul 29, 2026 at 8:51 PM ET'),
    { date: '2026-07-29', time: '8:51 PM ET' });
});

test('an explicit Time still wins over the one embedded in DateText', () => {
  const t = build({ DateText: 'Aug 1, 2026 at 1:36 AM', Time: '9:00 PM CT',
                    Amount: 10, Merchant: 'X', Last4: '8923' }, { cardLast4Map: ALL_CARDS });
  assert.strictEqual(t.time, '9:00 PM CT');
});

test('a label is stripped whether it is on its own line or column-aligned', () => {
  assert.strictEqual(cleanDescription('Merchant\nWWW.SWAN-DIVEPILATES'), 'WWW.SWAN-DIVEPILATES');
  assert.strictEqual(cleanDescription('Merchant    WWW.SWAN-DIVEPILATES'), 'WWW.SWAN-DIVEPILATES');
  assert.strictEqual(cleanDescription('  Merchant\r\n  SQ *BLUE BOTTLE  '), 'SQ *BLUE BOTTLE');
});

test('a merchant whose NAME begins with a label word is left alone', () => {
  // One space, not a column gap — so this is a name, not a stripped label. Getting this wrong would
  // silently rewrite real merchants.
  assert.strictEqual(cleanDescription('MERCHANT SERVICES CO'), 'MERCHANT SERVICES CO');
  assert.strictEqual(cleanDescription('Amount Financial LLC'), 'Amount Financial LLC');
  assert.strictEqual(cleanDescription('WWW.SWAN-DIVEPILATES'), 'WWW.SWAN-DIVEPILATES');
});

test('a description that is nothing but a label is rejected, not silently emptied', () => {
  assert.throws(
    () => build({ DateText: 'Aug 1, 2026', Amount: 10, Merchant: 'Merchant\n', Last4: '8923' },
      { cardLast4Map: ALL_CARDS }),
    /A description is required/
  );
});

test('a still-unparseable DateText names both accepted shapes', () => {
  assert.throws(
    () => build({ DateText: 'last Tuesday', Amount: 10, Merchant: 'X', Last4: '8923' },
      { cardLast4Map: ALL_CARDS }),
    /Invalid DateText.*Jul 29, 2026 at 8:51 PM ET/s
  );
});

test('the label strip does not change the id for a correctly-sent merchant', () => {
  // Whole-match and group-1 captures of the same purchase must land on the same row.
  const whole = build({ DateText: 'Aug 1, 2026 at 1:36 AM', Amount: 168,
                        Merchant: 'Merchant\nWWW.SWAN-DIVEPILATES', Last4: '8923' },
    { cardLast4Map: ALL_CARDS });
  const group = build({ DateText: 'Aug 1, 2026', Amount: 168,
                        Merchant: 'WWW.SWAN-DIVEPILATES', Last4: '8923' },
    { cardLast4Map: ALL_CARDS });
  assert.strictEqual(whole.tellerTransactionId, group.tellerTransactionId);
});

// ---------------------------------------------------------------------------
// what a card implies beyond which account it is
//
// A card belonging to somebody else means every purchase on it is theirs. The description
// classifier gets that right by accident for the shops they use often — a grocery run reads as
// parents-monthly wherever it came from — and wrong for everything else.
// ---------------------------------------------------------------------------

const MOM_CARD = { 8016: 'Freedom Unlimited', 8923: 'Freedom Unlimited' };
const MOM_CATEGORY = { 8016: 'parents-monthly' };
const onCard = (input) => build(input, { cardLast4Map: MOM_CARD, cardCategoryMap: MOM_CATEGORY });

test("THE MOM CARD: a purchase on 8016 is parents-monthly and owed back", () => {
  const t = onCard({ Amount: 172.73, Description: 'Mom - JOONG BOO MARKET',
                     Last4: '8016', TransactionType: 'expense', date: '2026-08-05' });
  assert.strictEqual(t.paymentMethod, 'Freedom Unlimited');
  assert.strictEqual(t.category, 'parents-monthly');
  assert.strictEqual(t.points, 1.5, 'the Freedom Unlimited base rate');
  assert.strictEqual(t.amount, 172.73, 'a credit-card charge stores positive');
  assert.strictEqual(t.needToBePaidback, true);
  assert.deepStrictEqual(t.purchaseCategory, ['groceries']);
});

test('THE CASE THE CLASSIFIER CANNOT SEE: a non-grocery purchase on the same card', () => {
  // The description says nothing about whose card it was, so without the card rule this would be
  // filed as ordinary personal spending and never reclaimed.
  const t = onCard({ Amount: 40, Description: 'Mom - SHELL OIL',
                     Last4: '8016', TransactionType: 'expense', date: '2026-08-05' });
  assert.strictEqual(t.category, 'parents-monthly');
  assert.strictEqual(t.needToBePaidback, true);
});

test('a card with no category rule is unaffected, even on the same account', () => {
  // 8016 and 8923 are both Freedom Unlimited. Only one of them is Mom's.
  const t = onCard({ Amount: 26.99, Merchant: 'NETFLIX.COM',
                     Last4: '8923', TransactionType: 'expense', date: '2026-08-05' });
  assert.strictEqual(t.paymentMethod, 'Freedom Unlimited');
  assert.strictEqual(t.category, 'personal');
  assert.strictEqual(t.needToBePaidback, false);
});

test('an explicit category still overrides what the card implies', () => {
  const t = onCard({ Amount: 40, Description: 'Mom - SHELL OIL', Last4: '8016',
                     TransactionType: 'expense', date: '2026-08-05', category: 'personal' });
  assert.strictEqual(t.category, 'personal');
});

test('a description rule outranks the card, since it is the more specific statement', () => {
  const t = onCard({ Amount: 500, Description: 'Direct Deposit - Payroll (UCC)', Last4: '8016',
                     TransactionType: 'income', date: '2026-08-05' });
  assert.strictEqual(t.category, 'payroll');
});

test('the card category drives the link to that month\'s return', () => {
  const t = build(
    { Amount: 40, Description: 'Mom - SHELL OIL', Last4: '8016', TransactionType: 'expense',
      date: '2026-08-05' },
    { cardLast4Map: MOM_CARD, cardCategoryMap: MOM_CATEGORY,
      returnIdForMonth: (y, m) => `return_${y}_${m}` }
  );
  assert.strictEqual(t.returnId, 'return_2026_8');
});

test('Description is accepted as an alias, alongside Merchant', () => {
  const a = onCard({ Amount: 10, Description: 'Mom - X', Last4: '8016', date: '2026-08-05' });
  const b = onCard({ Amount: 10, Merchant: 'Mom - X', Last4: '8016', date: '2026-08-05' });
  assert.strictEqual(a.description, 'Mom - X');
  assert.strictEqual(a.tellerTransactionId, b.tellerTransactionId, 'and derives the same row');
});

// ---------------------------------------------------------------------------
// duplicate detection
//
// The upsert alone was never going to create a second row, but it would $set over the top of an
// existing one — replacing a category chosen by hand with whatever the classifier guessed. These
// decide when a payload is "the same transaction" and must be left alone entirely.
// ---------------------------------------------------------------------------

const row = (over) => Object.assign({
  date: '2026-08-01', amount: 26.99, description: 'NETFLIX.COM', transactionType: 'expense',
}, over);

test('the same alert sent twice is recognised as the same transaction', () => {
  assert.strictEqual(isSameTransaction(row(), row()), true);
});

test('description matching ignores case and collapses whitespace', () => {
  // A forwarded email may re-wrap the line, and the merchant is the same either way.
  assert.strictEqual(isSameTransaction(row(), row({ description: 'netflix.com' })), true);
  assert.strictEqual(isSameTransaction(row(), row({ description: '  NETFLIX.COM  ' })), true);
  assert.strictEqual(isSameTransaction(row(), row({ description: 'NETFLIX.COM' })), true);
  assert.strictEqual(
    isSameTransaction(row({ description: 'SQ  *BLUE   BOTTLE' }),
      row({ description: 'sq *blue bottle' })), true);
});

test('any of the four fields differing makes it a different transaction', () => {
  assert.strictEqual(isSameTransaction(row(), row({ date: '2026-08-02' })), false);
  assert.strictEqual(isSameTransaction(row(), row({ amount: 26.98 })), false);
  assert.strictEqual(isSameTransaction(row(), row({ description: 'HULU.COM' })), false);
  assert.strictEqual(isSameTransaction(row(), row({ transactionType: 'income' })), false);
});

test('the payment method is deliberately NOT part of the comparison', () => {
  // The id derivation includes it; this does not. An alert re-sent after the card map changed, or
  // sent once with an explicit account and once without, is still the same purchase.
  const a = { ...row(), paymentMethod: 'Freedom Unlimited' };
  const b = { ...row(), paymentMethod: 'Cash' };
  assert.strictEqual(isSameTransaction(a, b), true);
});

test('a refund is not the same transaction as the charge it reverses', () => {
  // Same merchant, same day, same magnitude — opposite direction and opposite sign.
  assert.strictEqual(
    isSameTransaction(row({ amount: 26.99, transactionType: 'expense' }),
      row({ amount: -26.99, transactionType: 'income' })), false);
});

test('a missing or malformed row is never considered a match', () => {
  assert.strictEqual(isSameTransaction(row(), null), false);
  assert.strictEqual(isSameTransaction(null, row()), false);
  assert.strictEqual(isSameTransaction(row(), {}), false);
});

test('amounts compare numerically, so "26.99" and 26.99 are the same', () => {
  assert.strictEqual(isSameTransaction(row(), row({ amount: '26.99' })), true);
});

test('normalizeDescriptionKey is what both the id and the duplicate check agree on', () => {
  assert.strictEqual(normalizeDescriptionKey('  Www.Swan-DivePilates  '), 'WWW.SWAN-DIVEPILATES');
  assert.strictEqual(normalizeDescriptionKey('SQ  *BLUE\n BOTTLE'), 'SQ *BLUE BOTTLE');
  assert.strictEqual(normalizeDescriptionKey(null), '');
});

test('two rows judged the same also derive the same id when the card matches', () => {
  // Belt and braces: the duplicate check is the primary guard, the id is the fallback.
  const a = buildManualTransaction(
    { date: '2026-08-01', amount: 26.99, description: 'NETFLIX.COM', paymentMethod: 'Freedom Unlimited' },
    { userId: 'u', returnIdForMonth: () => null });
  const b = buildManualTransaction(
    { date: '2026-08-01', amount: 26.99, description: '  netflix.com ', paymentMethod: 'Freedom Unlimited' },
    { userId: 'u', returnIdForMonth: () => null });
  assert.strictEqual(isSameTransaction(a, b), true);
  assert.strictEqual(a.tellerTransactionId, b.tellerTransactionId);
});

// ---------------------------------------------------------------------------
// payroll direct deposits
//
// One rule expresses everything true of every payroll deposit — direction, account, category and
// points — so a Shortcut sends only what it read from the email.
// ---------------------------------------------------------------------------

test('THE PAYROLL PAYLOAD: one rule fills in category, account and points', () => {
  const t = build({
    Amount: 2853.37,
    Merchant: 'Direct Deposit - Payroll (UCC)',
    Last4: '8837',
    TransactionType: 'income',
    DateText: 'Jul 31, 2026 at 3:47 AM',
  }, { cardLast4Map: ALL_CARDS });

  assert.strictEqual(t.category, 'payroll');
  assert.strictEqual(t.paymentMethod, 'Chase College', 'the account the deposit lands in');
  assert.strictEqual(t.points, 0);
  assert.strictEqual(t.reviewed, false);
  assert.strictEqual(t.transactionType, 'income');
  assert.strictEqual(t.amount, 2853.37, 'money arriving is positive on Cash');
  assert.strictEqual(t.date, '2026-07-31');
  assert.strictEqual(t.time, '3:47 AM');
  assert.strictEqual(t.needToBePaidback, false);
});

test('payroll resolves the same way without an explicit transactionType', () => {
  // The rule already knows the direction, so a Shortcut that omits it is not silently reversed.
  const t = build({ Amount: 2853.37, Merchant: 'Direct Deposit - Payroll (UCC)',
                    Last4: '8837', DateText: 'Jul 31, 2026 at 3:47 AM' }, { cardLast4Map: ALL_CARDS });
  assert.strictEqual(t.transactionType, 'income');
  assert.strictEqual(t.amount, 2853.37);
});

test('the payroll rule tolerates the employer code and the dash style', () => {
  for (const description of [
    'Direct Deposit - Payroll (UCC)',
    'DIRECT DEPOSIT - PAYROLL (ACME)',
    'Direct Deposit – Payroll',
    'Direct  Deposit-Payroll (UCC)',
  ]) {
    const t = build({ amount: 100, description, date: '2026-07-31' });
    assert.strictEqual(t.category, 'payroll', `${description} should be payroll`);
    assert.strictEqual(t.paymentMethod, 'Chase College');
    assert.strictEqual(t.points, 0);
  }
});

test('points pinned to zero by a rule are not recomputed', () => {
  // `rule.points || calculatePoints(...)` would read 0 as "unset" and overwrite it.
  const t = build({ amount: 2853.37, description: 'Direct Deposit - Payroll (UCC)',
                    date: '2026-07-31', purchaseCategory: ['dining'] });
  assert.strictEqual(t.points, 0, 'dining on a rewards card would otherwise earn points');
});

test('an explicit value still overrides the payroll rule', () => {
  const t = build({ amount: 2853.37, description: 'Direct Deposit - Payroll (UCC)',
                    date: '2026-07-31', category: 'business', paymentMethod: 'Schwab', points: 7 });
  assert.strictEqual(t.category, 'business');
  assert.strictEqual(t.paymentMethod, 'Schwab');
  assert.strictEqual(t.points, 7);
});

test('a payroll deposit is not mistaken for spending by the sign convention', () => {
  const t = build({ amount: 2853.37, description: 'Direct Deposit - Payroll (UCC)',
                    date: '2026-07-31' });
  const { determineTransactionType } = require('../services/transactionSync');
  assert.strictEqual(determineTransactionType(t.paymentMethod, t.amount), 'income',
    'the stored row must re-derive as income');
});

// ---------------------------------------------------------------------------
// Zelle transfers
//
// The one case where a positive amount means the opposite thing half the time. Everything else can
// fall back on "a positive number is money spent"; a transfer cannot, and the checking account's
// sign convention then doubles the error.
// ---------------------------------------------------------------------------

const ZELLE_CARDS = { 8837: 'Chase College' };
const zelle = (input) => build(input, { cardLast4Map: ZELLE_CARDS });

test('THE ZELLE PAYLOAD: money received is income, and stores positive', () => {
  const t = zelle({
    Amount: 60.23,
    Merchant: 'Zelle from SHARON LEE / Mr. Kimchi',
    DateText: 'Jul 20, 2026',
    Last4: '8837',
  });
  assert.strictEqual(t.transactionType, 'income');
  assert.strictEqual(t.amount, 60.23, 'money arriving on the checking account is positive');
  assert.strictEqual(t.paymentMethod, 'Chase College');
  assert.strictEqual(t.date, '2026-07-20');
  assert.strictEqual(t.description, 'Zelle from SHARON LEE / Mr. Kimchi');
});

test('money sent is an expense, and stores negative', () => {
  const t = zelle({ Amount: 25, Merchant: 'Zelle to Anna Chee', DateText: 'Jul 20, 2026',
                    Last4: '8837' });
  assert.strictEqual(t.transactionType, 'expense');
  assert.strictEqual(t.amount, -25);
});

test('the relaxed rule still matches the bank feed wording it replaced', () => {
  assert.strictEqual(resolveDescriptionRule('Zelle payment from HYEON M YANG').transactionType, 'income');
  assert.strictEqual(resolveDescriptionRule('Zelle payment to Anna Chee').transactionType, 'expense');
  assert.strictEqual(resolveDescriptionRule('Zelle from SHARON LEE / Mr. Kimchi').transactionType, 'income');
  assert.strictEqual(resolveDescriptionRule('Zelle to Anna Chee').transactionType, 'expense');
});

test('A DIRECTIONLESS ZELLE IS REJECTED, never guessed', () => {
  // "Zelle - SHARON LEE" is what reads naturally and says nothing. Guessing would file $60 received
  // as $60 spent — a $120 swing that no bank feed exists to contradict.
  assert.throws(
    () => zelle({ Amount: 60.23, Merchant: 'Zelle - SHARON LEE / Mr. Kimchi',
                  DateText: 'Jul 20, 2026', Last4: '8837' }),
    /Ambiguous Zelle description/
  );
});

test('an explicit transactionType settles an otherwise ambiguous Zelle', () => {
  const t = zelle({ Amount: 60.23, Merchant: 'Zelle - SHARON LEE / Mr. Kimchi',
                    DateText: 'Jul 20, 2026', Last4: '8837', TransactionType: 'income' });
  assert.strictEqual(t.transactionType, 'income');
  assert.strictEqual(t.amount, 60.23);
});

test('the ambiguity guard does not fire on ordinary merchants', () => {
  // Only descriptions actually mentioning Zelle are held to this standard.
  for (const merchant of ['WWW.SWAN-DIVEPILATES', 'ARMO GRILL', 'GAZELLE.COM']) {
    const t = zelle({ Amount: 10, Merchant: merchant, DateText: 'Jul 20, 2026', Last4: '8837' });
    assert.strictEqual(t.transactionType, 'expense', `${merchant} should not be held for direction`);
  }
});

test('a Zelle with no memo still resolves', () => {
  const t = zelle({ Amount: 60.23, Merchant: 'Zelle from SHARON LEE', DateText: 'Jul 20, 2026',
                    Last4: '8837' });
  assert.strictEqual(t.transactionType, 'income');
  assert.strictEqual(t.description, 'Zelle from SHARON LEE');
});

test('two Zelle payments from the same person on one day are distinguishable by memo', () => {
  const a = zelle({ Amount: 60.23, Merchant: 'Zelle from SHARON LEE / Mr. Kimchi',
                    DateText: 'Jul 20, 2026', Last4: '8837' });
  const b = zelle({ Amount: 60.23, Merchant: 'Zelle from SHARON LEE / rent',
                    DateText: 'Jul 20, 2026', Last4: '8837' });
  assert.notStrictEqual(a.tellerTransactionId, b.tellerTransactionId,
    'the memo is what keeps two same-day, same-amount transfers apart');
});

// ---------------------------------------------------------------------------
// the category default
// ---------------------------------------------------------------------------

test('an unclassifiable purchase defaults to personal, not to an empty category', () => {
  const t = build({ DateText: 'Aug 1, 2026 at 1:36 AM', Amount: 42,
                    Merchant: 'ARMO GRILL WHEELING', Last4: '8923' }, { cardLast4Map: ALL_CARDS });
  assert.strictEqual(t.category, DEFAULT_CATEGORY);
  assert.strictEqual(t.category, 'personal');
});

test('a matching classifier rule still wins over the default', () => {
  // These rules encode real knowledge — groceries drive needToBePaidback and the monthly return —
  // so defaulting must fill the gap the classifier leaves, not replace the classifier.
  const groceries = build({ amount: 93.87, description: 'ALDI 12345', date: '2026-02-10' });
  assert.strictEqual(groceries.category, 'parents-monthly');
  assert.strictEqual(groceries.needToBePaidback, true, 'the paid-back link survives');

  const pilates = build({ amount: 168, description: 'WWW.SWAN-DIVEPILATES', date: '2026-08-01' });
  assert.strictEqual(pilates.category, 'bill');
});

test('an explicit category always wins, including over a classifier rule', () => {
  const t = build({ amount: 93.87, description: 'ALDI 12345', date: '2026-02-10',
                    category: 'personal' });
  assert.strictEqual(t.category, 'personal');
  assert.strictEqual(t.needToBePaidback, false);
});

test('an empty or whitespace category counts as not supplied', () => {
  // A Shortcut whose picker was dismissed sends "" rather than omitting the field.
  for (const category of ['', '   ', null]) {
    const t = build({ amount: 42, description: 'ARMO GRILL', date: '2026-08-01', category });
    assert.strictEqual(t.category, 'personal', `${JSON.stringify(category)} should default`);
  }
});

test('defaulting to personal never fabricates a paid-back obligation', () => {
  const t = build({ amount: 42, description: 'ARMO GRILL', date: '2026-08-01' });
  assert.strictEqual(t.needToBePaidback, false);
  assert.strictEqual(t.returnId, null);
});

// ---------------------------------------------------------------------------
// reviewed
// ---------------------------------------------------------------------------

test('every alert-sourced row starts unreviewed', () => {
  const t = build({ DateText: 'Aug 1, 2026 at 1:36 AM', Amount: 168,
                    Merchant: 'WWW.SWAN-DIVEPILATES', Last4: '8923' }, { cardLast4Map: ALL_CARDS });
  assert.strictEqual(t.reviewed, false);
});

test('reviewed is separable from the rest of the record, so it can be $setOnInsert', () => {
  // The controller destructures it out and writes it only on insert. If it ever stopped being a
  // top-level field, a re-post would silently mark an already-reviewed row unreviewed again.
  const t = build({ amount: 10, description: 'X', date: '2026-07-25' });
  const { reviewed, ...mutable } = t;
  assert.strictEqual(reviewed, false);
  assert.strictEqual('reviewed' in mutable, false, 'reviewed must not survive in the $set payload');
  assert.ok(mutable.amount !== undefined, 'the rest of the record is unaffected');
});

test('the Shortcut and lowercase spellings of one purchase derive the SAME id', () => {
  // Otherwise switching the Shortcut over would silently duplicate every transaction it re-sent.
  const viaShortcut = build(
    { DateText: 'Jul 29, 2026', Amount: 168, Merchant: 'WWW.SWAN-DIVEPILATES', Last4: '8923' },
    { cardLast4Map: ALL_CARDS }
  );
  const viaLedger = build(
    { date: '2026-07-29', amount: 168, description: 'WWW.SWAN-DIVEPILATES',
      paymentMethod: 'Freedom Unlimited' },
    { cardLast4Map: ALL_CARDS }
  );
  assert.strictEqual(viaShortcut.tellerTransactionId, viaLedger.tellerTransactionId);
});
