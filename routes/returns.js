const express = require('express');
const router = express.Router();
const returnController = require('../controllers/returnController');

// Create a new return
router.post('/', returnController.createReturn);

// Get all returns
router.get('/', returnController.getAllReturns);

// Update a return by id
router.put('/:id', returnController.updateReturn);

// Delete a return by id
router.delete('/:id', returnController.deleteReturn);

// Get a return by id
router.get('/:id', returnController.getReturnById);

// Add this route to your existing returns routes
router.post('/migrate-transaction-ids', returnController.migrateReturnTransactionIds);

module.exports = router; 