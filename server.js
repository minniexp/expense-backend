const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { validateToken, requireAdvancedAccess, requireInternalSecret } = require('./middleware/authMiddleware');
const { tellerRateLimit } = require('./middleware/rateLimit');
require('dotenv').config();

const app = express();

/**
 * CORS.
 *
 * Origins come from ALLOWED_ORIGINS (comma-separated) so a new deployment URL does not need a
 * code change; the hard-coded list below is the fallback.
 *
 * Note what is deliberately NOT here: `X-Internal-Secret` is absent from allowedHeaders. That
 * header only ever travels server-to-server from our Next.js app, where CORS does not apply.
 * Advertising it to browsers would invite it to be sent from one, which is exactly what the
 * header exists to prevent.
 */
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const productionOrigins = configuredOrigins.length > 0 ? configuredOrigins : [
  'https://expense-frontend-eosin.vercel.app',
  'https://expense-frontend-mins-projects-b691d852.vercel.app'
];

const developmentOrigins = [
  ...productionOrigins,
  'http://localhost:3000',
  'http://localhost:3001'
];

const allowedOrigins = process.env.NODE_ENV === 'production'
  ? productionOrigins
  : developmentOrigins;

const corsOptions = {
  origin(origin, callback) {
    // No Origin header means a non-browser caller (our Next.js server, curl, health checks).
    // CORS is a browser-enforced policy and is not an authentication control — those requests
    // are still gated by requireInternalSecret / validateToken further down the stack.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn(`[cors] blocked origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept'
  ],
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// Bound the request body. Without this an unauthenticated caller can stream an arbitrarily
// large payload and have it buffered before any auth middleware runs.
app.use(express.json({ limit: '1mb' }));

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

// Authentication routes. NOT public: every route inside applies requireInternalSecret, so
// only our own Next.js server can mint or verify session tokens.
app.use('/api/users', require('./routes/users'));

// Protected routes - require token validation
app.use('/api/transactions', validateToken, require('./routes/transactions'));

// Teller is the most sensitive surface in the app: it reaches live bank data.
// It requires BOTH controls, and they are independent:
//   - requireInternalSecret : only our Next.js server can call it, so a session token stolen
//                             from a browser is not by itself enough to read bank data.
//   - validateToken         : and that server must still present a real, unexpired session.
// Plus a rate limit, so even a fully authorised caller cannot hammer Teller.
//   - requireAdvancedAccess : and be an 'advanced' user. Without this, ANY approved account —
//                             including 'simple' ones — could read live bank data through the
//                             API. The Next.js middleware restricts the /teller *page* to
//                             advanced users, but that is a UI control and does not protect
//                             the endpoint.
app.use(
  '/api/teller',
  requireInternalSecret,
  validateToken,
  requireAdvancedAccess,
  tellerRateLimit,
  require('./routes/teller')
);

app.use('/api/returns', validateToken, require('./routes/returns'));

// Advanced user routes - require token validation and advanced access
app.use('/api/pending-transactions', validateToken, requireAdvancedAccess, require('./routes/pendingTransactions'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));