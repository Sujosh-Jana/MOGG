require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const rankedRoutes = require('./routes/ranked');

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

// ── CORS ──────────────────────────────────────────────────────────────────
// Wide open by default since this is a public voting site with its own
// per-route auth. Tighten via ALLOWED_ORIGIN if you want to lock it to your
// own domain only.
const allowedOrigin = process.env.ALLOWED_ORIGIN || null;
app.use(cors({
  origin: allowedOrigin || true,
  credentials: true,
}));

// ── Fix Google popup auth ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Serve static files (ranked.html, ranked-admin.html, ranked-config.js) ──
app.use(express.static(path.join(__dirname), { index: false }));

app.get('/', (req, res) => {
  res.redirect('/ranked.html');
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// ── API routes ────────────────────────────────────────────────────────────
app.use('/api/ranked', rankedRoutes);

// ── Catch-all → public leaderboard page ───────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'ranked.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);

  if (err.message && err.message.startsWith('CORS blocked:')) {
    return res.status(403).json({ error: err.message });
  }

  return res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log('\n🏆 Ranked server started');
    console.log(`   Host: ${HOST}`);
    console.log(`   Port: ${PORT}`);
    console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Health: /health`);
    console.log(`   Public site: /ranked.html`);
    console.log(`   Admin console: /ranked-admin.html`);
    console.log(`   Firebase Admin: ${process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT ? '✓ configured' : '✗ MISSING'}`);
    console.log('');
  });
}

module.exports = app;
