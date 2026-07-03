require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const receiptRoutes = require('./routes/receipts');
const exportRoutes = require('./routes/export');
const settingsRoutes = require('./routes/settings');
const billingRoutes = require('./routes/billing');
const publicRoutes = require('./routes/public');
const rankedRoutes = require('./routes/ranked');
const authMiddleware = require('./middleware/auth');
const { getConfiguredOriginsForLogs, isOriginAllowed } = require('./services/security');

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

const uploadsDir = path.join(require('os').tmpdir(), 'receiptly-uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const allowedOrigins = getConfiguredOriginsForLogs();

// ── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  cors({
    origin: (origin, cb) => {
      if (isOriginAllowed(origin, req)) {
        return cb(null, true);
      }

      return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  })(req, res, next);
});

// ── Fix Google popup auth ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});

app.use((req, res, next) => {
  if (req.path === '/api/billing/lemonsqueezy/webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// ── Serve static files ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname), { index: false }));

app.get('/', (req, res) => {
  res.redirect('/dashboard.html');
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    port: PORT,
  });
});

// ── API routes ────────────────────────────────────────────────────────────
app.use('/api/public', publicRoutes);
app.use('/api/receipts', authMiddleware, receiptRoutes);
app.use('/api/export', authMiddleware, exportRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/ranked', rankedRoutes);

// ── Catch-all → dashboard ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Max 5MB.' });
  }

  if (err.message && err.message.startsWith('CORS blocked:')) {
    return res.status(403).json({ error: err.message });
  }

  return res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log('\n🧾 Receiptly server started');
    console.log(`   Host: ${HOST}`);
    console.log(`   Port: ${PORT}`);
    console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Health: /health`);
    console.log(`   Dashboard: /dashboard.html`);
    console.log(`   Groq key: ${process.env.GROQ_API_KEY ? '✓ set' : '✗ MISSING'}`);

    if (process.env.NODE_ENV === 'production') {
      if (allowedOrigins.length > 0) {
        console.log(`   Allowed origins: ${allowedOrigins.join(', ')}`);
      } else {
        console.log('   Allowed origins: none configured explicitly; same-origin requests only');
      }
    }

    console.log('');
  });
}

module.exports = app;
