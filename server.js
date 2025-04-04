const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { validateToken, requireAdvancedAccess, validateSecretKey } = require('./middleware/authMiddleware');
require('dotenv').config();

const app = express();

// Get allowed origins from environment variable
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : '*';

console.log('Allowed origins for CORS:', allowedOrigins);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
};

app.use(cors(corsOptions));

app.use(express.json());

// Connect Database
connectDB();

// Root route
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Expense Tracker API</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            text-align: center;
          }
          .status {
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
          }
          .connected {
            background-color: #d4edda;
            color: #155724;
          }
          .endpoints {
            text-align: left;
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
          }
        </style>
      </head>
      <body>
        <h1>Expense Tracker API</h1>
        <div class="status connected">
          <h2>✅ MongoDB Connected</h2>
          <p>Server is running successfully</p>
        </div>
        <div class="endpoints">
          <h3>Available Endpoints:</h3>
          <ul>
            <li>/api/transactions - Transaction management</li>
            <li>/api/teller - Teller integration</li>
            <li>/api/returns - Returns management</li>
            <li>/api/pending-transactions - Pending transactions</li>
          </ul>
        </div>
      </body>
    </html>
  `);
});

// Authentication routes (no token validation)
app.use('/api/users', require('./routes/users'));

// Protected routes - require token validation
app.use('/api/transactions', validateToken, require('./routes/transactions'));
app.use('/api/teller', validateToken, require('./routes/teller'));
app.use('/api/returns', validateToken, require('./routes/returns'));

// Advanced user routes - require token validation and advanced access
app.use('/api/pending-transactions', validateToken, requireAdvancedAccess, require('./routes/pendingTransactions'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));