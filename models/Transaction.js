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
  // Where the row came from. The id field above is still the dedupe key for every source —
  // renaming it would mean a migration across every consumer — so this records provenance
  // explicitly now that transactions arrive from more than one place.
  source: {
    type: String,
    enum: ['teller', 'manual', 'phone', 'csv'],
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
  // Clock time as a bank alert email printed it, verbatim (e.g. "8:51 PM ET"). Kept as a string
  // rather than folded into a Date: converting needs both the alert's zone and the reader's, and a
  // wrong guess silently moves a late-evening purchase onto the neighbouring day. Empty for every
  // row that did not come from an alert — the bank feed reports a date only.
  time: {
    type: String,
    default: ''
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
      'misc',
      'payroll',
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
  // Last four of the card as printed in the alert that produced this row. Resolving it to a
  // canonical paymentMethod is services/manualTransaction.js's job; this only records what the bank
  // said, so a mis-mapped card can be found later instead of surfacing as an unexplained total.
  cardLast4: {
    type: String,
    default: ''
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