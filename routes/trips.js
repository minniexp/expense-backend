const express = require('express');
const router = express.Router();
const c = require('../controllers/tripController');

// Reusable member roster
router.get('/members', c.listMembers);
router.post('/members', c.createMember);
router.put('/members/:id', c.updateMember);
router.delete('/members/:id', c.deleteMember);

// Trips
router.get('/', c.listTrips);
router.post('/', c.createTrip);
router.put('/:id', c.updateTrip);
router.delete('/:id', c.deleteTrip);

// Everything a trip page needs, in one request: totals, balances, who-pays-whom,
// expenses and settlements. Computed fresh — never cached.
router.get('/:tripId/summary', c.getTripSummary);

// Expenses
router.get('/:tripId/expenses', c.listExpenses);
router.post('/:tripId/expenses', c.createExpense);
router.put('/:tripId/expenses/:expenseId', c.updateExpense);
router.delete('/:tripId/expenses/:expenseId', c.deleteExpense);

// Settlements (partial payments are normal, so these are just amounts)
router.get('/:tripId/settlements', c.listSettlements);
router.post('/:tripId/settlements', c.createSettlement);
router.delete('/:tripId/settlements/:settlementId', c.deleteSettlement);

module.exports = router;
