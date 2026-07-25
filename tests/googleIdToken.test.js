/**
 * Tests for Google ID token verification.
 *
 * This is the control that replaces "the backend believes whatever email it is handed" with
 * "the backend requires a token Google actually signed". Every test below signs real RS256
 * tokens with a locally generated key pair and serves a real JWKS document, so signature
 * verification is genuinely exercised — nothing is stubbed at the crypto layer and no network
 * call is made.
 *
 * The bar: a token this module accepts must be one that only Google could have produced for
 * THIS application. Everything else must be rejected, loudly.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const { verifyGoogleIdToken, GOOGLE_ISSUERS } = require('../services/googleIdToken');

// --- a local stand-in for Google's signing keys -------------------------------------------

const CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';

function makeKeyPair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

const GOOGLE_KEY = makeKeyPair('google-key-1');
const ROGUE_KEY = makeKeyPair('google-key-1'); // same kid, different key — a forgery attempt

/** A JWKS fetcher that serves our fake Google keys. Counts calls so caching can be asserted. */
function makeJwks(keys = [GOOGLE_KEY]) {
  const fetcher = async () => {
    fetcher.calls++;
    return { keys: keys.map((k) => k.jwk) };
  };
  fetcher.calls = 0;
  return fetcher;
}

const sign = (claims, key = GOOGLE_KEY, header = {}) =>
  jwt.sign(claims, key.privateKey, {
    algorithm: 'RS256',
    keyid: key.kid,
    ...header,
  });

const validClaims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '1029384756',
  email: 'owner@example.com',
  email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  ...over,
});

const opts = (over = {}) => ({ clientId: CLIENT_ID, fetchJwks: makeJwks(), ...over });

// --- the happy path -----------------------------------------------------------------------

test('a genuine Google-signed token is accepted and its claims returned', async () => {
  const claims = await verifyGoogleIdToken(sign(validClaims()), opts());
  assert.strictEqual(claims.email, 'owner@example.com');
  assert.strictEqual(claims.sub, '1029384756');
  assert.strictEqual(claims.email_verified, true);
});

test('both Google issuer spellings are accepted', async () => {
  for (const iss of GOOGLE_ISSUERS) {
    const claims = await verifyGoogleIdToken(sign(validClaims({ iss })), opts());
    assert.strictEqual(claims.iss, iss);
  }
});

test('the email is returned lowercased and trimmed', async () => {
  const claims = await verifyGoogleIdToken(sign(validClaims({ email: '  Owner@Example.COM ' })), opts());
  assert.strictEqual(claims.email, 'owner@example.com');
});

// --- forgery and tampering ------------------------------------------------------------------

test('THE ATTACK: a token signed by anyone other than Google is rejected', async () => {
  // Same kid, same claims, attacker's key. This is the whole point of the control.
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims(), ROGUE_KEY), opts()),
    /signature|invalid/i,
    'a self-signed token must never be accepted'
  );
});

test('a token whose payload was edited after signing is rejected', async () => {
  const token = sign(validClaims());
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  payload.email = 'attacker@example.com';
  const tampered = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');

  await assert.rejects(() => verifyGoogleIdToken(tampered, opts()), /signature|invalid/i);
});

test('alg=none is rejected', async () => {
  // The classic JWT downgrade: strip the signature and claim no algorithm was used.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(validClaims())).toString('base64url');
  await assert.rejects(() => verifyGoogleIdToken(`${header}.${payload}.`, opts()), /alg|invalid|signature/i);
});

test('an HMAC-signed token using the public key as the secret is rejected', async () => {
  // The RS256->HS256 confusion attack: if the verifier is careless it will treat the RSA
  // public key as an HMAC secret, and the public key is not secret.
  const pubPem = crypto.createPublicKey({ key: GOOGLE_KEY.jwk, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' });
  const forged = jwt.sign(validClaims(), pubPem, { algorithm: 'HS256', keyid: GOOGLE_KEY.kid });
  await assert.rejects(() => verifyGoogleIdToken(forged, opts()), /alg|invalid|signature/i);
});

test('a token whose kid matches no published Google key is rejected', async () => {
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims(), { ...GOOGLE_KEY, kid: 'unknown-kid' }), opts()),
    /key/i
  );
});

// --- audience and issuer --------------------------------------------------------------------

