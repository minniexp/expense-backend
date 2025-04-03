const express = require('express');
const passport = require('passport');
const router = express.Router();

// Initiate Google OAuth
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

// Handle callback from Google
router.get('/google/callback', passport.authenticate('google', {
  failureRedirect: '/auth/failure',
  successRedirect: '/auth/success'
}));

// Success and failure routes
router.get('/success', (req, res) => {
  res.redirect('/app/user/page.js'); // Redirect to user page on success
});

router.get('/failure', (req, res) => {
  res.redirect('/'); // Redirect to home page on failure
});

module.exports = router; 