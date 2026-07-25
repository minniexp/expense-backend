const express = require('express');
const router = express.Router();
const tellerController = require('../controllers/tellerController');
const ignoredTransactionsController = require('../controllers/ignoredTransactionsController');

router.get('/enrollment-config', tellerController.getEnrollmentToken);
router.post('/enrollment', tellerController.handleAccessToken);
router.get('/transactions', tellerController.getTellerTransactions);

// Dismissed transactions — reviewed, deliberately not logged, filtered out of future fetches.
// Reversible: DELETE puts them straight back in the review queue.
router.get('/ignored', ignoredTransactionsController.listIgnoredTransactions);
router.post('/ignored', ignoredTransactionsController.ignoreTransactions);
router.delete('/ignored', ignoredTransactionsController.restoreIgnoredTransactions);
// Same handler over POST: DELETE-with-a-body is legal but some proxies and CDNs strip the
// body, which would silently turn "restore these three" into a no-op in production only.
router.post('/ignored/restore', ignoredTransactionsController.restoreIgnoredTransactions);

module.exports = router;
