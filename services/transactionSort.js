/**
 * One order for transactions, shared by every endpoint that returns them.
 *
 * THE RULE: date first, newest first. Time is consulted ONLY to break a tie between rows on the
 * same date. A row with no time keeps its place rather than being treated as midnight.
 *
 * Sorted here rather than in each page because there are several consumers — the ledger grid, the
 * payee summary, the phone view — and every one of them was previously left to impose its own
 * order, or to impose none. `sort({ date: -1 })` in Mongo gets the day right and says nothing about
 * what happens within it, and the month endpoint was sorting the opposite way entirely.
 *
 * Time cannot be sorted in Mongo: it is stored as the alert printed it ("8:51 PM ET"), and a string
 * comparison puts "10:00 AM" before "9:00 AM". It has to be parsed, so it has to be done here.
 */

/**
 * "8:51 PM ET" as minutes past midnight, or -1 when there is no usable time.
 *
 * -1 sorts such rows last under a descending comparison. That is deliberate: a row that does not
 * say when it happened should not be presented as though it happened after one that does. Almost
 * every row in this ledger predates the `time` field, so this is the ordinary case.
 */
function minutesIntoDay(time) {
  if (typeof time !== 'string') return -1;
  const match = /^(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(time.trim());
  if (!match) return -1;

  // Validate BEFORE the modulo. Checking `hour % 12 > 11` can never fail, so "25:00 PM" was
  // reduced to 1 and accepted as 1 PM rather than rejected.
  const rawHour = Number(match[1]);
  const minute = Number(match[2]);
  if (rawHour < 1 || rawHour > 12 || minute > 59) return -1;

  return ((rawHour % 12) + (/pm/i.test(match[3]) ? 12 : 0)) * 60 + minute;
}

/**
 * Newest first.
 *
 * `date` is YYYY-MM-DD, which compares correctly as a string — and the comparison returns before
 * time is ever looked at, so a late-night purchase never outranks the following morning.
 */
function compareNewestFirst(a, b) {
  const dateA = String((a && a.date) || '');
  const dateB = String((b && b.date) || '');
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;

  const byTime = minutesIntoDay(b && b.time) - minutesIntoDay(a && a.time);
  if (byTime !== 0) return byTime;

  // A stable last resort, so rows that are equal on both counts do not swap places between
  // requests and make a grid look like it is shuffling itself.
  return String((b && b._id) || '').localeCompare(String((a && a._id) || ''));
}

/** A new array, newest first. Does not disturb the caller's. */
function sortNewestFirst(rows) {
  return Array.isArray(rows) ? [...rows].sort(compareNewestFirst) : [];
}

module.exports = { minutesIntoDay, compareNewestFirst, sortNewestFirst };
