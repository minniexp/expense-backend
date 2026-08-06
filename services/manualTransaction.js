const crypto = require('crypto');
const {
  parseIsoDate,
  determineCategory,
  determinePurchaseCategory,
  calculatePoints,
} = require('./transactionSync');

/**
 * Turn a terse manually-submitted payload into a full ledger row.
 *
 * The phone sends the minimum it reasonably can:
 *
 *   {"amount": 37.57, "description": "Zelle payment from HYEON M YANG",
 *    "date": "2026-07-25", "notes": "gas"}
 *
 * Everything else — transaction type, payment method, category, points, year/month/day, and a
 * stable identifier — is derived here. Pure functions only: no database, no HTTP, no clock
 * beyond what is passed in, so it is unit-testable offline like the other services.
 *
 * Three rules govern the derivation, in order:
 *   1. An explicit value in the payload always wins.
 *   2. Otherwise a description rule decides.
 *   3. Otherwise fall back to the sign of the amount and a default account.
 */

/**
 * Description patterns that determine direction and account.
 *
 * The amount's sign is NOT sufficient. A Shortcut naturally sends a positive number, so
 * "Zelle payment to Anna" — money leaving — would be read as income if only the sign were
 * consulted. The description is the one reliable signal for direction.
 *
 * Ordered: the first match wins. Extend as new recurring descriptions appear.
 */
const DESCRIPTION_RULES = [
  // "payment" is optional so one rule covers both wordings this ledger sees: the bank feed's
  // "Zelle payment from HYEON M YANG", and the shorter "Zelle from SHARON LEE / Mr. Kimchi" that an
  // alert-driven Shortcut composes from the sender's name and the memo.
  { match: /zelle\s+(?:payment\s+)?from/i, transactionType: 'income', paymentMethod: 'Chase College' },
  { match: /zelle\s+(?:payment\s+)?to/i, transactionType: 'expense', paymentMethod: 'Chase College' },

  // Payroll, filed against the checking account the deposit actually lands in.
  //
  // A rule can pin `category` and `points` as well as the two fields above, which is what lets one
  // entry express everything that is always true of a payroll deposit. `points: 0` is deliberately
  // stated rather than left to calculatePoints() — that function already returns 0 for Chase
  // College, but the rule should not quietly depend on a rewards table it has no stake in.
  {
    match: /direct\s+deposit\s*[-–—]?\s*payroll/i,
    transactionType: 'income',
    paymentMethod: 'Chase College',
    category: 'payroll',
    points: 0,
  },
];

/**
 * A Zelle transfer whose description does not say which way the money went.
 *
 * "Zelle - SHARON LEE" reads fine to a person and tells this code nothing: the amount arrives
 * positive either way, so the fallback would file received money as money spent, and the checking
 * account's sign convention would then store it negative. A $60 credit becomes a $60 debit, and
 * nothing downstream would ever contradict it.
 */
const ZELLE = /\bzelle\b/i;

const VALID_TYPES = ['income', 'expense'];
const DEFAULT_PAYMENT_METHOD = 'Cash';

/**
 * Where a transaction lands when nothing else has an opinion.
 *
 * The classifiers return an empty string when no rule matches, which is a legal category but an
 * unhelpful one — it reads as "not yet decided" in the UI and sorts into no bucket in any summary.
 * Most spending is personal, so that is the honest default, and the `reviewed` flag is what marks
 * it as still needing a human rather than an empty field standing in for the same thing.
 */
const DEFAULT_CATEGORY = 'personal';

/** First matching rule, or null. Never guesses. */
function resolveDescriptionRule(description) {
  if (typeof description !== 'string') return null;
  return DESCRIPTION_RULES.find((r) => r.match.test(description)) || null;
}

