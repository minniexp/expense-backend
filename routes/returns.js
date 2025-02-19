const express = require('express');
const router = express.Router();
const returnController = require('../controllers/returnController');

router.post('/', returnController.createReturn);

module.exports = router; 