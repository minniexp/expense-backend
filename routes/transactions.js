const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { requireAdvancedAccess } = require('../middleware/authMiddleware');

router.get('/', transactionController.getTransactions);
router.get('/:year/:month', transactionController.getMonthTransactions);
router.post('/', transactionController.createBulkTransactions);
router.delete('/all', transactionController.deleteAllTransactions);
// Destructive and irreversible, so it asks for more than the rest of this router: the mount already
// requires the internal secret and a valid session, and this adds the advanced role on top. Posting
// rather than DELETE because the ids travel in a body.
router.post('/delete', requireAdvancedAccess, transactionController.deleteTransactions);
router.put('/update-many', transactionController.updateTransactionsMany);
router.post('/single', transactionController.createTransaction);
// Hand-typed rows, through the same builder the alerts use. See the note on createManualTransaction
// for why this exists alongside /single rather than replacing it.
router.post('/manual', transactionController.createManualTransaction);
router.post('/by-ids', transactionController.getTransactionsByIds);

module.exports = router;