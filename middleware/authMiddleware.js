const jwt = require('jsonwebtoken');
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
    
    // Check if user exists
    const user = await User.findOne({ _id: decoded.userId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!user.isApproved) {
      return res.status(403).json({ error: 'User is not approved' });
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

// Middleware to validate secret key (for backward compatibility)
const validateSecretKey = (req, res, next) => {
  // Skip validation for GET requests
  if (req.method === 'GET') {
    return next();
  }

  // Check if secret key matches
  if (process.env.SECRET_KEY !== process.env.CHECK_KEY) {
    return res.status(401).json({ 
      message: 'Unauthorized: Invalid secret key' 
    });
  }

  console.log('Secret key validated');
  next();
};

module.exports = {
  validateToken,
  requireAdvancedAccess,
  validateSecretKey
}; 