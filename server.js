const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
require('dotenv').config();

const app = express();

// Parse FRONTEND_URL into array of allowed origins
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000'  // Keep localhost for development
];

// Updated CORS configuration
const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
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

// Routes
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/teller', require('./routes/teller'));
app.use('/api/users', require('./routes/users'));
app.use('/api/returns', require('./routes/returns'));
app.use('/api/pending-transactions', require('./routes/pendingTransactions'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));