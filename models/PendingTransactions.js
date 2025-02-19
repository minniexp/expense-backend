const mongoose = require('mongoose');

const pendingTransactionsSchema = new mongoose.Schema({
  lastDate: {
    type: String,
    required: false
  },
  lastTellerTransactionId: {
    type: String,
    required: false
  },
  pendingTransactions: {
    type: [{
      userId: {
        type: String,
        required: false
      },
      tellerTransactionId: {
        type: String,
        required: false
      },
      date: {
        type: String,
        required: true
      },
      year: {
        type: Number,
        required: false
      },
      month: {
        type: Number,
        required: false
      },
      day: {
        type: Number,
        required: false
      },
      amount: {
        type: Number,
        required: false
      },
      transactionType: {
        type: String,
        default: ''
      },
      notes: {
        type: String,
        default: ''
      },
      category: {
        type: String,
        default: ''
      },
      purchaseCategory: {
        type: [String],
        default: []
      },
      description: {
        type: String,
        default: ''
      },
      paymentMethod: {
        type: String,
        default: ''
      },
      points: {
        type: Number,
        default: 0
      },
      returnId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Return',
        default: null
      },
      returned: {
        type: Boolean,
        default: false
      },
      needToBePaidback: {
        type: Boolean,
        default: false
      }
    }],
    default: []
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('PendingTransactions', pendingTransactionsSchema); 