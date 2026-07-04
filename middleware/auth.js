const admin = require('../services/firebase');

module.exports = async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.user = { uid: decoded.uid, email: decoded.email || '' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
