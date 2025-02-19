const express = require('express');
const router = express.Router();
const pendingTransactionsController = require('../controllers/pendingTransactionsController');

router.post('/', pendingTransactionsController.createPendingTransactions);

module.exports = router; 