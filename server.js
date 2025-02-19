const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
require('dotenv').config();

const app = express();
FRONTEND_URL='http://localhost:3000'
// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL, // Your frontend URL
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Connect Database
connectDB();

// Routes
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/teller', require('./routes/teller'));
app.use('/api/users', require('./routes/users'));
app.use('/api/returns', require('./routes/returns'));
app.use('/api/pending-transactions', require('./routes/pendingTransactions'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));