/**
 * A map keyed by a card's last four digits, parsed from a comma-separated env var:
 *
 *   CARD_LAST4_MAP="8923:Freedom Unlimited,1234:Freedom Flex"
 *   CARD_CATEGORY_MAP="8016:parents-monthly"
 *
 * A bank alert email names the card by its last four digits and nothing else, so something has to
 * turn "8923" into an account this ledger recognises. Doing it here rather than in the sender keeps
 * one copy of the mapping: a phone does not have to be re-edited when a card is replaced.
 *
 * Environment rather than a constant in this file for two reasons — the digits stay out of a
 * repository that lives on GitHub, and adding a card becomes a config change rather than a deploy.
 *
 * The resolved name must be one of the names the rest of the app already uses (PAYMENT_METHODS in
 * the frontend's utils/constants.js). That string equality is load-bearing three times over:
 *
 *   - normalizeAmountSign() reads it to decide the row's sign. 'Chase College' and 'Cash' treat a
 *     positive figure as money arriving; every credit card treats it as a charge. A name it does
 *     not recognise is filed with the credit-card convention by default.
 *   - calculatePoints() rewards by card, so a misspelling silently earns zero.
 *   - the /my dropdowns list those exact strings, so anything else is uneditable in the UI.
 *
 * Alerts are now the only source of transactions — the Teller bank feed is retired — so nothing
 * downstream will notice and correct a wrong card name later.
 */
function parseCardLast4Map(raw) {
  const map = {};
  if (typeof raw !== 'string') return map;
  for (const entry of raw.split(',')) {
    // indexOf rather than split(':') so a card name containing a colon survives intact.
    const separator = entry.indexOf(':');
    if (separator === -1) continue;
    const last4 = entry.slice(0, separator).trim();
    const cardName = entry.slice(separator + 1).trim();
    if (/^\d{4}$/.test(last4) && cardName) map[last4] = cardName;
  }
  return map;
}

/** The card those four digits belong to, or null. Never guesses. */
function resolveCardFromLast4(last4, map) {
  const digits = String(last4 === undefined || last4 === null ? '' : last4).trim();
  if (!/^\d{4}$/.test(digits)) return null;
  return (map && map[digits]) || null;
}

/**
 * Month names as the alert email writes them. A lookup rather than `new Date("Jul 29, 2026")`,
 * which resolves against the server's timezone and would shift the day across a UTC boundary — the
 * one thing this file is careful never to do. It also keeps the module honest about having no clock.
 */
const MONTH_ABBREVIATIONS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The date line of an alert, as Chase writes it, split into its parts.
 *
 *   "Jul 29, 2026"                 -> { date: '2026-07-29', time: '' }
 *   "Aug 1, 2026 at 1:36 AM"       -> { date: '2026-08-01', time: '1:36 AM' }
 *   "Jul 29, 2026 at 8:51 PM ET"   -> { date: '2026-07-29', time: '8:51 PM ET' }
 *
 * The trailing clock time is optional because the alert row reads "Aug 1, 2026 at 1:36 AM" as one
 * string, and a sender that captures that row whole should not be punished for it — requiring the
 * date alone made a correct-looking Shortcut fail with nothing to show for it. When the time comes
 * along it is kept rather than discarded, so the phone need not extract it separately.
 *
 * Tolerates the full month name, a trailing dot, and a missing comma ("September 3 2026",
 * "Sept. 3, 2026"). Deliberately does NOT validate the calendar — it composes the string and lets
 * the existing parseIsoDate check reject 30 February, so there is one date validator, not two.
 */
const ALERT_DATE = new RegExp(
  '^\\s*([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})\\s*,?\\s+(\\d{4})'      // Jul 29, 2026
  + '(?:\\s+at\\s+(\\d{1,2}:\\d{2}\\s*[AP]M)(?:\\s+([A-Za-z]{2,4}))?)?'  // at 8:51 PM ET
  + '\\s*$',
  'i'
);

function splitAlertDateText(value) {
  if (typeof value !== 'string') return null;
  const match = ALERT_DATE.exec(value);
  if (!match) return null;

  const month = MONTH_ABBREVIATIONS[match[1].slice(0, 3).toLowerCase()];
  if (!month) return null;

  const pad = (n) => String(n).padStart(2, '0');
  const clock = match[4] ? match[4].replace(/\s+/g, ' ').toUpperCase() : '';
  const zone = match[5] ? ` ${match[5].toUpperCase()}` : '';

  return {
    date: `${match[3]}-${pad(month)}-${pad(Number(match[2]))}`,
    time: clock ? `${clock}${zone}` : '',
  };
}

