const mongoose = require('mongoose');
const Return = require('../models/Return');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

exports.createReturn = async (req, res) => {
  try {
    const {
      total,
      date,
      description,
      lenderUserId,
      payeeUserId,
      returnedTransactionIds,
      returnedTellerTransactionIds
    } = req.body;

    const newReturn = new Return({
      total,
      date,
      description,
      lenderUserId,
      payeeUserId,
      returnedTransactionIds: returnedTransactionIds || [],
      returnedTellerTransactionIds: returnedTellerTransactionIds || [],
      paidBackConfirmationPayee: false,
      paidBackConfirmationLender: false
    });

    const savedReturn = await newReturn.save();
    res.status(201).json(savedReturn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// Get all return documents with user information
exports.getAllReturns = async (req, res) => {
  try {
    // Fetch all returns
    const returns = await Return.find();
    
    // Prepare enhanced returns with user information
    const enhancedReturns = await Promise.all(returns.map(async (returnDoc) => {
      const returnObj = returnDoc.toObject();
      
      // Fetch lender user info if lenderUserId exists
      if (returnObj.lenderUserId) {
        try {
          const lenderUser = await User.findById(returnObj.lenderUserId);
          if (lenderUser) {
            returnObj.lenderUser = {
              name: lenderUser.name,
              email: lenderUser.email
            };
          }
        } catch (err) {
          console.error(`Error fetching lender user (${returnObj.lenderUserId}):`, err);
        }
      }
      
      // Fetch payee user info if payeeUserId exists
      if (returnObj.payeeUserId) {
        try {
          const payeeUser = await User.findById(returnObj.payeeUserId);
          if (payeeUser) {
            returnObj.payeeUser = {
              name: payeeUser.name,
              email: payeeUser.email
            };
          }
        } catch (err) {
          console.error(`Error fetching payee user (${returnObj.payeeUserId}):`, err);
        }
      }
      
      return returnObj;
    }));
    
    res.status(200).json(enhancedReturns);
  } catch (err) {
    console.error('Error in getAllReturns:', err);
    res.status(500).json({ message: err.message });
  }
};

// Update a return document by ID
exports.updateReturn = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if return exists
    const returnExists = await Return.findById(id);
    if (!returnExists) {
      return res.status(404).json({ message: 'Return document not found' });
    }
    
    // Update the return document
    const updatedReturn = await Return.findByIdAndUpdate(
      id, 
      req.body, 
      { new: true, runValidators: true }
    );
    
    res.status(200).json(updatedReturn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// Delete a return document by ID
exports.deleteReturn = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if return exists
    const returnExists = await Return.findById(id);
    if (!returnExists) {
      return res.status(404).json({ message: 'Return document not found' });
    }
    
    // Delete the return document
    await Return.findByIdAndDelete(id);
    
    res.status(200).json({ message: 'Return document deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Fix transaction lookup by using a different field than _id
const getTransactionsByIds = async (transactionIds) => {
  try {
    // Instead of findById which uses _id, use find with tellerTransactionId
    const transactions = await Transaction.find({
      tellerTransactionId: { $in: transactionIds }
    });
    return transactions;
  } catch (error) {
    console.error('Error fetching transactions by IDs:', error);
    return [];
  }
};

// Fix user lookup with proper error handling
exports.getReturnById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const returnDoc = await Return.findById(id);
    if (!returnDoc) {
      return res.status(404).json({ message: 'Return document not found' });
    }
    
    // Enhance with user information
    const returnObj = returnDoc.toObject();
    
    // Fetch lender user info if lenderUserId exists
    if (returnObj.lenderUserId) {
      try {
        // Check if the ID is a valid ObjectId
        if (mongoose.Types.ObjectId.isValid(returnObj.lenderUserId)) {
          const lenderUser = await User.findById(returnObj.lenderUserId);
          if (lenderUser) {
            returnObj.lenderUser = {
              name: lenderUser.name,
              email: lenderUser.email
            };
          }
        } else {
          console.log(`Skipping lookup for invalid ObjectId: ${returnObj.lenderUserId}`);
        }
      } catch (err) {
        console.error(`Error fetching lender user (${returnObj.lenderUserId}):`, err);
      }
    }
    
    // Similar fix for payee user lookup
    if (returnObj.payeeUserId) {
      try {
        if (mongoose.Types.ObjectId.isValid(returnObj.payeeUserId)) {
          const payeeUser = await User.findById(returnObj.payeeUserId);
          if (payeeUser) {
            returnObj.payeeUser = {
              name: payeeUser.name,
              email: payeeUser.email
            };
          }
        } else {
          console.log(`Skipping lookup for invalid ObjectId: ${returnObj.payeeUserId}`);
        }
      } catch (err) {
        console.error(`Error fetching payee user (${returnObj.payeeUserId}):`, err);
      }
    }
    
    res.json(returnObj);
  } catch (err) {
    console.error('Error in getReturnById:', err);
    res.status(500).json({ message: err.message });
  }
};

/**
 * Migrates return documents to use the new dual ID structure.
 * Converts existing returnedTransactionIds (which may contain teller IDs) into:
 * - returnedTransactionIds: MongoDB transaction IDs only
 * - returnedTellerTransactionIds: Teller transaction IDs only
 */
exports.migrateReturnTransactionIds = async (req, res) => {
  try {
    // Get all return documents with non-empty returnedTransactionIds
    const returns = await Return.find({
      returnedTransactionIds: { $exists: true, $ne: [] }
    });
    
    console.log(`Found ${returns.length} return documents with transaction IDs to migrate`);
    
    const results = {
      processed: 0,
      updated: 0,
      skipped: 0,
      errors: []
    };

    // Process each return document
    for (const returnDoc of returns) {
      try {
        results.processed++;
        console.log(`Processing return ${returnDoc._id} with ${returnDoc.returnedTransactionIds.length} transaction IDs`);
        
        // Initialize new arrays
        const mongoIds = [];
        const tellerIds = [];
        
        // Check each ID in the returnedTransactionIds array
        for (const id of returnDoc.returnedTransactionIds) {
          // Try to find transaction by MongoDB ID first
          let transaction = null;
          
          // If it looks like a MongoDB ObjectId (24 hex chars), try to find by _id
          if (mongoose.Types.ObjectId.isValid(id) && id.length === 24) {
            try {
              transaction = await Transaction.findById(id);
              if (transaction) {
                console.log(`Found transaction by MongoDB ID: ${id}`);
                mongoIds.push(id);
                
                // If this transaction has a tellerTransactionId, save it
                if (transaction.tellerTransactionId) {
                  tellerIds.push(transaction.tellerTransactionId);
                }
                continue; // Skip to next ID
              }
            } catch (err) {
              console.log(`Error looking up by MongoDB ID ${id}:`, err.message);
            }
          }
          
          // If not found by MongoDB ID, try to find by tellerTransactionId
          try {
            transaction = await Transaction.findOne({ tellerTransactionId: id });
            if (transaction) {
              console.log(`Found transaction by teller ID: ${id}`);
              // Add MongoDB ID to mongoIds
              mongoIds.push(transaction._id.toString());
              // Add teller ID to tellerIds
              tellerIds.push(id);
              continue; // Skip to next ID
            }
          } catch (err) {
            console.log(`Error looking up by teller ID ${id}:`, err.message);
          }
          
          // If we got here, we couldn't find the transaction
          console.log(`Could not find transaction with ID: ${id}`);
        }
        
        // Remove duplicates
        const uniqueMongoIds = [...new Set(mongoIds)];
        const uniqueTellerIds = [...new Set(tellerIds)];
        
        console.log(`Return ${returnDoc._id}: Found ${uniqueMongoIds.length} MongoDB IDs and ${uniqueTellerIds.length} teller IDs`);
        
        // Update the return document with the new arrays
        if (uniqueMongoIds.length > 0 || uniqueTellerIds.length > 0) {
          returnDoc.returnedTransactionIds = uniqueMongoIds;
          returnDoc.returnedTellerTransactionIds = uniqueTellerIds;
          await returnDoc.save();
          results.updated++;
          console.log(`Updated return ${returnDoc._id} with new ID arrays`);
        } else {
          results.skipped++;
          console.log(`Skipped return ${returnDoc._id}: No valid transaction IDs found`);
        }
      } catch (err) {
        console.error(`Error processing return ${returnDoc._id}:`, err);
        results.errors.push({
          returnId: returnDoc._id,
          error: err.message
        });
      }
    }
    
    res.json({
      message: `Migration completed: processed ${results.processed} returns, updated ${results.updated}, skipped ${results.skipped}, with ${results.errors.length} errors`,
      results
    });
  } catch (err) {
    console.error('Error in migrateReturnTransactionIds:', err);
    res.status(500).json({ message: err.message });
  }
}; 