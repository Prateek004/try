'use strict';

require('dotenv').config();

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const { initDb }         = require('./db/init');
const { setDb }          = require('./db/connection');
const { autoSeedIfEmpty } = require('./db/seed');
const routes             = require('./routes/index');
const { startScheduler } = require('./services/scheduler');

// ── 1. Validate required secrets before anything else ─────────────────────
function validateEnv() {
  const errors = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith('CHANGE_ME')) {
    if (process.env.NODE_ENV === 'production') {
      errors.push('JWT_SECRET is not set. Run: openssl rand -base64 48');
    } else {
      console.warn('[ENV] WARNING: JWT_SECRET not set — using dev fallback');
    }
  }
  if (!process.env.AES_256_KEY || process.env.AES_256_KEY.startsWith('CHANGE_ME')) {
    if (process.env.NODE_ENV === 'production') {
      errors.push('AES_256_KEY is not set. Run: openssl rand -hex 32');
    } else {
      console.warn('[ENV] WARNING: AES_256_KEY not set — using dev fallback (NEVER use in production)');
    }
  }
  if (errors.length) {
    console.error('[FATAL] Missing required environment variables:');
    errors.forEach(e => console.error('  -', e));
    process.exit(1);
  }
}
validateEnv();

// ── 2. Init DB + auto-seed if empty ───────────────────────────────────────
const db = initDb();
setDb(db);
autoSeedIfEmpty(db); // Creates owner account on first deploy if DB is empty

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── 3. Trust Railway's reverse proxy (required for req.ip + rate limiting) ─
app.set('trust proxy', 1);

// ── 4. Security headers ───────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
    },
  },
}));

// ── 5. CORS — permissive: same-origin SPA doesn't need CORS at all ────────
// The frontend is served from the same Railway domain as the API,
// so browser requests have no cross-origin issue.
// CORS headers are only needed if a separate frontend domain is used.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // No origin = same-origin request or server-to-server — always allow
    if (!origin) return cb(null, true);
    // Dev: allow everything
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    // Production: if no ALLOWED_ORIGINS set, allow all (same-domain deploy)
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    // Otherwise check whitelist
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-cron-secret', 'x-webhook-secret'],
}));

// ── 6. Body parsing ───────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ── 7. Request logging ────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── 8. Rate limiting ──────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // Required when behind Railway's proxy — use X-Forwarded-For
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many requests, please try again later' },
}));

app.use('/api/v1/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many login attempts, please try again in 15 minutes' },
}));

// ── 9. API routes ─────────────────────────────────────────────────────────
app.use('/api/v1', routes);

// ── 10. Static frontend ───────────────────────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
}));

// SPA fallback
app.get(/^(?!\/api\/).*$/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── 11. 404 handler ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// ── 12. Global error handler ──────────────────────────────────────────────
app.use((err, req, res, _next) => {
  const isProd = process.env.NODE_ENV === 'production';
  console.error('[ERROR]', err.message, isProd ? '' : err.stack);
  // CORS errors show as 403, not 500
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: isProd ? 'An internal error occurred' : err.message,
  });
});

// ── 13. Cron scheduler ────────────────────────────────────────────────────
if (process.env.DISABLE_SCHEDULER !== 'true') {
  startScheduler();
}

// ── 14. Listen on 0.0.0.0 — required for Railway container networking ─────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] DormBook v2.0 on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  console.log(`[SERVER] DB: ${require('./db/init').DB_PATH}`);
});

module.exports = app;
