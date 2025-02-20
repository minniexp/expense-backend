const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Return = require('../models/Return');

const getReturnIdForMonth = (month) => {
  const monthMap = {
    1: process.env.JAN_RETURNID,
    2: process.env.FEB_RETURNID,
    3: process.env.MAR_RETURNID,
    4: process.env.APR_RETURNID,
    5: process.env.MAY_RETURNID,
    6: process.env.JUN_RETURNID,
    7: process.env.JUL_RETURNID,
    8: process.env.AUG_RETURNID,
    9: process.env.SEP_RETURNID,
    10: process.env.OCT_RETURNID,
    11: process.env.NOV_RETURNID,
    12: process.env.DEC_RETURNID
  };
  return monthMap[month];
};

exports.getTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ date: -1 });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getMonthTransactions = async (req, res) => {
  try {
    const { month, year } = req.params;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const transactions = await Transaction.find({
      date: {
        $gte: startDate,
        $lte: endDate
      }
    }).sort({ date: 1 });

    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createTransaction = async (req, res) => {
  try {
    // Add default userId if not provided
    const transactionData = req.body[0];
    transactionData.userId = transactionData.userId ||process.env.MONGODB_USERID;

    // Validate required fields
    const requiredFields = ['transactionType', 'amount', 'date', 'day', 'month'];
    const missingFields = requiredFields.filter(field => !transactionData[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({ 
        message: `Missing required fields: ${missingFields.join(', ')}`,
        requiredFields: missingFields
      });
    }

    const transaction = new Transaction(transactionData);
    const savedTransaction = await transaction.save();
    res.status(201).json(savedTransaction);
  } catch (err) {
    console.error('Error creating transaction:', err);
    res.status(400).json({ 
      message: err.message,
      details: err.errors ? Object.keys(err.errors).map(key => ({
        field: key,
        message: err.errors[key].message
      })) : null
    });
  }
};

exports.createBulkTransactions = async (req, res) => {
  try {
    const transactions = req.body[0];
    console.log("createBulkTransactions: ", transactions);

    if (!Array.isArray(transactions)) {
      return res.status(400).json({ 
        message: 'Request body must be an array of transactions' 
      });
    }

    // Process each transaction and update return documents
    const processedTransactions = await Promise.all(transactions.map(async transaction => {
      // Check if transaction already exists
      const existingTransaction = await Transaction.findOne({ 
        tellerTransactionId: transaction.tellerTransactionId 
      });

      if (existingTransaction) {
        console.log(`Transaction ${transaction.tellerTransactionId} already exists, skipping...`);
        return null; // Skip this transaction
      }

      const isParentsMonthly = transaction.category === 'parents-monthly';
      const returnId = isParentsMonthly ? getReturnIdForMonth(transaction.month) : null;

      // If parents-monthly, update the return document
      if (isParentsMonthly && returnId) {
        const returnDoc = await Return.findById(returnId);
        if (returnDoc) {
          if (transaction.transactionType === 'expense') {
            const currentTotal = Number(returnDoc.total) || 0;
            const transactionAmount = Number(transaction.amount);
            
            if (!isNaN(transactionAmount)) {
              returnDoc.total = currentTotal + transactionAmount;
              returnDoc.returnedTransactionIds.push(transaction.tellerTransactionId);
              await returnDoc.save();
            } else {
              console.error(`Invalid transaction amount for ID: ${transaction.tellerTransactionId}`);
            }
          }
        }
      }

      return {
        userId: transaction.userId || process.env.MONGODB_MOMID,
        tellerTransactionId: transaction.tellerTransactionId,
        year: transaction.year,
        month: transaction.month,
        day: transaction.day,
        date: transaction.date,
        description: transaction.description || '',
        amount: transaction.amount,
        category: transaction.category || '',
        purchaseCategory: transaction.purchaseCategory || [],
        paymentMethod: transaction.paymentMethod || '',
        points: transaction.points || 0,
        transactionType: transaction.transactionType,
        returnId: returnId,
        returned: transaction.returned || false,
        needToBePaidback: isParentsMonthly,
        notes: transaction.notes || ''
      };
    }));

    // Filter out null values (skipped transactions) and save new ones
    const newTransactions = processedTransactions.filter(transaction => transaction !== null);
    
    if (newTransactions.length === 0) {
      return res.json({ message: 'No new transactions to save' });
    }

    const savedTransactions = await Transaction.insertMany(newTransactions);
    
    console.log(`Successfully created ${savedTransactions.length} new transactions`);
    res.status(201).json(savedTransactions);
  } catch (err) {
    console.error('Error in createBulkTransactions:', err);
    res.status(400).json({ message: err.message });
  }
};

exports.deleteAllTransactions = async (req, res) => {
  try {
    await Transaction.deleteMany({});
    res.json({ message: 'All transactions deleted successfully' });
  } catch (err) {
    console.error('Error deleting transactions:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.updateTransactionsMany = async (req, res) => {
  try {
    const transactions = req.body;

    if (!Array.isArray(transactions)) {
      return res.status(400).json({ 
        message: 'Request body must be an array of transactions' 
      });
    }

    const results = {
      successful: [],
      failed: []
    };

    // Process each transaction update
    await Promise.all(transactions.map(async (transaction) => {
      try {
        // Check if _id exists
        if (!transaction._id) {
          results.failed.push({
            transaction,
            error: 'Missing MongoDB ID (_id)'
          });
          return;
        }

        // Check if transaction exists in database
        const existingTransaction = await Transaction.findById(transaction._id);
        
        if (!existingTransaction) {
          results.failed.push({
            transaction,
            error: `Transaction with ID ${transaction._id} not found`
          });
          return;
        }

        // Update the transaction
        const updatedTransaction = await Transaction.findByIdAndUpdate(
          transaction._id,
          {
            userId: transaction.userId || process.env.MONGODB_USERID,
            tellerTransactionId: transaction.tellerTransactionId,
            year: transaction.year,
            month: transaction.month,
            day: transaction.day,
            date: transaction.date,
            description: transaction.description,
            amount: transaction.amount,
            category: transaction.category,
            purchaseCategory: transaction.purchaseCategory,
            paymentMethod: transaction.paymentMethod,
            points: transaction.points,
            transactionType: transaction.transactionType,
            returnId: transaction.returnId,
            returned: transaction.returned,
            needToBePaidback: transaction.needToBePaidback,
            notes: transaction.notes
          },
          { new: true, runValidators: true }
        );

        results.successful.push(updatedTransaction);
      } catch (error) {
        results.failed.push({
          transaction,
          error: error.message
        });
      }
    }));

    // Return results
    res.json({
      message: `Updated ${results.successful.length} transactions, ${results.failed.length} failed`,
      successful: results.successful,
      failed: results.failed
    });

  } catch (error) {
    console.error('Error in updateTransactionsMany:', error);
    res.status(500).json({ 
      message: 'Error updating transactions',
      error: error.message 
    });
  }
};