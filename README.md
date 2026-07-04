# Ranked — clean standalone repo

This replaces everything in your `Sujosh-Jana/MOGG` repo. Your repo was
carrying dead weight from an unrelated app ("Receiptly") that `server.js`
tried to import but that never existed in this repo — that's the actual
reason nothing deployed, independent of the package.json issue.

## What changed from before
- `server.js` — rewritten from scratch, only wires up the Ranked API,
  static files, health check. No more billing/receipts/export/settings routes.
- `middleware/auth.js` — NEW. Verifies a Firebase ID token, sets `req.user`.
- `middleware/rateLimit.js` — NEW. Simple in-memory limiter.
- `package.json` — trimmed to only what this app actually uses
  (express, cors, dotenv, firebase-admin, uuid).
- Dropped `routes/receipts.js` and `routes/public.js` entirely — they
  belonged to the other app and needed six more service files that don't
  exist here.

Nothing in `routes/ranked.js`, `ranked.html`, `ranked-admin.html`,
`ranked-config.js`, `services/firebase.js`, or `firestore.rules` changed —
those were already correct.

## How to actually get this onto GitHub without another nesting mistake
1. Go to `github.com/Sujosh-Jana/MOGG`.
2. Delete every file and folder currently in the repo (select each, delete,
   commit). You want a completely empty repo before the next step.
3. Extract this zip on your computer. You'll get a folder containing
   `server.js`, `package.json`, `ranked.html`, etc. directly inside it —
   **do not** drag that outer folder into GitHub. Open it, select
   **everything inside it** (all files + the `routes`/`services`/
   `middleware`/`cloud-functions` folders), and drag *those* onto GitHub's
   "Add file → Upload files" page. This keeps them at the repo root instead
   of nested one level down again.
4. Commit directly to `main`.
5. In EdgeOne project settings, set **Root directory** back to `./` (since
   everything is at repo root now, not in `ranked-app/`). Output directory
   `./` as well.
6. Confirm env vars are still set: `FIREBASE_SERVICE_ACCOUNT_BASE64`,
   `RANKED_ADMIN_EMAILS`.
7. Redeploy.

## If it still fails
Paste me the new Build Logs. At this point every `require()` in the code
resolves to a real file and `package.json` lists every dependency actually
used — if it still fails, the log will tell us something new (e.g. a Node
version mismatch, or the deploy platform's own quirk), not a repeat of the
last two errors.
