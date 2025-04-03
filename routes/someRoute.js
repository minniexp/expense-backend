const express = require('express');
const { ensureAuthenticated, ensureAdvanced } = require('../middleware/authMiddleware');
const router = express.Router();

router.get('/some-protected-route', ensureAuthenticated, (req, res) => {
  // Route logic here
});

router.get('/advanced-route', ensureAdvanced, (req, res) => {
  // Route logic here
});

module.exports = router; 