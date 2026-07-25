const mongoose = require('mongoose');

/**
 * Rate limiting for the Teller route.
 *
 * Why MongoDB rather than an in-memory counter: this deploys to Vercel, where each request may
 * be served by a fresh, short-lived instance. An in-memory limiter there is close to no
 * limiter at all — process memory is not shared between invocations and does not survive them.
 * A tiny shared collection with a TTL index does survive, and the cost is one indexed upsert.
 *
 * What it is for. Authentication is the primary control; this is the backstop. A single Teller
 * fetch fans out to six-plus upstream API calls, so an authorised-but-runaway caller (a retry
 * loop, a stuck browser tab, a leaked session) can burn through Teller's own rate limit and
 * take the feature down. This bounds that.
 *
 * It fails OPEN: if the limiter's own storage is unavailable, requests are allowed and the
 * failure is logged loudly. A limiter outage should not lock the owner out of their own data,
 * and the real access controls (internal secret + session token) are still in force.
 */

const rateLimitSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  // MongoDB's TTL monitor removes these; no cleanup job needed.
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

const RateLimitBucket = mongoose.models.RateLimitBucket
  || mongoose.model('RateLimitBucket', rateLimitSchema);

/**
 * Fixed-window limiter.
 *
 * @param {object} opts
 * @param {string} opts.name       bucket namespace
 * @param {number} opts.windowMs   window length
 * @param {number} opts.max        requests permitted per window
 */
function createRateLimit({ name, windowMs, max }) {
  return async function rateLimit(req, res, next) {
    try {
      // Prefer the authenticated user; fall back to IP so an unauthenticated path is still
      // bounded. `validateToken` runs before this on the Teller route, so req.user is set.
      const who = (req.user && req.user.userId) || req.ip || 'anonymous';
      const bucket = Math.floor(Date.now() / windowMs);
      const key = `${name}:${who}:${bucket}`;

      const doc = await RateLimitBucket.findOneAndUpdate(
        { key },
        {
          $inc: { count: 1 },
          // Keep the row a little past the window so a late request in the same bucket still
          // counts rather than silently resetting.
          $setOnInsert: { expiresAt: new Date((bucket + 1) * windowMs + 60_000) },
        },
        { upsert: true, new: true }
      );

      if (doc.count > max) {
        const retryAfter = Math.ceil(((bucket + 1) * windowMs - Date.now()) / 1000);
        res.set('Retry-After', String(Math.max(retryAfter, 1)));
        console.warn(`[rateLimit] ${name} blocked ${who} — ${doc.count} requests this window`);
        return res.status(429).json({
          error: 'Too many requests. Please wait a moment and try again.',
          retryAfterSeconds: Math.max(retryAfter, 1),
        });
      }

      return next();
    } catch (err) {
      // Concurrent upserts can collide on the unique index; that is not a reason to reject a
      // legitimate request, and neither is the limiter's storage being briefly unavailable.
      console.error(`[rateLimit] ${name} failed open:`, err.message);
      return next();
    }
  };
}

/**
 * Teller: 10 fetches per 5 minutes per user.
 *
 * Generous for a human clicking "Fetch" — the review flow is one fetch, review, save — and far
 * below the level at which Teller's own limiter starts returning 429s.
 */
const tellerRateLimit = createRateLimit({
  name: 'teller',
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.TELLER_RATE_LIMIT_MAX) || 10,
});

module.exports = { createRateLimit, tellerRateLimit, RateLimitBucket };
