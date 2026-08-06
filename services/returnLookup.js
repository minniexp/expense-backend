/**
 * Which return document a given month's reclaimable spending belongs to.
 *
 * WHY AN ENV VAR AND NOT A QUERY. The obvious approach — find the Return whose date falls in that
 * month — is ambiguous in this data: five months hold more than one. January 2025 has three (a
 * flight for Mom, a flight for Dad, and that month's 생활비). Only an explicit mapping can say which
 * of them is the *monthly* return, so the mapping is configuration, not something to infer.
 *
 * WHY THE NAMES LEAD WITH LETTERS. The original form was `2026_AUG_RETURNID`, which Vercel refuses:
 *
 *     The name of your Environment Variable contains invalid characters. Only letters, digits, and
 *     underscores are allowed. Furthermore, the name should not start with a digit.
 *
 * So production had them without the year — `AUG_RETURNID` — which cannot distinguish August 2025
 * from August 2026 and would file a 2025 transaction against a 2026 return. The canonical name is
 * now `RETURNID_<year>_<MON>`, which Vercel accepts and which keeps the year.
 *
 * The old `<year>_<MON>_RETURNID` form is still read as a fallback so an existing local .env keeps
 * working. The un-prefixed `<MON>_RETURNID` deliberately is NOT: guessing the year is how a
 * transaction ends up attached to the wrong year's return, silently.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The env var name to set. Exported so a script can list exactly what is missing. */
function returnIdEnvName(year, month) {
  const key = MONTHS[Number(month) - 1];
  return key ? `RETURNID_${year}_${key}` : null;
}

/**
 * @param {number|string} year
 * @param {number|string} month  1-12
 * @param {object} [env]  injectable for tests
 * @returns {string|null} the return document id, or null when none is configured
 */
function returnIdForMonth(year, month, env = process.env) {
  const key = MONTHS[Number(month) - 1];
  if (!key || !year) return null;
  return env[`RETURNID_${year}_${key}`] || env[`${year}_${key}_RETURNID`] || null;
}

module.exports = { MONTHS, returnIdEnvName, returnIdForMonth };
