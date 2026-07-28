const express = require('express');
const router = express.Router();
const ingestController = require('../controllers/ingestController');

// Create-only. Deliberately no GET, PUT or DELETE — the credential that reaches this route
// lives on a phone, so it must not be able to read or destroy anything.
router.post('/transaction', ingestController.ingestTransactions);

module.exports = router;
