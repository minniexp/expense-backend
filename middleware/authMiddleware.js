const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');

// Middleware to validate JWT token
const validateToken = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Add timestamp check
    if (decoded.exp && Date.now() >= decoded.exp * 1000) {
      return res.status(401).json({ error: 'Token has expired' });
    }

    // Check if user exists and is approved
    const user = await User.findOne({ 
      _id: decoded.userId,
      isApproved: true // Only find approved users
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found or not approved' });
    }

    // Attach user to request object
    req.user = {
      userId: user._id,
      email: user.email,
      accessLevel: user.accessLevel,
      isApproved: user.isApproved
    };
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token has expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    console.error('Error validating token:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Middleware to check if user has advanced access
const requireAdvancedAccess = (req, res, next) => {
  if (!req.user || req.user.accessLevel !== 'advanced') {
    return res.status(403).json({ error: 'Access denied. Advanced permissions required.' });
  }
  next();
};

/**
 * Require a secret that only our own Next.js server knows.
 *
 * This is the control that keeps the browser off the sensitive routes entirely. The value is a
 * server-only environment variable on the Next.js side — it is never sent to the browser, never
 * prefixed `NEXT_PUBLIC_`, and never appears in a client bundle. So even a session token stolen
 * out of a user's browser cannot, on its own, reach Teller or mint a new session: an attacker
 * would need to compromise the server too.
 *
 * Compared with the `validateSecretKey` this replaces — which compared `SECRET_KEY` against
 * `CHECK_KEY`, i.e. two environment variables against each other, ignoring the request
 * entirely and therefore capable of rejecting nothing — this actually inspects the caller.
 */
const requireInternalSecret = (req, res, next) => {
  const expected = process.env.INTERNAL_API_SECRET;

  // Fail closed. An unset secret must never mean "let everyone through", which is precisely
  // how the endpoint this protects came to be open in the first place.
  if (!expected || expected.length < 32) {
    console.error(
      'INTERNAL_API_SECRET is missing or too short (need >= 32 chars) — refusing the request'
    );
    return res.status(503).json({ error: 'Server is not configured for this request' });
  }

  const provided = req.headers['x-internal-secret'];
  if (typeof provided !== 'string' || provided.length !== expected.length) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Constant-time compare so response timing cannot be used to recover the secret byte by byte.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

module.exports = {
  validateToken,
  requireAdvancedAccess,
  requireInternalSecret
};