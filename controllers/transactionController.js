const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Return = require('../models/Return');
const PendingTransactions = require('../models/PendingTransactions');
const { planReturnUnlink } = require('../services/returnUnlink');
const { sortNewestFirst } = require('../services/transactionSort');
const { buildManualTransaction, parseCardLast4Map, isSameTransaction } = require('../services/manualTransaction');

const getReturnIdForMonth = (year, month) => {
  const monthMap = {
    1: process.env[`${year}_JAN_RETURNID`],
    2: process.env[`${year}_FEB_RETURNID`],
    3: process.env[`${year}_MAR_RETURNID`],
    4: process.env[`${year}_APR_RETURNID`],
    5: process.env[`${year}_MAY_RETURNID`],
    6: process.env[`${year}_JUN_RETURNID`],
    7: process.env[`${year}_JUL_RETURNID`],
    8: process.env[`${year}_AUG_RETURNID`],
    9: process.env[`${year}_SEP_RETURNID`],
    10: process.env[`${year}_OCT_RETURNID`],
    11: process.env[`${year}_NOV_RETURNID`],
    12: process.env[`${year}_DEC_RETURNID`]
  };
  return monthMap[month];
};

exports.getTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find()
      .sort({ date: -1 });

    // Collect all unique return IDs from transactions
    const returnIds = [...new Set(
      transactions
        .map(t => t.returnId)
        .filter(id => id && id !== 'pending')
    )];

    // Fetch all referenced return documents in one query
    const returnDocs = returnIds.length > 0
      ? await Return.find({ _id: { $in: returnIds } }, 'description')
      : [];

    // Create a map of return IDs to return descriptions
    const returnMap = returnDocs.reduce((map, ret) => {
      map[ret._id.toString()] = ret.description || 'No description';
      return map;
    }, {});

    // Enhance transactions with return descriptions
    const enhancedTransactions = transactions.map(t => {
      const transaction = t.toObject();
      if (transaction.returnId && returnMap[transaction.returnId]) {
        transaction.returnDescription = returnMap[transaction.returnId];
      }
      return transaction;
    });

    // Mongo's `sort({ date: -1 })` above settles the day and says nothing about what happens
    // within it. This settles the rest, and is the same comparator every other endpoint uses.
    res.json(sortNewestFirst(enhancedTransactions));
  } catch (err) {
    console.error('Error getting transactions:', err);
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
    }).lean();

    res.json(sortNewestFirst(transactions));
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
    const transactions = req.body;

    console.log('createBulkTransactions transactions', transactions);

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
        return null;
      }

      const isParentsMonthly = transaction.category === 'parents-monthly';
      const returnId = isParentsMonthly ? getReturnIdForMonth(transaction.year, transaction.month) : transaction.returnId;

      // Prepare the transaction object for insertion
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

    // Save the processed transactions to MongoDB
    const savedTransactions = await Transaction.insertMany(newTransactions);

    // After saving transactions, update return documents
    await Promise.all(savedTransactions.map(async (savedTransaction, index) => {
      const returnId = savedTransaction.returnId;
      
      // If returnId exists, update the return document
      if (returnId) {
        try {
          const returnDoc = await Return.findById(returnId);
          
          if (returnDoc) {
            console.log(`Updating Return document ${returnId} with transaction ${savedTransaction._id}`);
            
            // Add MongoDB _id to returnedTransactionIds
            if (!returnDoc.returnedTransactionIds.includes(savedTransaction._id.toString())) {
              returnDoc.returnedTransactionIds.push(savedTransaction._id.toString());
            }
            
            // Add tellerTransactionId to returnedTellerTransactionIds
            if (savedTransaction.tellerTransactionId && 
                !returnDoc.returnedTellerTransactionIds.includes(savedTransaction.tellerTransactionId)) {
              returnDoc.returnedTellerTransactionIds.push(savedTransaction.tellerTransactionId);
            }
            
            // If it's an expense, also update the total amount
            if (savedTransaction.transactionType === 'expense') {
              const currentTotal = Number(returnDoc.total) || 0;
              const transactionAmount = Number(savedTransaction.amount);
              
              if (!isNaN(transactionAmount)) {
                returnDoc.total = currentTotal + transactionAmount;
              }
            }
            
            await returnDoc.save();
            console.log(`Successfully updated Return document ${returnId}`);
          } else {
            console.log(`Return document ${returnId} not found`);
          }
        } catch (error) {
          console.error(`Error updating Return document ${returnId}:`, error);
        }
      }
    }));

    // After successfully creating new transactions, update PendingTransactions
    if (savedTransactions.length > 0) {
      // Sort transactions by date to get the newest and oldest
      const sortedTransactions = savedTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
      const newestTransaction = sortedTransactions[0];
      const oldestTransaction = sortedTransactions[sortedTransactions.length - 1];

      // Log transaction date ranges
      console.log('Creating transactions with date range:');
      console.log('Newest transaction date:', newestTransaction.date);
      console.log('Oldest transaction date:', oldestTransaction.date);

      // Update PendingTransactions.
      //
      // ⚠️ INFORMATIONAL ONLY — DO NOT FILTER ON THIS.
      // `lastDate` used to be a high-water mark that the Teller sync filtered on
      // (`date > lastDate`). That silently swallowed 506 transactions: Chase reports the
      // transaction date rather than the posting date and posts in batches through the day,
      // so anything arriving later with an equal-or-earlier date was dropped forever. Worse,
      // this line advances the mark to the newest transaction the user chose to SAVE, burying
      // any older transaction they left unreviewed.
      //
      // The sync now set-differences on `tellerTransactionId` instead
      // (services/transactionSync.js). This field is kept only as a record of the last save.
      await PendingTransactions.findByIdAndUpdate(
        process.env.PENDING_TRANSACTIONS_ID,
        {
          lastDate: newestTransaction.date,
          lastTellerTransactionId: newestTransaction.tellerTransactionId
        },
        { new: true }
      );

      console.log('Recorded last save date (informational):', newestTransaction.date);
    }
    
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