test("THE ATTACK: a valid Google token minted for a DIFFERENT app is rejected", async () => {
  // Anyone can get a real, correctly-signed Google token from their own OAuth client. Without
  // an audience check, that token would authenticate them here.
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims({ aud: 'someone-elses-app.apps.googleusercontent.com' })), opts()),
    /audience/i
  );
});

test('a non-Google issuer is rejected', async () => {
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims({ iss: 'https://evil.example.com' })), opts()),
    /issuer/i
  );
});

// --- expiry ---------------------------------------------------------------------------------

test('an expired token is rejected', async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims({ exp: past, iat: past - 3600 })), opts()),
    /expired/i
  );
});

test('a token issued in the future is rejected', async () => {
  const future = Math.floor(Date.now() / 1000) + 7200;
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims({ iat: future, exp: future + 3600 })), opts()),
    /jwt not active|iat|future|invalid/i
  );
});

// --- email trust ------------------------------------------------------------------------------

test('an unverified Google email is rejected', async () => {
  // Google will happily sign a token for an address the user has not proven they own.
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims({ email_verified: false })), opts()),
    /verified/i
  );
});

test('a token with no email claim is rejected', async () => {
  const claims = validClaims();
  delete claims.email;
  await assert.rejects(() => verifyGoogleIdToken(sign(claims), opts()), /email/i);
});

// --- misuse of the API itself -------------------------------------------------------------------

test('a missing or malformed token is rejected without throwing something unhelpful', async () => {
  for (const bad of [undefined, null, '', 'not-a-jwt', 'a.b', {}, 123]) {
    await assert.rejects(() => verifyGoogleIdToken(bad, opts()),
      (e) => e instanceof Error, `input ${JSON.stringify(bad)} must reject cleanly`);
  }
});

test('refusing to run without a configured clientId', async () => {
  // Misconfiguration must fail closed. An empty audience check is the same as no check.
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims()), { clientId: '', fetchJwks: makeJwks() }),
    /client id|clientId|configur/i
  );
});

// --- key caching -----------------------------------------------------------------------------

test('JWKS is cached across calls rather than fetched per verification', async () => {
  const fetchJwks = makeJwks();
  const o = { clientId: CLIENT_ID, fetchJwks, cacheKey: 'cache-test-1' };
  await verifyGoogleIdToken(sign(validClaims()), o);
  await verifyGoogleIdToken(sign(validClaims()), o);
  await verifyGoogleIdToken(sign(validClaims()), o);
  assert.strictEqual(fetchJwks.calls, 1, 'Google publishes these keys; refetching each time is waste');
});

test('an unknown kid forces exactly one refetch, then gives up', async () => {
  // Google rotates keys. A kid we have not seen should trigger a refresh, but a bogus kid must
  // not let a caller hammer Google's endpoint.
  const fetchJwks = makeJwks();
  const o = { clientId: CLIENT_ID, fetchJwks, cacheKey: 'cache-test-2' };
  await verifyGoogleIdToken(sign(validClaims()), o);
  assert.strictEqual(fetchJwks.calls, 1);

  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims(), { ...GOOGLE_KEY, kid: 'rotated-in-key' }), o),
    /key/i
  );
  assert.strictEqual(fetchJwks.calls, 2, 'exactly one refresh attempt');
});

test('a rotated-in key is picked up after the refetch', async () => {
  const NEW_KEY = makeKeyPair('google-key-2');
  let served = [GOOGLE_KEY];
  const fetchJwks = async () => ({ keys: served.map((k) => k.jwk) });
  const o = { clientId: CLIENT_ID, fetchJwks, cacheKey: 'cache-test-3' };

  await verifyGoogleIdToken(sign(validClaims()), o);   // primes the cache with key 1
  served = [GOOGLE_KEY, NEW_KEY];                       // Google rotates
  const claims = await verifyGoogleIdToken(sign(validClaims(), NEW_KEY), o);
  assert.strictEqual(claims.email, 'owner@example.com');
});

test('a JWKS fetch failure fails closed', async () => {
  await assert.rejects(
    () => verifyGoogleIdToken(sign(validClaims()), {
      clientId: CLIENT_ID,
      cacheKey: 'cache-test-4',
      fetchJwks: async () => { throw new Error('network down'); },
    }),
    (e) => e instanceof Error,
    'if we cannot reach Google we must refuse, never accept'
  );
});
