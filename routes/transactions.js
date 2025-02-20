const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');

router.get('/', transactionController.getTransactions);
router.get('/:year/:month', transactionController.getMonthTransactions);
router.post('/', transactionController.createBulkTransactions);
router.delete('/all', transactionController.deleteAllTransactions);
router.put('/update-many', transactionController.updateTransactionsMany);
router.post('/single', transactionController.createTransaction);

module.exports = router;