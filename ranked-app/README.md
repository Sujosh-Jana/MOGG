# What's in this zip

This contains only the files I created or edited. Your existing repo already has
other files (routes/billing.js, routes/export.js, routes/settings.js,
middleware/auth.js, middleware/rateLimit.js, services/db.js, services/security.js,
services/currency.js, services/ai.js, services/ocr.js, services/plans.js,
services/deductibility.js, services/pricing.js, services/http.js,
services/billing.js, dashboard.html, package.json, etc.) — copy these files
into your repo at the matching paths, overwriting the old versions of
server.js, routes/receipts.js, routes/public.js, ranked.html, and
ranked-admin.html.

## File map
```
ranked.html              → repo root (public leaderboard site)
ranked-admin.html        → repo root (admin console)
ranked-config.js         → repo root (your real Firebase web config, already filled in)
server.js                → repo root (OVERWRITE - now edge/serverless-safe)
firestore.rules          → repo root (paste into Firebase console → Firestore → Rules)
routes/ranked.js         → routes/ranked.js (the backend API for Ranked)
routes/receipts.js       → routes/receipts.js (OVERWRITE - temp files now use os.tmpdir())
routes/public.js         → routes/public.js (OVERWRITE - same fix)
services/firebase.js     → services/firebase.js (NEW - Firebase Admin SDK init)
cloud-functions/         → cloud-functions/ (NEW - EdgeOne Pages entry point)
DEPLOY_EDGEONE.md        → deployment walkthrough, read this first
RANKED_SETUP_NOTES.md    → earlier notes, mostly superseded by DEPLOY_EDGEONE.md
```

## Before you deploy
1. Set env var `FIREBASE_SERVICE_ACCOUNT_BASE64` in EdgeOne (value given to you in chat).
2. Set env var `RANKED_ADMIN_EMAILS` to your email.
3. In Firebase console: enable Email/Password + Google under Authentication,
   create Firestore (production mode), paste `firestore.rules` into the Rules tab,
   add your EdgeOne domain + `localhost` under Authentication → Authorized domains.
4. Rotate the service account key you pasted in chat once things are working —
   treat it as already compromised since it went through a chat transcript.