/**
 * POST /api/transactions/manual
 *
 * Type a transaction in by hand. Deliberately NOT the older /single route, which passes the request
 * body to the model almost untouched: it never normalised the amount's sign, never set `source`,
 * accepted whatever `userId` the browser sent — which is how seventy-five rows came to belong to
 * "default-user" — and had no duplicate check at all.
 *
 * This runs the same builder the bank alerts do, so a hand-typed row and an ingested one are
 * indistinguishable afterwards: same sign convention, same category and points derivation, same
 * content-derived id.
 */
exports.createManualTransaction = async (req, res) => {
  try {
    const userId = (req.user && req.user.userId) || process.env.MINID;
    if (!userId) return res.status(503).json({ message: 'Server is not configured for this request' });

    let record;
    try {
      record = buildManualTransaction(req.body || {}, {
        userId,
        returnIdForMonth: getReturnIdForMonth,
        source: 'manual',
        cardLast4Map: parseCardLast4Map(process.env.CARD_LAST4_MAP),
      });
    } catch (e) {
      // The sender's to fix, not a 500.
      return res.status(400).json({ message: e.message });
    }

    // Somebody sat and typed this, so it has been reviewed by definition — unlike an alert, which
    // arrives with a category guessed from the merchant and nobody having looked.
    record.reviewed = true;

    if (!req.body.allowDuplicate) {
      const candidates = await Transaction.find({
        date: record.date, amount: record.amount, transactionType: record.transactionType,
      }).lean();
      const existing = candidates.find((c) => isSameTransaction(record, c));
      if (existing) {
        return res.status(200).json({
          message: 'That transaction is already logged.',
          duplicate: true,
          transaction: existing,
        });
      }
    }

    const saved = await Transaction.create(record);
    console.log(`[POST /transactions/manual] created=1 source=manual`);
    res.status(201).json({ message: 'Saved.', duplicate: false, transaction: saved });
  } catch (err) {
    console.error('Error creating manual transaction:', err);
    res.status(500).json({ message: err.message });
  }
};

