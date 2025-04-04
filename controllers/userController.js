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
  console.log("fetchUserByEmail called")
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update last login time
    user.lastLogin = new Date();
    await user.save();

    // Generate a session token valid for 6 months
    const token = jwt.sign(
      { 
        userId: user._id,
        email: user.email,
        accessLevel: user.accessLevel,
        isApproved: user.isApproved
      },
      process.env.JWT_SECRET,
      { expiresIn: '180d' } // 180 days
    );

    res.status(200).json({
      user: {
        email: user.email,
        name: user.name,
        accessLevel: user.accessLevel,
        isApproved: user.isApproved
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
    console.log("verifyToken called in server")
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user exists
    const user = await User.findOne({ _id: decoded.userId });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.isApproved) {
      return res.status(403).json({ error: 'User is not approved' });
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