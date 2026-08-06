/**
 * Tests for which return document a month's reclaimable spending belongs to.
 *
 * The failure this guards against is quiet: a transaction attached to the wrong year's return still
 * saves, still shows a returnId, and still looks right on its own row. It only surfaces when a
 * total does not reconcile, months later.
 */

const test = require('node:test');
const assert = require('node:assert');

const { MONTHS, returnIdEnvName, returnIdForMonth } = require('../services/returnLookup');

test('the canonical name leads with letters, because Vercel rejects a leading digit', () => {
  // "The name of your Environment Variable ... should not start with a digit."
  assert.strictEqual(returnIdEnvName(2026, 8), 'RETURNID_2026_AUG');
  assert.strictEqual(returnIdEnvName(2026, 1), 'RETURNID_2026_JAN');
  assert.strictEqual(returnIdEnvName(2025, 12), 'RETURNID_2025_DEC');
  assert.ok(!/^\d/.test(returnIdEnvName(2026, 8)), 'must not start with a digit');
});

test('August 2026 resolves from the canonical name', () => {
  const env = { RETURNID_2026_AUG: 'aug2026' };
  assert.strictEqual(returnIdForMonth(2026, 8, env), 'aug2026');
});

test('the older local-only name still resolves, so an existing .env keeps working', () => {
  const env = { '2026_AUG_RETURNID': 'aug2026' };
  assert.strictEqual(returnIdForMonth(2026, 8, env), 'aug2026');
});

test('the canonical name wins when both are present', () => {
  const env = { RETURNID_2026_AUG: 'canonical', '2026_AUG_RETURNID': 'legacy' };
  assert.strictEqual(returnIdForMonth(2026, 8, env), 'canonical');
});

test('THE YEAR-BLIND NAME IS IGNORED, deliberately', () => {
  // Production held AUG_RETURNID because the year-prefixed form could not be set. Reading it would
  // attach an August 2025 transaction to the August 2026 return and never say so.
  const env = { AUG_RETURNID: 'year-unknown' };
  assert.strictEqual(returnIdForMonth(2026, 8, env), null);
  assert.strictEqual(returnIdForMonth(2025, 8, env), null);
});

test('the same month in different years resolves differently', () => {
  const env = { RETURNID_2025_AUG: 'aug2025', RETURNID_2026_AUG: 'aug2026' };
  assert.strictEqual(returnIdForMonth(2025, 8, env), 'aug2025');
  assert.strictEqual(returnIdForMonth(2026, 8, env), 'aug2026');
});

test('an unconfigured month is null, not undefined or a stray value', () => {
  assert.strictEqual(returnIdForMonth(2026, 3, { RETURNID_2026_AUG: 'aug' }), null);
  assert.strictEqual(returnIdForMonth(2099, 1, {}), null);
});

test('every month maps to a distinct name, and only twelve exist', () => {
  const names = new Set();
  for (let m = 1; m <= 12; m++) names.add(returnIdEnvName(2026, m));
  assert.strictEqual(names.size, 12);
  assert.strictEqual(MONTHS.length, 12);
});

test('a month outside 1-12 yields no name and no id rather than throwing', () => {
  for (const bad of [0, 13, -1, null, undefined, 'x']) {
    assert.strictEqual(returnIdEnvName(2026, bad), null, `month ${bad}`);
    assert.strictEqual(returnIdForMonth(2026, bad, { RETURNID_2026_AUG: 'x' }), null);
  }
});

test('a missing year yields null rather than looking up "undefined"', () => {
  assert.strictEqual(returnIdForMonth(undefined, 8, { RETURNID_undefined_AUG: 'oops' }), null);
});
