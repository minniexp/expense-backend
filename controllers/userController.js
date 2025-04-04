const User = require('../models/User');
const jwt = require('jsonwebtoken');

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

// Fetch user by email
exports.fetchUserByEmail = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
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
      { expiresIn: '180d' }
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