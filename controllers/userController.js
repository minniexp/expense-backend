const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { verifyGoogleIdToken } = require('../services/googleIdToken');

exports.createUser = async (req, res) => {
  try {
    const { email, name } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ 
        message: 'User with this email already exists' 
      });
    }

    // Create new user
    const user = new User({
      email: email.toLowerCase(),
      name
    });

    const savedUser = await user.save();
    res.status(201).json(savedUser);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

/**
 * Session lifetime.
 *
 * Was 180 days. There is no revocation list and no `jti`, so a stolen token could not be
 * invalidated short of rotating JWT_SECRET and signing everyone out. Seven days keeps the
 * blast radius of a leak small while still being long enough not to be a nuisance — the Google
 * session silently re-mints this on the next visit.
 */
const SESSION_TTL = process.env.SESSION_TTL || '7d';

/**
 * Exchange a Google-signed ID token for one of our session tokens.
 *
 * SECURITY — read before changing.
 * This endpoint used to accept `{ email }` from the request body and return a 180-day
 * full-access JWT, and it was mounted with no auth middleware. Anyone on the internet who knew
 * an approved email address — and email addresses are not secrets — could obtain complete
 * access to the bank transaction API without ever signing in to Google.
 *
 * Two independent controls now stand in front of it:
 *   1. `requireInternalSecret` — only our own Next.js server can reach this route at all.
 *   2. Google ID token verification — the identity comes from claims Google cryptographically
 *      signed, so even a caller that has the internal secret cannot impersonate a user.
 *
 * The email in the request body is IGNORED. It is read from the verified token instead.
 * Do not reintroduce a body-supplied identity.
 */
exports.fetchUserByEmail = async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ error: 'A Google ID token is required' });
    }

    let claims;
    try {
      claims = await verifyGoogleIdToken(idToken, {
        clientId: process.env.GOOGLE_CLIENT_ID,
      });
    } catch (err) {
      // Deliberately terse to the caller; the detail goes to the server log only.
      console.warn('Rejected sign-in — Google ID token verification failed:', err.message);
      return res.status(401).json({ error: 'Google sign-in could not be verified' });
    }

    // The identity, from Google's signed claims — never from the request body.
    const email = claims.email;

    // Optional hard allowlist. When set it overrides the isApproved flag entirely, so a
    // database change alone cannot grant access to this deployment.
    const allowlist = (process.env.TELLER_ALLOWED_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (allowlist.length > 0 && !allowlist.includes(email)) {
      console.warn(`Rejected sign-in — ${email} is not in TELLER_ALLOWED_EMAILS`);
      return res.status(403).json({ error: 'Account not approved' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user is approved BEFORE generating token
    if (!user.isApproved) {
      return res.status(403).json({
        error: 'Account not approved',
        redirectTo: '/auth/error?error=not_approved'
      });
    }

    // Only generate token for approved users
    const token = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        accessLevel: user.accessLevel,
        isApproved: true  // We know it's true at this point
      },
      process.env.JWT_SECRET,
      { expiresIn: SESSION_TTL }
    );

    // Update last login only for approved users
    user.lastLogin = new Date();
    await user.save();

    res.status(200).json({
      user: {
        email: user.email,
        name: user.name,
        accessLevel: user.accessLevel,
        isApproved: true
      },
      token
    });
  } catch (error) {
    console.error('Error fetching user by email:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Verify token and fetch user
exports.verifyToken = async (req, res) => {
  try {
    // Get token from both body and header
    const token = req.body.token || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user exists and add timestamp check
    const user = await User.findOne({ _id: decoded.userId });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Add strict approval check
    if (!user.isApproved) {
      return res.status(403).json({ error: 'User is not approved' });
    }

    // Check token expiration
    if (decoded.exp && Date.now() >= decoded.exp * 1000) {
      return res.status(401).json({ error: 'Token has expired' });
    }

    res.status(200).json({
      user: {
        email: user.email,
        name: user.name,
        accessLevel: user.accessLevel,
        isApproved: user.isApproved
      },
      accessLevel: user.accessLevel
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token has expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    console.error('Error verifying token:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add this function to periodically clean up expired tokens
exports.cleanupExpiredTokens = async () => {
  try {
    const users = await User.find({
      lastLogin: { $lt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) } // 180 days
    });
    
    for (const user of users) {
      user.isApproved = false;  // Require re-approval for long-inactive users
      await user.save();
    }
  } catch (error) {
    console.error('Error cleaning up expired tokens:', error);
  }
}; 