/** A selection made by hand in a grid. Far above any real one, low enough to bound a mistake. */
const MAX_DELETE_BATCH = 200;

/**
 * POST /api/transactions/delete   Body: { ids: [mongoId, ...] }
 *
 * Delete chosen rows. POST rather than DELETE because the ids travel in a body, which DELETE does
 * not carry reliably — the same reason /api/teller/ignored is a POST.
 *
 * The work that is easy to miss is the un-linking. A Return keeps its own copy of the transaction
 * ids it covers and a running `total` that was incremented when each row was added. Deleting a row
 * without reversing that leaves a dangling reference and a total that overstates what is owed, and
 * nothing anywhere recomputes it — the number would simply be wrong from then on.
 */
exports.deleteTransactions = async (req, res) => {
  try {
    const ids = req.body && req.body.ids;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Send { ids: [...] } with at least one transaction id.' });
    }
    if (ids.length > MAX_DELETE_BATCH) {
      return res.status(400).json({
        message: `Too many transactions (${ids.length}; max ${MAX_DELETE_BATCH}).`,
      });
    }

    const valid = [...new Set(ids.filter((id) => mongoose.Types.ObjectId.isValid(id)).map(String))];
    const invalid = ids.length - valid.length;
    if (valid.length === 0) {
      return res.status(400).json({ message: 'No valid transaction ids were supplied.' });
    }

    // Read them before deleting: once the rows are gone there is no way to know which Returns
    // referenced them or how much to take off each total.
    const docs = await Transaction.find({ _id: { $in: valid } });
    if (docs.length === 0) {
      return res.status(404).json({ message: 'None of those transactions exist.' });
    }

    const byReturn = new Map();
    for (const doc of docs) {
      if (!doc.returnId) continue;
      const key = String(doc.returnId);
      if (!byReturn.has(key)) byReturn.set(key, []);
      byReturn.get(key).push(doc);
    }

    const unlinked = [];
    for (const [returnId, group] of byReturn) {
      const returnDoc = await Return.findById(returnId);
      if (!returnDoc) continue;

      const plan = planReturnUnlink(returnDoc, group);
      returnDoc.returnedTransactionIds = plan.returnedTransactionIds;
      returnDoc.returnedTellerTransactionIds = plan.returnedTellerTransactionIds;
      returnDoc.total = plan.total;

      await returnDoc.save();
      unlinked.push({ returnId, removedFromTotal: plan.removedFromTotal, count: group.length });
    }

    const result = await Transaction.deleteMany({ _id: { $in: docs.map((d) => d._id) } });

    // Deliberately no amounts or descriptions — this runs on a hosted log stream.
    console.log(`[POST /transactions/delete] requested=${ids.length} deleted=${result.deletedCount} `
      + `returnsTouched=${unlinked.length} invalidIds=${invalid}`);

    res.json({
      message: `Deleted ${result.deletedCount} transaction(s).`,
      deleted: result.deletedCount,
      requested: ids.length,
      ...(invalid ? { invalidIds: invalid } : {}),
      ...(unlinked.length ? { unlinkedFromReturns: unlinked } : {}),
    });
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
            reviewed: transaction.reviewed,
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

exports.getTransactionsByIds = async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Invalid or empty transaction IDs array' });
    }
    
    const transactions = await Transaction.find({
      _id: { $in: ids }
    }).lean();

    // Same order as everywhere else. The payee summary renders this list straight out, so the
    // ordering has to arrive correct — it does no sorting of its own.
    res.json(sortNewestFirst(transactions));
  } catch (err) {
    console.error('Error fetching transactions by IDs:', err);
    res.status(500).json({ message: err.message });
  }
};