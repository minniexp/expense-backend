const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// Route to create a user
router.post('/', userController.createUser);

// Route to fetch user by email (for authentication)
router.post('/fetch-by-email', userController.fetchUserByEmail);

// Route to verify token
router.post('/verify-token', userController.verifyToken);

module.exports = router; 