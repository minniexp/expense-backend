const Return = require('../models/Return');

exports.createReturn = async (req, res) => {
  try {
    const {
      total,
      date,
      description,
      lenderUserId,
      payeeUserId,
      returnedTransactionIds
    } = req.body;

    const newReturn = new Return({
      total,
      date,
      description,
      lenderUserId,
      payeeUserId,
      returnedTransactionIds: returnedTransactionIds || [],
      paidBackConfirmationPayee: false,
      paidBackConfirmationLender: false
    });

    const savedReturn = await newReturn.save();
    res.status(201).json(savedReturn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}; 