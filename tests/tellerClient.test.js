/**
 * Tests for Teller pagination + rate-limit backoff (fetchAccountTransactions).
 *
 * These cover PHASE 4 finding F2: fetching six accounts concurrently while each paginated
 * produced live `429 too_many_requests` responses. The fix (backoff + retry + honest
 * truncation reporting) was shipped without a test; this file closes that gap.
 *
 * The HTTP layer is injected, so nothing here touches the network or mTLS.
 */

const test = require('node:test');
const assert = require('node:assert');

const { fetchAccountTransactions } = require('../services/tellerClient');

// --- fake HTTP ---------------------------------------------------------------------------

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body = '{"error":"x"}') => ({
  ok: false, status, text: async () => body, json: async () => ({}),
});

/** Build `n` transactions, newest first, one per day counting back from `startDate`. */
function page(n, prefix, startDate = '2026-06-30') {
  const base = Date.UTC(
    ...startDate.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))
  );
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}_${i}`,
    date: new Date(base - i * 86400000).toISOString().slice(0, 10),
    amount: '1.00',
    description: 'X',
    status: 'posted',
  }));
}

/** Records every path requested so pagination cursors can be asserted. */
function recorder(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    get: async (path) => {
      calls.push(path);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return typeof r === 'function' ? r() : r;
    },
  };
}

const noSleep = async () => {};
const base = { pageDelayMs: 0, sleepFn: noSleep, count: 3 };

// --- pagination ---------------------------------------------------------------------------

test('a single short page ends pagination after one request', async () => {
  const r = recorder([ok(page(2, 'a'))]);
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get: r.get });

  assert.strictEqual(out.transactions.length, 2);
  assert.strictEqual(out.pages, 1);
  assert.strictEqual(out.truncated, false);
  assert.strictEqual(out.error, null);
  assert.strictEqual(r.calls.length, 1);
  assert.match(r.calls[0], /^\/accounts\/acc_1\/transactions\?count=3$/);
  assert.ok(!r.calls[0].includes('from_id'), 'first request must not carry a cursor');
});

test('a full page triggers a follow-up request cursored on the OLDEST id', async () => {
  const first = page(3, 'a');            // a_0 (newest) .. a_2 (oldest)
  const r = recorder([ok(first), ok(page(1, 'b', '2026-06-20'))]);
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get: r.get });

  assert.strictEqual(out.pages, 2);
  assert.strictEqual(out.transactions.length, 4);
  assert.match(r.calls[1], /from_id=a_2/, 'cursor must be the oldest id of the previous page');
  assert.strictEqual(out.truncated, false);
});

test('pagination stops once a page reaches older than the window start', async () => {
  const r = recorder([ok(page(3, 'a', '2026-06-30')), ok(page(3, 'b', '2020-01-01'))]);
  const out = await fetchAccountTransactions('acc_1', 'tok', {
    ...base, get: r.get, startDate: '2026-06-01',
  });
  // page 1 is full and its oldest (2026-06-28) is still inside the window => fetch page 2;
  // page 2's oldest predates the window => stop.
  assert.strictEqual(out.pages, 2);
  assert.strictEqual(out.truncated, false);
});

test('maxPages caps the walk and reports truncated', async () => {
  const r = recorder([
    ok(page(3, 'a')), ok(page(3, 'b', '2026-06-20')), ok(page(3, 'c', '2026-06-10')),
  ]);
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get: r.get, maxPages: 2 });

  assert.strictEqual(out.pages, 2);
  assert.strictEqual(out.truncated, true, 'stopping early must be reported, never silent');
  assert.strictEqual(out.transactions.length, 6);
});

test('an empty page ends pagination cleanly', async () => {
  const r = recorder([ok(page(3, 'a')), ok([])]);
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get: r.get });
  assert.strictEqual(out.transactions.length, 3);
  assert.strictEqual(out.truncated, false);
});

test('a non-array response ends pagination instead of throwing', async () => {
  const r = recorder([ok({ error: 'unexpected' })]);
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get: r.get });
  assert.strictEqual(out.transactions.length, 0);
  assert.strictEqual(out.error, null);
});

test('a stuck cursor cannot loop forever', async () => {
  // Teller keeps returning the same full page — ids repeat, so nothing fresh is added.
  const stuck = page(3, 'a');
  const r = recorder([ok(stuck), ok(stuck), ok(stuck), ok(stuck), ok(stuck)]);
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get: r.get, maxPages: 50 });

  assert.strictEqual(out.transactions.length, 3, 'repeated ids must be de-duplicated');
  assert.ok(out.pages <= 3, `expected an early bail-out, made ${out.pages} requests`);
});

test('duplicate ids across pages are de-duplicated', async () => {
  const overlap = [...page(3, 'a'), ...page(2, 'a')]; // same ids repeated
  const r = recorder([ok(overlap), ok([])]);
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get: r.get, count: 5 });
  const ids = out.transactions.map((t) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

// --- F2: rate limiting ----------------------------------------------------------------------

test('F2: a 429 is retried and can succeed', async () => {
  let n = 0;
  const get = async () => { n++; return n === 1 ? fail(429) : ok(page(2, 'a')); };
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get, sleepFn: noSleep });

  assert.strictEqual(n, 2, 'must retry once');
  assert.strictEqual(out.transactions.length, 2);
  assert.strictEqual(out.error, null);
  assert.strictEqual(out.rateLimited, false);
  assert.strictEqual(out.truncated, false);
});

test('F2: retries use increasing backoff and are bounded', async () => {
  const delays = [];
  let n = 0;
  const get = async () => { n++; return fail(429); };
  const out = await fetchAccountTransactions('acc_1', 'tok', {
    ...base, get, sleepFn: async (ms) => { delays.push(ms); }, maxRetries: 2, baseDelayMs: 700,
  });

  assert.strictEqual(n, 3, '1 initial attempt + 2 retries');
  assert.deepStrictEqual(delays, [700, 1400], 'backoff must increase');
  assert.strictEqual(out.rateLimited, true);
  assert.strictEqual(out.truncated, true);
  assert.match(out.error, /429/);
});

test('F2: a persistent 429 returns the pages already collected, not nothing', async () => {
  // Partial data is more useful than none, provided the shortfall is reported.
  let n = 0;
  const get = async () => { n++; return n === 1 ? ok(page(3, 'a')) : fail(429); };
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get, sleepFn: noSleep });

  assert.strictEqual(out.transactions.length, 3, 'page 1 must be kept');
  assert.strictEqual(out.rateLimited, true);
  assert.strictEqual(out.truncated, true);
});

test('a non-429 error is NOT retried', async () => {
  let n = 0;
  const get = async () => { n++; return fail(401, 'unauthorized'); };
  const out = await fetchAccountTransactions('acc_1', 'tok', { ...base, get, sleepFn: noSleep });

  assert.strictEqual(n, 1, 'auth failures must fail fast, not burn the backoff budget');
  assert.strictEqual(out.rateLimited, false);
  assert.strictEqual(out.truncated, true);
  assert.match(out.error, /401/);
});

test('follow-up pages are spaced out, the first is not', async () => {
  const delays = [];
  const r = recorder([ok(page(3, 'a')), ok(page(1, 'b', '2026-06-20'))]);
  await fetchAccountTransactions('acc_1', 'tok', {
    ...base, get: r.get, pageDelayMs: 250, sleepFn: async (ms) => { delays.push(ms); },
  });
  assert.deepStrictEqual(delays, [250], 'exactly one inter-page delay, none before page 1');
});