/** Just the date part. Kept as its own export because that is what most callers want. */
function parseAlertDate(value) {
  const parts = splitAlertDateText(value);
  return parts ? parts.date : null;
}

/**
 * Field labels a sender may have captured alongside the value they meant to send.
 *
 * A Shortcut that takes the whole regex match rather than its capture group produces
 * "Merchant\nWWW.SWAN-DIVEPILATES". Requiring a newline or column-width whitespace after the label
 * is what makes stripping it safe: a real merchant called "MERCHANT SERVICES CO" is separated by a
 * single space and is left alone.
 */
const CAPTURED_LABEL = /^\s*(?:Merchant|Description|Amount)(?:\s*\r?\n|[ \t]{2,})\s*/i;

/**
 * The description, with an accidentally-captured label removed.
 *
 * Takes the last non-empty line first, which handles the label-on-its-own-line case with no risk at
 * all — a merchant name never spans lines. Only then is a same-line label considered.
 */
const BARE_LABEL = /^(?:merchant|description|amount|date|account)$/i;

function cleanDescription(value) {
  if (typeof value !== 'string') return '';
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  const cleaned = last.replace(CAPTURED_LABEL, '').trim();

  // Nothing but a label means the sender's pattern matched the row and missed the value. Storing
  // a transaction described as "Merchant" would be a silent lie in the ledger, and with no bank
  // feed to contradict it, one nobody would ever catch. Blank it so the caller rejects it.
  return BARE_LABEL.test(cleaned) ? '' : cleaned;
}

/**
 * The names an iOS Shortcut naturally has for these values, mapped onto the ledger's own.
 *
 * A Shortcut holds its parsed values in variables called `Amount`, `Merchant`, `Last4` and so on,
 * and building the request body is far less fiddly on a phone if those can be sent as-is. Accepting
 * both spellings costs one lookup and means the Shortcut needs no renaming step.
 *
 * `DateText` is absent here on purpose — it needs converting, not renaming, and is handled below.
 */
const INPUT_ALIASES = {
  Amount: 'amount',
  Merchant: 'description',
  // A composed description rather than a raw merchant name — "Mom - JOONG BOO MARKET". Same field,
  // but a sender that has already built the string should not have to call it Merchant.
  Description: 'description',
  Last4: 'cardLast4',
  Time: 'time',
  Notes: 'notes',
  Category: 'category',
  PurchaseCats: 'purchaseCategory',
  PurchaseCategory: 'purchaseCategory',
  PaymentMethod: 'paymentMethod',
  TransactionType: 'transactionType',
};

/**
 * Accept the Shortcut's spelling as well as the ledger's.
 *
 * An explicit lowercase key always wins, so nothing that already posts to this endpoint changes
 * behaviour — the aliases only fill gaps.
 *
 * @throws {Error} if `DateText` was sent but is not a date, rather than letting it fall through as a
 *   missing date and reporting `undefined` back to the sender.
 */
function normalizeIngestInput(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const out = { ...raw };

  for (const [alias, canonical] of Object.entries(INPUT_ALIASES)) {
    if (raw[alias] !== undefined && out[canonical] === undefined) out[canonical] = raw[alias];
  }

  if (raw.DateText !== undefined && raw.date === undefined) {
    const parts = splitAlertDateText(raw.DateText);
    if (parts === null) {
      throw new Error(
        `Invalid DateText: ${JSON.stringify(raw.DateText)} — expected a date like `
        + '"Jul 29, 2026" or "Jul 29, 2026 at 8:51 PM ET"'
      );
    }
    out.date = parts.date;
    // The alert's date row carries the clock time too. Take it when the sender did not supply one
    // separately, so a Shortcut gets `time` populated without any extra actions.
    if (out.time === undefined && parts.time) out.time = parts.time;
  }

  return out;
}

/** Longest time string worth storing — "12:34 PM ET" and friends, with room to spare. */
const MAX_TIME_LENGTH = 20;

