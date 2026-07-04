// Simple in-memory rate limiter. Resets on cold start / restart and isn't
// shared across concurrent serverless instances - fine for an MVP's abuse
// protection, not bulletproof at scale. Swap for a Redis/Firestore-backed
// limiter later if you need it to hold up under real load.
function createRateLimiter({ name, windowMs, max, keyGenerator }) {
  const hits = new Map();

  return function rateLimiter(req, res, next) {
    const key = keyGenerator ? keyGenerator(req) : (req.ip || 'anonymous');
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: `Too many requests${name ? ` for ${name}` : ''}. Try again in a bit.`,
      });
    }

    return next();
  };
}

module.exports = { createRateLimiter };
