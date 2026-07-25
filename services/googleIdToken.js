const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Google ID token verification.
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /api/users/fetch-by-email` used to accept a bare email address and return a JWT valid
 * for 180 days. It was mounted with no auth middleware, so anyone on the internet who knew an
 * approved email — and email addresses are not secrets — could obtain full access to the bank
 * transaction API without ever signing in to Google. The Google OAuth flow ran entirely in the
 * frontend and the backend simply believed whatever email it was handed.
 *
 * This module replaces "believe the email" with "require a token Google actually signed".
 * The email is read out of the *verified* claims, never out of the request body.
 *
 * Four things are checked, and all four matter:
 *   - **Signature**, against Google's published keys. Stops forged tokens.
 *   - **Audience**, against our own client id. Anyone can obtain a genuine, correctly-signed
 *     Google token from their own OAuth client; without this check that token would
 *     authenticate them here.
 *   - **Issuer**, so a token from some other identity provider cannot be substituted.
 *   - **Expiry and `email_verified`**, so stale tokens and unproven addresses are refused.
 *
 * No new dependency: Node's crypto can import a JWK directly, and `jsonwebtoken` is already
 * used for our own session tokens.
 */

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Google's signing keys rotate slowly (order of days). Refetching per login is pure waste, but
// the TTL is kept short enough that a rotation is picked up without a redeploy.
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLOCK_TOLERANCE_S = 30;      // ordinary skew between our clock and Google's
const jwksCache = new Map(); // cacheKey -> { keys: Map<kid, KeyObject>, fetchedAt: number }

async function defaultFetchJwks() {
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`Could not fetch Google signing keys (HTTP ${res.status})`);
  return res.json();
}

/** Convert a JWKS document into kid -> KeyObject, skipping anything unusable. */
function toKeyMap(jwks) {
  const keys = new Map();
  for (const jwk of (jwks && jwks.keys) || []) {
    if (!jwk || !jwk.kid) continue;
    // Only RSA signing keys are expected here. Refusing anything else keeps the algorithm
    // surface as narrow as the `algorithms: ['RS256']` pin below.
    if (jwk.kty !== 'RSA') continue;
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // A malformed key entry must not take down verification for the others.
    }
  }
  return keys;
}

async function loadKeys(cacheKey, fetchJwks, { force = false } = {}) {
  const cached = jwksCache.get(cacheKey);
  const fresh = cached && (Date.now() - cached.fetchedAt) < JWKS_TTL_MS;
  if (!force && fresh && cached.keys.size > 0) return cached.keys;

  // A fetch failure must fail closed. Falling back to a stale cache would be defensible, but
  // refusing is the safer default for an auth path — better to block a login than to widen the
  // window in which a revoked key still verifies.
  const keys = toKeyMap(await fetchJwks());
  if (keys.size === 0) throw new Error('Google published no usable signing keys');
  jwksCache.set(cacheKey, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * Verify a Google-issued ID token.
 *
 * @param {string} idToken the raw JWT from Google (NextAuth's `account.id_token`)
 * @param {object} options
 * @param {string} options.clientId  our GOOGLE_CLIENT_ID — the expected audience
 * @param {function} [options.fetchJwks]  injectable for tests
 * @param {string} [options.cacheKey]  key-cache partition, mainly for test isolation
 * @returns {Promise<object>} the verified claims, with `email` normalised
 * @throws {Error} on any failure — this function never returns a falsy "not ok" value
 */
async function verifyGoogleIdToken(idToken, options = {}) {
  const { clientId, fetchJwks = defaultFetchJwks, cacheKey = 'google' } = options;

  // Fail closed on misconfiguration. An unset client id would make the audience check vacuous,
  // which silently reduces this to "any valid Google token from any app is accepted".
  if (!clientId || typeof clientId !== 'string') {
    throw new Error('Google client ID is not configured — refusing to verify');
  }
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Invalid Google ID token: missing or not a string');
  }

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header) {
    throw new Error('Invalid Google ID token: not a well-formed JWT');
  }
  // Pinned before key lookup so `alg: none` and RS256->HS256 confusion are refused outright
  // rather than being handed to the verifier with an RSA public key as the "secret".
  if (decoded.header.alg !== 'RS256') {
    throw new Error(`Invalid Google ID token: unexpected alg "${decoded.header.alg}"`);
  }
  const kid = decoded.header.kid;
  if (!kid) throw new Error('Invalid Google ID token: no key id in header');

  let keys = await loadKeys(cacheKey, fetchJwks);
  let key = keys.get(kid);
  if (!key) {
    // Unknown kid: Google may have rotated. Refresh exactly once — enough to pick up a
    // rotation, not enough for a bogus kid to be used to hammer Google's endpoint.
    keys = await loadKeys(cacheKey, fetchJwks, { force: true });
    key = keys.get(kid);
  }
  if (!key) throw new Error(`Invalid Google ID token: no matching signing key for kid "${kid}"`);

  let claims;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ['RS256'],
      audience: clientId,
      issuer: GOOGLE_ISSUERS,
      clockTolerance: CLOCK_TOLERANCE_S,
    });
  } catch (err) {
    // jsonwebtoken's messages are already specific ("jwt expired", "jwt audience invalid",
    // "invalid signature"); keep them, they are what makes a failure diagnosable.
    throw new Error(`Invalid Google ID token: ${err.message}`);
  }

  // `jsonwebtoken` enforces `exp` and `nbf` but not a future `iat`. Google will not issue one,
  // so this is belt-and-braces against a mis-set or misbehaving issuer clock producing a token
  // that stays valid far longer than the ~1 hour these are meant to live. Uses the same
  // tolerance as above so ordinary skew on our side cannot reject a legitimate login.
  if (typeof claims.iat === 'number' && claims.iat > (Date.now() / 1000) + CLOCK_TOLERANCE_S) {
    throw new Error('Invalid Google ID token: iat is in the future');
  }

  if (!claims.email || typeof claims.email !== 'string') {
    throw new Error('Invalid Google ID token: no email claim');
  }
  // Google signs tokens for addresses the user has not proven they control. Treating those as
  // an identity would let someone claim an address they merely typed in.
  if (claims.email_verified !== true) {
    throw new Error('Invalid Google ID token: email is not verified by Google');
  }

  return { ...claims, email: claims.email.trim().toLowerCase() };
}

module.exports = {
  verifyGoogleIdToken,
  GOOGLE_ISSUERS,
  GOOGLE_JWKS_URL,
  // exported for tests / operational reset only
  _clearJwksCache: () => jwksCache.clear(),
};