/**
 * The clock time the alert printed, kept verbatim.
 *
 * Deliberately not parsed into a Date. The alert states its own zone ("8:51 PM ET"), which is not
 * necessarily the phone's or the server's, and resolving one against the other to store an instant
 * would move a late-evening purchase onto the neighbouring day every time the guess was wrong.
 * `date` already carries the day authoritatively, so the time only has to be readable.
 */
function parseTime(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`Invalid time: ${JSON.stringify(value)} — expected a string`);
  }
  return value.trim().slice(0, MAX_TIME_LENGTH);
}

/**
 * Parse an amount, rejecting anything that is not actually a number.
 *
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so a missing amount would otherwise
 * be stored as a perfectly valid free transaction with no error raised anywhere.
 */
function parseAmount(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value.trim());
  else throw new Error(`Invalid amount: ${JSON.stringify(value)}`);

  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${JSON.stringify(value)}`);
  if (n === 0) throw new Error('Invalid amount: zero is not a transaction');
  return n;
}

/**
 * Apply the account's sign convention.
 *
 * Every one of the existing rows follows one: on the checking account (and cash) money coming
 * in is positive; on a credit card a charge is positive. A manual row that ignores this looks
 * right on its own but reports the wrong way round in any total that sums amounts.
 *
 * The guarantee is that `determineTransactionType(paymentMethod, result) === transactionType`.
 */
function normalizeAmountSign(amount, paymentMethod, transactionType) {
  const magnitude = Math.abs(Number(amount));
  const inflowIsPositive = paymentMethod === 'Chase College' || paymentMethod === 'Cash';
  const positive = inflowIsPositive
    ? transactionType === 'income'
    : transactionType === 'expense';
  return positive ? magnitude : -magnitude;
}

/**
 * A stable id derived from the transaction's own content.
 *
 * Manual rows have no upstream identifier, yet the id is what the whole dedupe, ignore and
 * duplicate-detection machinery keys on. Deriving it from the content means a phone retrying a
 * dropped request produces the same id and upserts, rather than silently doubling an expense.
 *
 * `ordinal` keeps genuinely repeated purchases addressable. The live data contains eleven
 * groups of real transactions sharing card, date, amount and description — collapsing those
 * would delete real spending.
 */
/**
 * A description reduced to what actually distinguishes it.
 *
 * Case and runs of whitespace are noise — "WWW.SWAN-DIVEPILATES" and "www.swan-divepilates" are
 * the same merchant, and a forwarded email may re-wrap the line. Shared by the id derivation and
 * the duplicate check so the two can never disagree about what "the same description" means.
 */
function normalizeDescriptionKey(description) {
  return String(description || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Whether two rows describe the same transaction.
 *
 * Date, amount, description and direction — deliberately NOT the payment method, which the id
 * derivation does include. An alert re-sent after the card map changed, or one sent once with an
 * explicit account and once without, is still the same purchase and must not be logged twice.
 */
function isSameTransaction(a, b) {
  if (!a || !b) return false;
  return String(a.date) === String(b.date)
    && Number(a.amount) === Number(b.amount)
    && String(a.transactionType) === String(b.transactionType)
    && normalizeDescriptionKey(a.description) === normalizeDescriptionKey(b.description);
}

function deriveTransactionId({ date, amount, description, paymentMethod }, ordinal = 0) {
  const canonical = [
    String(date || ''),
    Math.abs(Number(amount) || 0).toFixed(2),
    normalizeDescriptionKey(description),
    String(paymentMethod || ''),
  ].join('|');
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  return ordinal > 0 ? `manual_${hash}_${ordinal}` : `manual_${hash}`;
}

/**
 * Build the full ledger row.
 *
 * @param {object} input      the submitted payload
 * @param {object} options
 * @param {string} options.userId
 * @param {function} options.returnIdForMonth  (year, month) => returnId | null
 * @param {number} [options.ordinal]           distinguishes a genuine repeat
 * @param {string} [options.source]            provenance, default 'phone'
 * @param {object} [options.cardLast4Map]      last-four → card name; injected by tests, otherwise
 *                                             read once from CARD_LAST4_MAP
 * @returns {object} ready to persist
 * @throws {Error} on any invalid input — never silently coerces
 */
function buildManualTransaction(input, options = {}) {
  const {
    userId, returnIdForMonth = () => null, ordinal = 0, source = 'phone',
    cardLast4Map = parseCardLast4Map(process.env.CARD_LAST4_MAP),
    cardCategoryMap = parseCardLast4Map(process.env.CARD_CATEGORY_MAP),
  } = options;
  // Resolves the Shortcut's field names onto the ledger's, and turns "Jul 29, 2026" into an ISO
  // date, so everything below sees exactly one shape regardless of which spelling arrived.
  const raw = normalizeIngestInput(input);

  const description = cleanDescription(raw.description);
  if (!description) {
    // Say which of the two it was. "A description is required" is baffling when you can see one in
    // the payload you just sent.
    const sent = typeof raw.description === 'string' ? raw.description.trim() : '';
    throw new Error(sent
      ? `A description is required — ${JSON.stringify(sent)} is only a field label, not a merchant`
      : 'A description is required');
  }

  const dateMs = parseIsoDate(raw.date);
  if (dateMs === null) {
    throw new Error(`Invalid date: ${JSON.stringify(raw.date)} — expected YYYY-MM-DD`);
  }
  const [year, month, day] = raw.date.split('-').map(Number);

  const submitted = parseAmount(raw.amount);

  if (raw.transactionType !== undefined && !VALID_TYPES.includes(raw.transactionType)) {
    throw new Error(
      `Invalid transactionType: ${JSON.stringify(raw.transactionType)} — expected income or expense`
    );
  }

  // Precedence: explicit > description rule > card last-four > fallback.
  //
  // The rule beats the card, which is the reverse of what it was, because a rule is a deliberate
  // statement about one known description while a last-four map is a blanket mapping — the more
  // specific fact should win. Payroll is the case that forced it: the money lands in the checking
  // account, so the alert names that card, but the ledger files payroll against Cash.
  //
  // Nothing that worked before changes. Card purchases match no rule, so the last-four still
  // decides; both Zelle rules already resolved to the same account the last-four would have.
  const rule = resolveDescriptionRule(description);
  const sentLast4 = raw.cardLast4 !== undefined && raw.cardLast4 !== null && raw.cardLast4 !== '';
  const fromLast4 = sentLast4 ? resolveCardFromLast4(raw.cardLast4, cardLast4Map) : null;

  // What the card implies beyond which account it is.
  //
  // A card belonging to someone else means every purchase on it is theirs, whatever was bought.
  // The description classifier gets that right by accident for the shops they use often — a grocery
  // run reads as parents-monthly wherever it came from — and wrong for everything else. Whose card
  // it was is the fact that actually determines it, and the last four are what carry that fact.
  const categoryFromCard = sentLast4
    ? resolveCardFromLast4(raw.cardLast4, cardCategoryMap)
    : null;

  // Reject an unrecognised card rather than quietly falling through to Cash. Falling through would
  // store the amount with the wrong sign — Cash treats a positive figure as money arriving, a credit
  // card as a charge — and compute points against the wrong card. Neither is visible in the row
  // itself; both corrupt every total that includes it.
  //
  // Failing is the recoverable option: the alert email is still in the inbox and can be resent once
  // the map is updated. But the sender MUST surface this error, because with the bank feed retired
  // there is no second source that would reveal the missing row later.
  // A rule that names the account answers the question the card would have, so an unmapped card is
  // only a problem when nothing else can supply one.
  if (sentLast4 && !fromLast4 && !raw.paymentMethod && !(rule && rule.paymentMethod)) {
    throw new Error(`Unknown card ...${raw.cardLast4} — add it to CARD_LAST4_MAP`);
  }

  const paymentMethod = raw.paymentMethod
    || (rule && rule.paymentMethod)
    || fromLast4
    || DEFAULT_PAYMENT_METHOD;
  // Last-resort fallback, and it deliberately does NOT reuse determineTransactionType().
  //
  // That function encodes how the BANK reports: on a checking account a positive figure is
  // money arriving, because that is how a deposit appears in the feed. A person typing
  // "12.50, ARMO GRILL" into their phone means they SPENT 12.50. Applying the bank's
  // convention to hand-entered data files ordinary purchases as income.
  //
  // So: a bare positive amount is an expense, a negative one is a refund or income. The sign
  // convention for STORAGE is still the account's — normalizeAmountSign() applies it below —
  // so the stored row remains indistinguishable from a bank-sourced one.
  // Refuse to guess the direction of a transfer. Everywhere else the fallback below is a fair
  // reading — someone typing "12.50, ARMO GRILL" into their phone means they spent it. A Zelle
  // transfer is the one case where the same positive number means the opposite thing half the time,
  // and the description is the only place that distinction can live.
  if (!raw.transactionType && !rule && ZELLE.test(description)) {
    throw new Error(
      `Ambiguous Zelle description: ${JSON.stringify(description)} — write it as `
      + '"Zelle from <name>" or "Zelle to <name>", or send transactionType'
    );
  }

  const transactionType = raw.transactionType
    || (rule && rule.transactionType)
    || (submitted > 0 ? 'expense' : 'income');

  const amount = normalizeAmountSign(submitted, paymentMethod, transactionType);

  // Same classifiers the Teller sync used, so manual rows categorise identically.
  const forClassifier = { description };
  const purchaseCategory = raw.purchaseCategory !== undefined
    ? raw.purchaseCategory
    : determinePurchaseCategory(forClassifier);
  // An empty string counts as "not supplied", not as a deliberate blank: a Shortcut whose category
  // picker was dismissed sends "" rather than omitting the field, and both mean the same thing.
  const supplied = typeof raw.category === 'string' ? raw.category.trim() : raw.category;
  const category = (supplied === undefined || supplied === null || supplied === '')
    ? ((rule && rule.category) || categoryFromCard || determineCategory(forClassifier) || DEFAULT_CATEGORY)
    : supplied;

  // A rule may pin points to zero, which the fallback below cannot express — `|| calculatePoints()`
  // would read 0 as "unset" and recompute it.
  const points = raw.points !== undefined
    ? Number(raw.points)
    : (rule && rule.points !== undefined
      ? rule.points
      : calculatePoints(paymentMethod, purchaseCategory, month));

  const isParentsMonthly = category === 'parents-monthly';

  // An explicit flag wins, so a sender that knows better can say so. `returnId` below stays tied to
  // the category regardless: a 'parents-monthly' row belongs to that month's return whether or not
  // this particular one is being claimed back, and severing the link would orphan it in the UI.
  const needToBePaidback = typeof raw.needToBePaidback === 'boolean'
    ? raw.needToBePaidback
    : isParentsMonthly;

  return {
    userId,
    tellerTransactionId: deriveTransactionId({ date: raw.date, amount, description, paymentMethod }, ordinal),
    source,
    date: raw.date,
    time: parseTime(raw.time),
    year,
    month,
    day,
    amount,
    transactionType,
    description,
    category,
    purchaseCategory,
    paymentMethod,
    // What the alert actually said, kept beside the resolved name so a mis-mapped card is
    // diagnosable after the fact rather than only visible as a wrong total. Four digits or nothing.
    cardLast4: /^\d{4}$/.test(String(raw.cardLast4 || '').trim())
      ? String(raw.cardLast4).trim()
      : '',
    points,
    returnId: isParentsMonthly ? returnIdForMonth(year, month) : null,
    returned: false,
    // Nobody has looked at this yet by definition — it was built from an email, not typed by a
    // person. The caller decides how to persist it; ingestController writes it on insert only.
    reviewed: false,
    needToBePaidback,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

module.exports = {
  DESCRIPTION_RULES,
  DEFAULT_PAYMENT_METHOD,
  DEFAULT_CATEGORY,
  MAX_TIME_LENGTH,
  INPUT_ALIASES,
  parseAlertDate,
  splitAlertDateText,
  cleanDescription,
  normalizeIngestInput,
  resolveDescriptionRule,
  parseCardLast4Map,
  resolveCardFromLast4,
  parseTime,
  parseAmount,
  normalizeAmountSign,
  normalizeDescriptionKey,
  isSameTransaction,
  deriveTransactionId,
  buildManualTransaction,
};
