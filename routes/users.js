const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { requireInternalSecret } = require('../middleware/authMiddleware');

/**
 * SECURITY: every route in this file is reachable only by our own Next.js server.
 *
 * `/fetch-by-email` mints session tokens. It previously sat on the open internet with no
 * middleware at all, and would hand a 180-day full-access JWT to anyone who posted an approved
 * email address — email addresses are not secrets, so that was a complete authentication
 * bypass into the bank transaction API.
 *
 * It is now behind two independent controls: the internal secret below, and Google ID token
 * verification inside the controller. Do not mount anything here without
 * `requireInternalSecret`.
 */

// Creating users is an administrative action, not a public one.
router.post('/', requireInternalSecret, userController.createUser);

// Exchanges a Google-verified identity for one of our session tokens.
router.post('/fetch-by-email', requireInternalSecret, userController.fetchUserByEmail);

// Used by the Next.js middleware to validate a session when guarding protected routes.
router.post('/verify-token', requireInternalSecret, userController.verifyToken);

module.exports = router;
