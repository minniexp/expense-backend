const Transaction = require('../models/Transaction');
const https = require('https');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const PendingTransactions = require('../models/PendingTransactions');

// Store access token temporarily (should be in database for production)
// let accessToken = 'test_token_rgtjiblbxhhto';

let accessToken = null;

// Configure mTLS options
const getTellerConfig = () => {  
  return {
    cert: fs.readFileSync(path.join(__dirname, '../certs/certificate.pem')),
    key: fs.readFileSync(path.join(__dirname, '../certs/private_key.pem')),
    rejectUnauthorized: true
  };
};

exports.getEnrollmentToken = async (req, res) => {
  try {
    // You'll get this from Teller's dashboard
    const applicationId = process.env.TELLER_APPLICATION_ID;
    
    res.json({ 
      applicationId,
      environment: process.env.TELLER_ENV || 'sandbox'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.handleAccessToken = async (req, res) => {
  try {
    const { accessToken: token } = req.body;
    accessToken = token;
    res.json({ success: true });
  } catch (err) {
    console.error('Error handling access token:', err);
    res.status(500).json({ error: err.message });
  }
};

const determinePurchaseCategory = (transaction) => {
  const purchaseCategories = new Set(); // Using Set to avoid duplicates
  const description = transaction.description.toUpperCase(); // Convert to uppercase for case-insensitive matching

  // Rule 1: Grocery stores
  const groceryStores = ['ALDI', 'H MART', 'JERRY S FRUIT', 'JOONG BOO MARKET', 'ASSI PLAZA'];
  if (groceryStores.some(store => description.includes(store.toUpperCase()))) {
    purchaseCategories.add('groceries');
  }

  // Rule 2: Amazon purchases
  if (description.includes('AMAZON')) {
    purchaseCategories.add('amazon');
  }

  // Rule 3: Drugstores
  const drugstores = ['WALGREENS', 'CVS'];
  if (drugstores.some(store => description.includes(store))) {
    purchaseCategories.add('drugstore');
  }

  // Rule 4 & 5: Dining category from transaction details
  if (transaction.details?.category === 'dining') {
    purchaseCategories.add('dining');
  }

  return Array.from(purchaseCategories); // Convert Set back to array
};

const calculatePoints = (cardName, purchaseCategories, month) => {
  // Rule 2: Chase College gets 0 points
  if (cardName === 'Chase College') {
    return 0;
  }

  // Temporary Rule: Freedom and Freedom Flex grocery purchases for Q1 (months 1-3)
  if ((cardName === 'Freedom' || cardName === 'Freedom Flex') && 
      purchaseCategories.includes('groceries') && 
      [1, 2, 3].includes(month)) {
    return 5;
  }

  // Rule 3: Sapphire Reserve Lyft purchases
  if (cardName === 'Sapphire Reserve' && purchaseCategories.includes('lyft')) {
    return 10;
  }

  // Rule 4: Travel rewards for specific cards
  const travelRewardCards = ['Sapphire Reserve', 'Freedom Unlimited', 'Freedom Flex'];
  if (travelRewardCards.includes(cardName) && purchaseCategories.includes('flight')) {
    return 5;
  }

  // Rule 5: Dining rewards for specific cards
  if (travelRewardCards.includes(cardName) && purchaseCategories.includes('dining')) {
    return 3;
  }

  // Rule 6: Freedom Unlimited base rate
  if (cardName === 'Freedom Unlimited') {
    return 1.5;
  }

  // Rule 1: Default case
  return 0;
};

const determineCategory = (transaction) => {
  const description = transaction.description.toUpperCase();

  // Rule 1: Parents Monthly (Grocery stores)
  const groceryStores = [
    'ALDI',
    'H MART',
    'JERRY S FRUIT',
    'JOONG BOO MARKET',
    'ASSI PLAZA'
  ];
  if (groceryStores.some(store => description.includes(store.toUpperCase()))) {
    return 'parents-monthly';
  }

  // Rule 2: Bill (Pilates)
  if (description.includes('WWW.SWAN-DIVEPILATES.C WWW.SWAN-DIVE')) {
    return 'bill';
  }

  // Rule 3: Doctors (Dental)
  if (description.includes('CAREONE DENTAL ASSOCIATES GLENVIEW')) {
    return 'doctors';
  }

  // Default case
  return '';
};

const determineTransactionType = (cardName, amount) => {
  // For Chase College and Cash, positive amount means income
  if (cardName === 'Chase College' || cardName === 'Cash') {
    return amount > 0 ? 'income' : 'expense';
  }
  
  // For all other cards, positive amount means expense
  return amount > 0 ? 'expense' : 'income';
};

// Add this helper function at the top with other helper functions
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

exports.getTellerTransactions = async (req, res) => {
  try {
    accessToken = process.env.TELLER_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(400).json({ 
        error: 'No access token available. Please connect a bank account first.' 
      });
    }

    // Fetch pending transaction document
    const pendingTransactionDoc = await PendingTransactions.findById(process.env.PENDING_TRANSACTIONS_ID);
    if (!pendingTransactionDoc) {
      return res.status(404).json({ 
        error: 'Pending transaction document not found' 
      });
    }

    const { lastTellerTransactionId, lastDate } = pendingTransactionDoc;
    console.log('Last processed date:', lastDate);
    console.log('Last transaction ID:', lastTellerTransactionId);

    // Define card mapping with card names as keys
    const cardMapping = {
      'Amazon Visa': process.env.AMAZON_VISA_ID,
      'Chase College': process.env.CHASE_COLLEGE_ID,
      'Freedom Flex': process.env.FREEDOM_FLEX_ID,
      'Sapphire Reserve': process.env.SAPPHIRE_RESERVE_ID,
      'Freedom': process.env.FREEDOM_ID,
      'Freedom Unlimited': process.env.FREEDOM_UNLIMITED_ID
    };

    const agent = new https.Agent(getTellerConfig());
    const allTransactions = [];

    // Get transactions for each card
    for (const [cardName, accountId] of Object.entries(cardMapping)) {
      const transactionsResponse = await fetch(
        `https://api.teller.io/accounts/${accountId}/transactions?count=100`,
        {
          method: 'GET',
          agent,
          headers: {
            'Authorization': `Basic ${Buffer.from(`${accessToken}:`).toString('base64')}`,
            'Accept': 'application/json'
          },
        }
      );

      if (!transactionsResponse.ok) {
        console.error(`Error fetching transactions for ${cardName} (${accountId})`);
        continue;
      }

      const transactions = await transactionsResponse.json();
      
      // Format transactions and filter
      const formattedTransactions = transactions
        .filter(transaction => {
          // Filter out transactions older than lastDate
          const transactionDate = new Date(transaction.date);
          const lastProcessedDate = new Date(lastDate);
          
          const is2025 = transaction.date.startsWith('2025');
          const isNewerThanLastDate = transactionDate > lastProcessedDate;
          
          const excludedPhrases = [
            'Payment to Chase card ending in',
            'PAYMENT TO CHASE CARD ENDING IN',
            'Payment Thank You-Mobile',
            'PAYMENT-THANK YOU',
            'Online Transfer'
          ];
          const shouldExclude = excludedPhrases.some(phrase => 
            transaction.description.includes(phrase)
          );
          
          return is2025 && isNewerThanLastDate && !shouldExclude;
        })
        .map(transaction => {
          const [year, month, day] = transaction.date.split('-').map(Number);
          const purchaseCategories = determinePurchaseCategory(transaction);
          const category = determineCategory(transaction);
          const isParentsMonthly = category === 'parents-monthly';

          return {
            userId: process.env.MONGODB_USERID,
            tellerTransactionId: transaction.id,
            date: transaction.date,
            year,
            month,
            day,
            amount: transaction.amount,
            transactionType: determineTransactionType(cardName, transaction.amount),
            notes: '',
            category,
            purchaseCategory: purchaseCategories,
            description: transaction.description,
            paymentMethod: cardName,
            points: calculatePoints(cardName, purchaseCategories, month),
            returnId: isParentsMonthly ? getReturnIdForMonth(month) : null,
            returned: false,
            needToBePaidback: isParentsMonthly
          };
        });

      allTransactions.push(...formattedTransactions);
    }

    // Sort all transactions by date
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    res.json(allTransactions);
  } catch (error) {
    console.error('Error in getAllTransactions:', error);
    res.status(500).json({ error: error.message });
  }
};
