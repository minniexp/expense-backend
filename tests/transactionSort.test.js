/**
 * Tests for the one order transactions are returned in.
 *
 * THE RULE these enforce: date decides. Time is consulted only when two rows fall on the same date.
 * Getting that backwards is not obvious from looking at a screen — a late-night purchase quietly
 * outranking the next morning looks like a rendering quirk, not a sorting bug.
 */

const test = require('node:test');
const assert = require('node:assert');

const { minutesIntoDay, compareNewestFirst, sortNewestFirst } = require('../services/transactionSort');

const row = (date, time, id) => ({ date, time, _id: id || `${date}-${time || 'none'}` });
const labels = (rows) => sortNewestFirst(rows).map((r) => `${r.date} ${r.time || '--'}`);

// ---------------------------------------------------------------------------
// date first, always
// ---------------------------------------------------------------------------

test('a later date wins regardless of the times involved', () => {
  // 11:59 PM is the latest clock time there is, and it still loses to the next morning.
  const late = row('2026-07-31', '11:59 PM');
  const earlyNextDay = row('2026-08-01', '1:00 AM');
  assert.ok(compareNewestFirst(late, earlyNextDay) > 0, 'Aug 1 must come first');
});

test('time is not consulted at all when the dates differ', () => {
  // A malformed time on the newer row must not demote it.
  const newer = row('2026-08-01', 'not a time');
  const older = row('2026-07-30', '9:00 AM');
  assert.ok(compareNewestFirst(newer, older) < 0);
});

test('dates sort newest first across a month and year boundary', () => {
  assert.deepStrictEqual(
    labels([row('2025-12-31'), row('2026-01-01'), row('2026-01-02')]),
    ['2026-01-02 --', '2026-01-01 --', '2025-12-31 --']
  );
});

// ---------------------------------------------------------------------------
// time, only as a tie-break
// ---------------------------------------------------------------------------

test('within one date, later times come first', () => {
  assert.deepStrictEqual(
    labels([row('2026-08-01', '1:00 AM'), row('2026-08-01', '9:30 PM'), row('2026-08-01', '11:15 AM')]),
    ['2026-08-01 9:30 PM', '2026-08-01 11:15 AM', '2026-08-01 1:00 AM']
  );
});

test('a row with no time keeps its date but sorts after rows that have one', () => {
  // It did not say when it happened, so it should not be presented as the latest thing that day.
  assert.deepStrictEqual(
    labels([row('2026-08-01', ''), row('2026-08-01', '1:00 AM')]),
    ['2026-08-01 1:00 AM', '2026-08-01 --']
  );
});

test('rows with no time at all keep a stable order rather than shuffling', () => {
  const rows = [row('2026-08-01', '', 'aaa'), row('2026-08-01', '', 'bbb')];
  assert.deepStrictEqual(sortNewestFirst(rows).map((r) => r._id), ['bbb', 'aaa']);
  assert.deepStrictEqual(sortNewestFirst([...rows].reverse()).map((r) => r._id), ['bbb', 'aaa']);
});

// ---------------------------------------------------------------------------
// parsing the clock
// ---------------------------------------------------------------------------

test('12-hour times convert correctly, including the two that catch people out', () => {
  assert.strictEqual(minutesIntoDay('12:00 AM'), 0, 'midnight is zero, not noon');
  assert.strictEqual(minutesIntoDay('12:00 PM'), 720, 'noon is 720, not zero');
  assert.strictEqual(minutesIntoDay('1:00 AM'), 60);
  assert.strictEqual(minutesIntoDay('11:59 PM'), 1439);
});

test('the trailing zone is ignored, and spacing does not matter', () => {
  assert.strictEqual(minutesIntoDay('8:51 PM ET'), minutesIntoDay('8:51 PM'));
  assert.strictEqual(minutesIntoDay('  8:51PM  '), minutesIntoDay('8:51 PM'));
  assert.strictEqual(minutesIntoDay('8:51 pm'), minutesIntoDay('8:51 PM'));
});

test('THE LEXICAL TRAP: 10:00 AM is earlier than 9:00 AM, though the strings say otherwise', () => {
  // This is why time cannot be sorted in Mongo and has to be parsed.
  assert.ok('10:00 AM' < '9:00 AM', 'as strings, 10 sorts before 9');
  assert.ok(minutesIntoDay('10:00 AM') > minutesIntoDay('9:00 AM'), 'as times, 10 is later');
});

test('anything unparseable is -1, which sorts last rather than becoming midnight', () => {
  for (const bad of ['', null, undefined, 'yesterday', '25:00 PM', '8:99 AM', 123]) {
    assert.strictEqual(minutesIntoDay(bad), -1, `${JSON.stringify(bad)} should not parse`);
  }
});

// ---------------------------------------------------------------------------
// the shape of the thing
// ---------------------------------------------------------------------------

test('sorting returns a new array and leaves the caller\'s alone', () => {
  const original = [row('2026-01-01'), row('2026-08-01')];
  const copy = [...original];
  const sorted = sortNewestFirst(original);
  assert.deepStrictEqual(original, copy, 'input must not be mutated');
  assert.notStrictEqual(sorted, original);
});

test('missing dates and non-arrays do not throw', () => {
  assert.deepStrictEqual(sortNewestFirst(null), []);
  assert.deepStrictEqual(sortNewestFirst(undefined), []);
  assert.strictEqual(sortNewestFirst([{}, {}]).length, 2);
});

test('a realistic mixed page ends up in the order a person would expect', () => {
  assert.deepStrictEqual(
    labels([
      row('2026-07-30', '8:00 AM'),
      row('2026-08-01', ''),
      row('2026-08-01', '9:30 PM'),
      row('2026-07-31', '11:59 PM'),
      row('2026-08-01', '1:00 AM'),
    ]),
    [
      '2026-08-01 9:30 PM',
      '2026-08-01 1:00 AM',
      '2026-08-01 --',
      '2026-07-31 11:59 PM',
      '2026-07-30 8:00 AM',
    ]
  );
});
