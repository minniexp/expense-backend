const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  // User and Identification
  userId: {
    type: String,
    required: true
  },
  tellerTransactionId: {
    type: String,
    required: false
  },

  // Date Information
  year: {
    type: Number,
    required: false
  },
  month: {
    type: Number,
    required: true,
    min: 1,
    max: 12
  },
  day: {
    type: Number,
    required: true,
    min: 1,
    max: 31
  },
  date: {
    type: String,
    required: true
  },

  // Transaction Details
  description: {
    type: String,
    required: false
  },
  amount: {
    type: Number,
    required: true
  },
  category: {
    type: String,
    enum: [
      'fuel',
      'personal',
      'parents-monthly',
      'parents-not monthly',
      'bill',
      'emergency',
      'travel',
      'offering',
      'doctors',
      'automobile',
      'korea',
      'business',
      ''
    ],
    required: false
  },
  purchaseCategory: {
    type: [String],
    enum: [
      'groceries',
      'amazon',
      'dining',
      'gift',
      'gift card',
      'birthday gift',
      'wedding gift',
      'health',
      'flight',
      'hotel',
      'drugstore',
      'lyft',
      'travel',
      'international',
      'fuel'
    ],
    default: []
  },

  // Payment Information
  paymentMethod: {
    type: String,
    required: false
  },
  points: {
    type: Number,
    default: 0
  },
  transactionType: {
    type: String,
    enum: ['income', 'expense'],
    required: true
  },

  // Return Information
  returnId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Return',
    default: null
  },
  returned: {
    type: Boolean,
    default: false
  },

  // Additional Information
  needToBePaidback: {
    type: Boolean,
    default: false
  },
  notes: {
    type: String,
    default: ''
  },
}, {
  timestamps: true
});

module.exports = mongoose.model('Transaction', transactionSchema);  