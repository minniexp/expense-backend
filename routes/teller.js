const express = require('express');
const router = express.Router();
const tellerController = require('../controllers/tellerController');

router.post('/enrollment', tellerController.handleAccessToken);
router.get('/transactions', tellerController.getTellerTransactions);

module.exports = router;