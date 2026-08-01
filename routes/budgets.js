const express = require('express');
const router = express.Router();
const c = require('../controllers/budgetController');

// Declared before the bare routes so "summary" is never read as anything else.
router.get('/summary', c.getSummary);
router.get('/', c.getBudgets);
router.put('/', c.putBudgets);

module.exports = router;
