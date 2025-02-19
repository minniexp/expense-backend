const PendingTransactions = require('../models/PendingTransactions');

exports.createPendingTransactions = async (req, res) => {
  try {
    const {
      lastDate,
      lastTellerTransactionId,
      pendingTransactions
    } = req.body;

    const newPendingTransactions = new PendingTransactions({
      lastDate,
      lastTellerTransactionId,
      pendingTransactions: pendingTransactions || []
    });

    const savedPendingTransactions = await newPendingTransactions.save();
    res.status(201).json(savedPendingTransactions);
  } catch (err) {
    console.error('Error creating pending transactions:', err);
    res.status(400).json({ message: err.message });
  }
}; 