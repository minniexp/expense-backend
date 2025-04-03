const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  googleId: {
    type: String,
    unique: true,
    sparse: true // Allows for null values if not all users have a Google ID
  },
  isApproved: {
    type: Boolean,
    default: false
  },
  lastLogin: {
    type: Date
  },
  accessLevel: {
    type: String,
    enum: ['simple', 'advanced'],
    default: 'simple'
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt fields
});

module.exports = mongoose.model('User', userSchema); 