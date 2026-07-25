/**
 * Tests for the Teller → MongoDB sync diff.
 *
 * Run with:  npm test        (node --test, built in on Node 18+; no dependencies)
 *
 * The whole point of services/transactionSync.js is that these decisions are pure functions —
 * no Teller connection, no Mongo connection, no Express. Everything below runs offline.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  EXCLUDED_PHRASES,
  MAX_LOOKBACK_DAYS,
  isExcludedDescription,
  resolveWindowStart,
  amountKey,
  diffTellerTransactions,
} = require('../services/transactionSync');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const txn = (over = {}) => ({
  id: 'txn_1',
  date: '2026-06-26',
  amount: '12.34',
  description: 'SOME MERCHANT',
  status: 'posted',
  ...over,
});

const logged = (over = {}) => ({
  tellerTransactionId: 'txn_1',
  date: '2026-06-26',
  amount: 12.34,
  paymentMethod: 'Freedom',
  ...over,
});

// ---------------------------------------------------------------------------
// THE REGRESSION TEST — this is the reported bug.
// ---------------------------------------------------------------------------

test('REGRESSION: a transaction dated exactly on the old watermark is still returned', () => {
  // Chase posted a second transaction on 2026-06-26 after one from that day was already
  // saved, so the old `date > lastDate` filter dropped it forever.
  const alreadySaved = logged({ tellerTransactionId: 'txn_saved', date: '2026-06-26', amount: 50 });
  const lateArrival = txn({ id: 'txn_late', date: '2026-06-26', amount: '432.75',
    description: 'EMPLOYER PAYROLL ACH' });

  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Chase College', transaction: txn({ id: 'txn_saved', date: '2026-06-26', amount: '50.00' }) },
      { cardName: 'Chase College', transaction: lateArrival },
    ],
    loggedTransactions: [alreadySaved],
    windowStart: '2026-01-01',
  });

  const ids = result.newTransactions.map((t) => t.tellerTransactionId);
  assert.deepStrictEqual(ids, ['txn_late'],
    'the late-arriving same-day transaction must be offered for review');
  assert.strictEqual(result.summary.alreadyLogged, 1);
  assert.strictEqual(result.summary.newCount, 1);
});

test('REGRESSION: a transaction dated BEFORE the newest saved one is still returned', () => {
  // Backdated postings — Chase reports the transaction date, not the posting date.
  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Freedom', transaction: txn({ id: 'txn_old', date: '2026-03-02' }) },
    ],
    loggedTransactions: [logged({ tellerTransactionId: 'txn_new', date: '2026-06-26' })],
    windowStart: '2026-01-01',
  });

  assert.deepStrictEqual(result.newTransactions.map((t) => t.tellerTransactionId), ['txn_old']);
});

test('a transaction already in MongoDB is never re-offered', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'txn_dup' }) }],
    loggedTransactions: [logged({ tellerTransactionId: 'txn_dup' })],
    windowStart: '2026-01-01',
  });

  assert.strictEqual(result.newTransactions.length, 0);
  assert.strictEqual(result.summary.alreadyLogged, 1);
});

test('the diff is idempotent — an unsaved transaction reappears on every fetch', () => {
  const args = {
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'txn_x' }) }],
    loggedTransactions: [],
    windowStart: '2026-01-01',
  };
  const a = diffTellerTransactions(args);
  const b = diffTellerTransactions(args);
  assert.strictEqual(a.newTransactions.length, 1);
  assert.deepStrictEqual(
    a.newTransactions.map((t) => t.tellerTransactionId),
    b.newTransactions.map((t) => t.tellerTransactionId)
  );
});

// ---------------------------------------------------------------------------
// exclusion phrases
// ---------------------------------------------------------------------------

test('the real Chase autopay strings are excluded', () => {
  // Verified against the full live transaction history before being added.
  for (const d of [
    'AUTOMATIC PAYMENT - THANK YOU',
    'CHASE CREDIT CRD AUTOPAY PPD ID: 0000000000',
    'Payment Thank You-Mobile',
    'Payment Thank You - Web',
    'Payment to Chase card ending in 0000 06/11',
    'Online Transfer 00000000 to Brokerage',
  ]) {
    assert.ok(isExcludedDescription(d), `"${d}" should be excluded`);
  }
});

test('real spending that merely contains the word PAYMENT is NOT excluded', () => {
  // Regression guard against over-broad phrases: these are genuine transactions.
  for (const d of [
    'VENMO PAYMENT 0000000000 WEB ID: 0000000000',
    'ATT* BILL PAYMENT 800-331-0500',
    'Zelle payment from JANE DOE 0000000001',
    'Zelle payment to John Roe 0000000002',
  ]) {
    assert.ok(!isExcludedDescription(d), `"${d}" must NOT be excluded`);
  }
});

test('exclusion matching is case- and whitespace-insensitive', () => {
  assert.ok(isExcludedDescription('automatic payment - thank you'));
  assert.ok(isExcludedDescription('AUTOMATIC   PAYMENT  -  THANK YOU'));
  assert.ok(isExcludedDescription('ONLINE TRANSFER 123 TO SCHWAB'));
});

test('a missing or non-string description does not throw', () => {
  assert.strictEqual(isExcludedDescription(undefined), false);
  assert.strictEqual(isExcludedDescription(null), false);
  assert.strictEqual(isExcludedDescription(''), false);
});

test('excluded transactions are counted, not silently vanished', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Freedom', transaction: txn({ id: 'a', description: 'AUTOMATIC PAYMENT - THANK YOU' }) },
      { cardName: 'Freedom', transaction: txn({ id: 'b', description: 'REAL MERCHANT' }) },
    ],
    loggedTransactions: [],
    windowStart: '2026-01-01',
  });
  assert.strictEqual(result.summary.excluded, 1);
  assert.strictEqual(result.newTransactions.length, 1);
});

// ---------------------------------------------------------------------------
// lookback window
// ---------------------------------------------------------------------------

test('resolveWindowStart computes a day-count window from today', () => {
  assert.strictEqual(resolveWindowStart({ days: 90 }, '2026-07-25'), '2026-04-26');
  assert.strictEqual(resolveWindowStart({ days: 30 }, '2026-07-25'), '2026-06-25');
});

test('resolveWindowStart handles month and year boundaries', () => {
  assert.strictEqual(resolveWindowStart({ days: 1 }, '2026-01-01'), '2025-12-31');
  assert.strictEqual(resolveWindowStart({ days: 1 }, '2026-03-01'), '2026-02-28'); // non-leap
  assert.strictEqual(resolveWindowStart({ days: 1 }, '2024-03-01'), '2024-02-29'); // leap
});

test('resolveWindowStart supports "all" and an explicit since date', () => {
  assert.strictEqual(resolveWindowStart({ all: true }, '2026-07-25'), null);
  assert.strictEqual(resolveWindowStart({ since: '2025-01-01' }, '2026-07-25'), '2025-01-01');
});

test('resolveWindowStart defaults to 90 days and rejects junk input', () => {
  assert.strictEqual(resolveWindowStart({}, '2026-07-25'), '2026-04-26');
  assert.strictEqual(resolveWindowStart({ days: 'banana' }, '2026-07-25'), '2026-04-26');
  assert.strictEqual(resolveWindowStart({ days: -5 }, '2026-07-25'), '2026-04-26');
  assert.strictEqual(resolveWindowStart({ days: 0 }, '2026-07-25'), '2026-04-26');
  assert.strictEqual(resolveWindowStart({ since: 'not-a-date' }, '2026-07-25'), '2026-04-26');
});

test('PHASE 4 / F4: an absurd days value is clamped instead of crashing', () => {
  // `days` comes straight off the query string. Unclamped, this pushed the computed date
  // outside the representable Date range and toISOString() threw RangeError => HTTP 500.
  for (const days of [999999999999999, 1e21, Number.MAX_SAFE_INTEGER]) {
    let out;
    assert.doesNotThrow(() => { out = resolveWindowStart({ days }, '2026-07-25'); },
      `days=${days} must not throw`);
    assert.match(out, /^\d{4}-\d{2}-\d{2}$/, `days=${days} must still yield a valid ISO date`);
  }
  assert.strictEqual(
    resolveWindowStart({ days: 1e21 }, '2026-07-25'),
    resolveWindowStart({ days: MAX_LOOKBACK_DAYS }, '2026-07-25'),
    'anything past the ceiling collapses to the ceiling'
  );
});

test('transactions older than the window are counted separately, not treated as new', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Freedom', transaction: txn({ id: 'old', date: '2023-01-01' }) },
      { cardName: 'Freedom', transaction: txn({ id: 'new', date: '2026-06-26' }) },
    ],
    loggedTransactions: [],
    windowStart: '2026-01-01',
  });
  assert.deepStrictEqual(result.newTransactions.map((t) => t.tellerTransactionId), ['new']);
  assert.strictEqual(result.summary.outsideWindow, 1);
});

test('a null windowStart means no lower bound', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'ancient', date: '2019-01-01' }) }],
    loggedTransactions: [],
    windowStart: null,
  });
  assert.strictEqual(result.newTransactions.length, 1);
  assert.strictEqual(result.summary.outsideWindow, 0);
});

test('a transaction exactly ON the window start is included (boundary is inclusive)', () => {
  // The old bug was an exclusive boundary. Do not reintroduce one.
  const result = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'edge', date: '2026-01-01' }) }],
    loggedTransactions: [],
    windowStart: '2026-01-01',
  });
  assert.strictEqual(result.newTransactions.length, 1, 'window start must be inclusive');
});

// ---------------------------------------------------------------------------
// count-aware duplicate flagging  (see the module header)
// ---------------------------------------------------------------------------

test('two identical real transactions both saved => neither of them flags anything', () => {
  // Real pattern from production data: the same card charged the same amount at the same
  // merchant twice on one day, and both charges were genuine.
  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Freedom Flex', transaction: txn({ id: 'sp1', date: '2024-09-04', amount: '500.00', description: 'FUEL STATION 00000' }) },
      { cardName: 'Freedom Flex', transaction: txn({ id: 'sp2', date: '2024-09-04', amount: '500.00', description: 'FUEL STATION 00000' }) },
      { cardName: 'Freedom Flex', transaction: txn({ id: 'sp3', date: '2024-09-04', amount: '500.00', description: 'FUEL STATION 00000' }) },
    ],
    loggedTransactions: [
      logged({ tellerTransactionId: 'sp1', date: '2024-09-04', amount: 500, paymentMethod: 'Freedom Flex' }),
      logged({ tellerTransactionId: 'sp2', date: '2024-09-04', amount: 500, paymentMethod: 'Freedom Flex' }),
    ],
    windowStart: '2024-01-01',
  });

  // sp3 is genuinely new: both DB rows are claimed by sp1 and sp2.
  assert.deepStrictEqual(result.newTransactions.map((t) => t.tellerTransactionId), ['sp3']);
  assert.strictEqual(result.newTransactions[0].possibleDuplicate, false,
    'must NOT flag when every existing row is claimed by another incoming transaction');
});

test('a re-issued pending transaction IS flagged as a possible duplicate', () => {
  // The old pending id is no longer returned by Teller, so its DB row is unclaimed.
  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Freedom', transaction: txn({ id: 'txn_posted_new', date: '2026-06-26', amount: '42.00', description: 'CAFE' }) },
    ],
    loggedTransactions: [
      logged({ tellerTransactionId: 'txn_pending_old', date: '2026-06-26', amount: 42, paymentMethod: 'Freedom' }),
    ],
    windowStart: '2026-01-01',
  });

  assert.strictEqual(result.newTransactions.length, 1, 'never hide it — only flag it');
  assert.strictEqual(result.newTransactions[0].possibleDuplicate, true);
  assert.match(result.newTransactions[0].duplicateReason, /txn_pending_old/);
  assert.strictEqual(result.summary.possibleDuplicates, 1);
});

test('the duplicate flag tolerates a date shift of up to 3 days', () => {
  const within = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'new', date: '2026-06-29', amount: '42.00' }) }],
    loggedTransactions: [logged({ tellerTransactionId: 'old', date: '2026-06-26', amount: 42, paymentMethod: 'Freedom' })],
    windowStart: '2026-01-01',
  });
  assert.strictEqual(within.newTransactions[0].possibleDuplicate, true, '3 days => flagged');

  const beyond = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'new', date: '2026-06-30', amount: '42.00' }) }],
    loggedTransactions: [logged({ tellerTransactionId: 'old', date: '2026-06-26', amount: 42, paymentMethod: 'Freedom' })],
    windowStart: '2026-01-01',
  });
  assert.strictEqual(beyond.newTransactions[0].possibleDuplicate, false, '4 days => not flagged');
});

test('the duplicate flag never crosses cards or amounts', () => {
  const otherCard = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'n', amount: '42.00' }) }],
    loggedTransactions: [logged({ tellerTransactionId: 'o', amount: 42, paymentMethod: 'Sapphire Reserve' })],
    windowStart: '2026-01-01',
  });
  assert.strictEqual(otherCard.newTransactions[0].possibleDuplicate, false);

  const otherAmount = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'n', amount: '42.00' }) }],
    loggedTransactions: [logged({ tellerTransactionId: 'o', amount: 42.01, paymentMethod: 'Freedom' })],
    windowStart: '2026-01-01',
  });
  assert.strictEqual(otherAmount.newTransactions[0].possibleDuplicate, false);
});

test('one unclaimed DB row flags only ONE incoming candidate, not all of them', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Freedom', transaction: txn({ id: 'c1', date: '2026-06-26', amount: '42.00' }) },
      { cardName: 'Freedom', transaction: txn({ id: 'c2', date: '2026-06-26', amount: '42.00' }) },
    ],
    loggedTransactions: [logged({ tellerTransactionId: 'gone', date: '2026-06-26', amount: 42, paymentMethod: 'Freedom' })],
    windowStart: '2026-01-01',
  });
  const flagged = result.newTransactions.filter((t) => t.possibleDuplicate);
  assert.strictEqual(flagged.length, 1, 'one unclaimed row must not flag two candidates');
});

test('amountKey normalises Teller strings and Mongo numbers to the same key', () => {
  assert.strictEqual(amountKey('-17.79'), amountKey(-17.79));
  assert.strictEqual(amountKey('42'), amountKey(42.0));
  assert.strictEqual(amountKey('42.00'), amountKey(42));
  assert.strictEqual(amountKey(0), amountKey('-0.00'), 'negative zero must not split the key');
});

// ---------------------------------------------------------------------------
// mapping / shape
// ---------------------------------------------------------------------------

test('the mapped output keeps the fields the frontend and Mongo schema require', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [{
      cardName: 'Freedom Unlimited',
      transaction: txn({ id: 'txn_m', date: '2026-05-17', amount: '31.50', description: 'ALDI 00000' }),
    }],
    loggedTransactions: [],
    windowStart: '2026-01-01',
    userId: 'user_1',
  });

  const t = result.newTransactions[0];
  assert.strictEqual(t.tellerTransactionId, 'txn_m');
  assert.strictEqual(t.date, '2026-05-17');
  assert.strictEqual(t.year, 2026);
  assert.strictEqual(t.month, 5);
  assert.strictEqual(t.day, 17);
  assert.strictEqual(t.amount, 31.5, 'amount must be a Number, not the Teller string');
  assert.strictEqual(t.paymentMethod, 'Freedom Unlimited');
  assert.strictEqual(t.userId, 'user_1');
  assert.strictEqual(t.category, 'parents-monthly', 'ALDI => parents-monthly');
  assert.deepStrictEqual(t.purchaseCategory, ['groceries']);
  assert.strictEqual(t.needToBePaidback, true);
  assert.strictEqual(t.status, 'posted');
});

test('pending transactions are surfaced and marked', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'p', status: 'pending' }) }],
    loggedTransactions: [],
    windowStart: '2026-01-01',
  });
  assert.strictEqual(result.newTransactions[0].status, 'pending');
  assert.strictEqual(result.summary.pending, 1);
});

test('results are sorted newest first', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Freedom', transaction: txn({ id: 'a', date: '2026-02-01' }) },
      { cardName: 'Freedom', transaction: txn({ id: 'c', date: '2026-06-01' }) },
      { cardName: 'Freedom', transaction: txn({ id: 'b', date: '2026-04-01' }) },
    ],
    loggedTransactions: [],
    windowStart: '2026-01-01',
  });
  assert.deepStrictEqual(result.newTransactions.map((t) => t.tellerTransactionId), ['c', 'b', 'a']);
});

test('malformed transactions are skipped without throwing', () => {
  const result = diffTellerTransactions({
    tellerTransactions: [
      { cardName: 'Freedom', transaction: { id: 'no_date', amount: '1.00', description: 'X' } },
      { cardName: 'Freedom', transaction: { id: 'bad_date', date: '26/06/2026', amount: '1.00', description: 'X' } },
      { cardName: 'Freedom', transaction: { date: '2026-06-26', amount: '1.00', description: 'no id' } },
      { cardName: 'Freedom', transaction: txn({ id: 'ok' }) },
    ],
    loggedTransactions: [],
    windowStart: '2026-01-01',
  });
  assert.deepStrictEqual(result.newTransactions.map((t) => t.tellerTransactionId), ['ok']);
  assert.strictEqual(result.summary.malformed, 3);
});

test('logged transactions with no tellerTransactionId do not break the diff', () => {
  // 32 of the 903 live rows were entered by hand and have no Teller id.
  const result = diffTellerTransactions({
    tellerTransactions: [{ cardName: 'Freedom', transaction: txn({ id: 'x', amount: '99.00' }) }],
    loggedTransactions: [
      { date: '2026-06-26', amount: 99, paymentMethod: 'Freedom' }, // manual entry, no id
    ],
    windowStart: '2026-01-01',
  });
  assert.strictEqual(result.newTransactions.length, 1);
  assert.strictEqual(result.newTransactions[0].possibleDuplicate, true,
    'a manual entry with the same card/amount/date should still raise the advisory flag');
  assert.match(result.newTransactions[0].duplicateReason, /manual entry/);
});

test('EXCLUDED_PHRASES keeps the original entries (no silent removals)', () => {
  for (const p of [
    'Payment to Chase card ending in',
    'Payment Thank You-Mobile',
    'Online Transfer',
  ]) {
    assert.ok(EXCLUDED_PHRASES.some((e) => e.toLowerCase() === p.toLowerCase()),
      `original phrase "${p}" must be retained`);
  }
});
