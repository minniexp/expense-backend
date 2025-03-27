const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  total: {
    type: Number,
    required: true
  },
  date: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: false
  },
  lenderUserId: {
    type: String,
    required: false
  },
  payeeUserId: {
    type: String,
    required: false
  },
  returnedTransactionIds: {
    type: [String],
    default: []
  },
  returnedTellerTransactionIds: {
    type: [String],
    default: []
  },
  paidBackConfirmationPayee: {
    type: Boolean,
    default: false
  },
  paidBackConfirmationLender: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Return', returnSchema); 