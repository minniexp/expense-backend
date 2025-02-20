const validateSecretKey = (req, res, next) => {
  // Skip validation for GET requests
  if (req.method === 'GET') {
    return next();
  }

  // Check if secret key matches
  if (process.env.SECRET_KEY !== process.env.CHECK_KEY) {
    return res.status(401).json({ 
      message: 'Unauthorized: Invalid secret key' 
    });
  }

  console.log('Secret key validated');
  next();
};

module.exports = validateSecretKey; 