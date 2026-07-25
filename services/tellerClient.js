const https = require('https');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

/**
 * Read-only Teller API client.
 *
 * This module is the ONLY way the backend should talk to Teller. It deliberately
 * exposes a single `tellerGet()` helper:
 *   - the HTTP method is hard-coded to GET (no caller can issue a write),
 *   - the path is checked against a read-only allowlist (no /payments, no DELETE),
 *   - mTLS is enforced with rejectUnauthorized: true (defeats man-in-the-middle).
 *
 * mTLS material is loaded from base64 env vars first (so it works on serverless /
 * public deployments like Vercel, where the gitignored certs/ folder is absent),
 * and falls back to local PEM files for development.
 */

const TELLER_BASE = 'https://api.teller.io';

// Allowed read-only paths:
//   /accounts
//   /accounts/:id
//   /accounts/:id/details
//   /accounts/:id/balances
//   /accounts/:id/transactions
//   /accounts/:id/transactions/:txnId
const READ_ONLY_PATH =
  /^\/accounts(\/[A-Za-z0-9_]+(\/(details|balances|transactions)(\/[A-Za-z0-9_]+)?)?)?$/;

function loadCertMaterial() {
  const certB64 = process.env.TELLER_CERT_B64;
  const keyB64 = process.env.TELLER_KEY_B64;

  if (certB64 && keyB64) {
    return {
      cert: Buffer.from(certB64, 'base64').toString('utf8'),
      key: Buffer.from(keyB64, 'base64').toString('utf8'),
    };
  }

  const certPath = path.join(__dirname, '../certs/certificate.pem');
  const keyPath = path.join(__dirname, '../certs/private_key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
  }

  throw new Error(
    'Teller mTLS material missing. Set TELLER_CERT_B64 and TELLER_KEY_B64 ' +
      '(base64-encoded PEM) in the environment, or provide ' +
      'certs/certificate.pem and certs/private_key.pem for local development.'
  );
}

let agent;
function getAgent() {
  if (!agent) {
    const { cert, key } = loadCertMaterial();
    agent = new https.Agent({
      cert,
      key,
      rejectUnauthorized: true, // verify Teller's server certificate — NEVER set to false
      minVersion: 'TLSv1.2',
      keepAlive: true,
    });
  }
  return agent;
}

function assertReadOnlyPath(pathname) {
  if (!READ_ONLY_PATH.test(pathname)) {
    throw new Error(`Blocked non-read-only Teller path: "${pathname}"`);
  }
}

/**
 * Issue a read-only GET against the Teller API.
 * @param {string} reqPath e.g. "/accounts/acc_123/transactions?count=500"
 * @param {string} accessToken Teller access token (used as HTTP Basic username)
 * @returns {Promise<import('node-fetch').Response>}
 */
async function tellerGet(reqPath, accessToken) {
  if (!accessToken) throw new Error('Missing Teller access token');

  const [pathname, query] = String(reqPath).split('?');
  assertReadOnlyPath(pathname);

  const url = `${TELLER_BASE}${pathname}${query ? `?${query}` : ''}`;

  return fetch(url, {
    method: 'GET', // hard-coded; this module exposes no other verb
    agent: getAgent(),
    headers: {
      Authorization: `Basic ${Buffer.from(`${accessToken}:`).toString('base64')}`,
      Accept: 'application/json',
    },
  });
}

/**
 * Fetch an account's transactions, walking backward through pages until the requested window
 * is covered.
 *
 * Teller returns transactions newest-first and caps a single response at `count`. Two of the
 * six enrolled accounts (Chase College, Freedom Unlimited) were hitting the 500 cap, so
 * history older than the oldest returned row was invisible to the app no matter what the
 * caller asked for. `from_id` returns transactions strictly older than the given id, which is
 * how we page past the cap.
 *
 * Pagination stops when: the window is covered, Teller returns a short/empty page, `maxPages`
 * is reached, or a page repeats ids we have already seen (defensive — a malformed cursor must
 * not spin forever). `truncated` reports honestly whether coverage is incomplete; callers must
 * surface it rather than presenting a partial result as complete.
 *
 * @param {string} accountId
 * @param {string} accessToken
 * @param {object} [opts]
 * @param {string|null} [opts.startDate] 'YYYY-MM-DD' — stop once a page reaches older than this
 * @param {number} [opts.count] page size
 * @param {number} [opts.maxPages] hard bound on requests per account
 * @returns {Promise<{transactions: Array, pages: number, truncated: boolean, error: string|null}>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a page, retrying on Teller's 429 with linear backoff.
 *
 * Teller rate-limits bursts: fetching six accounts concurrently while each paginates reliably
 * produced `429 too_many_requests` in testing. Retries are deliberately few and short — this
 * runs inside a serverless function with a request timeout, so it is better to return an
 * honest partial result than to sit in backoff until the platform kills the request.
 */
async function getPageWithRetry(reqPath, accessToken, { get, sleepFn, maxRetries, baseDelayMs }) {
  let res = await get(reqPath, accessToken);
  for (let attempt = 0; attempt < maxRetries && res.status === 429; attempt++) {
    await sleepFn(baseDelayMs * (attempt + 1));
    res = await get(reqPath, accessToken);
  }
  return res;
}

async function fetchAccountTransactions(accountId, accessToken, opts = {}) {
  const {
    startDate = null,
    count = 500,
    maxPages = 10,
    pageDelayMs = 250,
    maxRetries = 2,
    baseDelayMs = 700,
    // injectable purely so the pagination/backoff logic is unit-testable without a live
    // mTLS connection to Teller; production always uses the real read-only tellerGet.
    get = tellerGet,
    sleepFn = sleep,
  } = opts;

  const transactions = [];
  const seenIds = new Set();
  let fromId = null;
  let pages = 0;
  let truncated = false;

  while (pages < maxPages) {
    const params = new URLSearchParams({ count: String(count) });
    if (fromId) params.set('from_id', fromId);

    // Space out follow-up pages; the first page of each account goes out immediately so the
    // common single-page case costs exactly what it did before.
    if (pages > 0 && pageDelayMs > 0) await sleepFn(pageDelayMs);

    const res = await getPageWithRetry(
      `/accounts/${accountId}/transactions?${params}`,
      accessToken,
      { get, sleepFn, maxRetries, baseDelayMs }
    );
    pages++;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        transactions,
        pages,
        truncated: true,
        rateLimited: res.status === 429,
        error: `status=${res.status} body=${String(body).slice(0, 300)}`,
      };
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    // Mark ids as seen while filtering, not afterwards — otherwise a page containing the same
    // id twice would pass both copies through (the filter would still be reading an unchanged
    // seenIds), putting duplicate rows in the review list and colliding React keys.
    const fresh = [];
    for (const t of batch) {
      if (!t || !t.id || seenIds.has(t.id)) continue;
      seenIds.add(t.id);
      fresh.push(t);
    }
    transactions.push(...fresh);

    // a page that adds nothing new means the cursor is not advancing — stop
    if (fresh.length === 0) break;
    // a short page means Teller has no more history
    if (batch.length < count) break;

    const oldest = batch[batch.length - 1];
    // once the oldest row on this page predates the window, everything further back does too
    if (startDate && typeof oldest.date === 'string' && oldest.date < startDate) break;

    if (!oldest || !oldest.id) break;
    fromId = oldest.id;

    if (pages >= maxPages) truncated = true;
  }

  return { transactions, pages, truncated, rateLimited: false, error: null };
}

module.exports = { tellerGet, fetchAccountTransactions };
