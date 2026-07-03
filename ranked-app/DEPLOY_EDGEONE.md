# Deploying to EdgeOne Pages (no Railway)

## 0. Repo layout you need
```
your-repo/
├── server.js                 (edited: app.listen only runs locally now)
├── ranked-config.js
├── ranked.html
├── ranked-admin.html
├── dashboard.html            (whatever else your app already serves)
├── routes/
│   ├── ranked.js
│   ├── receipts.js           (edited: temp uploads use os.tmpdir())
│   ├── public.js             (edited: same fix)
│   ├── billing.js
│   ├── export.js
│   └── settings.js
├── services/
│   ├── firebase.js           (NEW - Admin SDK init, provided below)
│   └── ...(your existing db, security, currency, ai, ocr, etc. files)
├── middleware/
│   └── ...(your existing auth.js, rateLimit.js)
├── cloud-functions/
│   ├── package.json          (NEW - {"type":"module"})
│   └── [[default]].js        (NEW - EdgeOne entry point)
└── package.json
```
Only `server.js`, `routes/receipts.js`, `routes/public.js` were edited from what you already had; `services/firebase.js` and everything in `cloud-functions/` is new. Nothing else changed.

## 1. Why the edits were needed
EdgeOne Pages runs your Express app as a **Node Function** — serverless, no persistent server process, no writable local disk outside the OS temp folder. Two things in the original code assumed a normal always-on server:
- `app.listen(...)` ran unconditionally at import time → now wrapped in `if (require.main === module)` so it only binds a port when you run `node server.js` locally; when EdgeOne imports the app it just gets the Express instance.
- File uploads (`multer`, OCR temp files) wrote to `./uploads` next to the code → changed to `os.tmpdir()`, the one directory guaranteed writable in a serverless runtime.

`routes/ranked.js` needed nothing changed — it never touches the filesystem.

## 2. EdgeOne project settings
1. Push this repo to GitHub/GitLab.
2. In the EdgeOne Pages console: **Import a Git Repository** → pick your repo.
3. Framework preset: none/static. **Build command**: leave empty (unless your project has one). **Output directory**: the folder containing your static HTML/JS (repo root, if that's where `ranked.html` etc. live).
4. EdgeOne auto-detects `cloud-functions/` and deploys `[[default]].js` as a catch-all Node Function. Static files in the output directory are served directly at the edge; everything else (`/`, `/health`, `/api/*`) falls through to your Express app.
5. **Environment Variables** (project settings):
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` — see step 4 below
   - `RANKED_ADMIN_EMAILS` — your email(s), comma-separated
   - `NODE_ENV` — `production`
   - `APP_URL` — your EdgeOne domain, e.g. `https://your-project.edgeone.app` (only needed if you're also using the billing routes)
   - Any of `GROQ_API_KEY`, `LEMON_API_KEY`, `LEMON_STORE_ID`, `LEMON_VARIANT_PRO`, `LEMON_VARIANT_UNLIMITED`, `LEMON_WEBHOOK_SECRET` — only if you're deploying the Receiptly receipts/billing routes too. Skip these if you only want Ranked live.
6. Deploy.

## 3. What to give me / what exists already
You don't need to give me anything from Firebase — you paste it directly into your own files (below), so credentials never pass through this chat.

## 4. Firebase setup — exact steps
1. **console.firebase.google.com → Add project** → name it, follow the wizard.
2. **Build → Authentication → Get started** → enable **Email/Password**, and also enable **Google** as a sign-in provider (pick a support email when prompted). No Firebase Storage needed anymore — photos are resized/compressed in the browser and stored as small base64 strings directly in Firestore, so the free Spark plan is enough.
3. **Build → Firestore Database → Create database** → Production mode → pick a region close to your users.
4. **Project settings (gear icon) → General tab → Your apps → Add app → Web (`</>`)** → give it any nickname, skip Firebase Hosting → it shows you a `firebaseConfig` object with `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`. **Paste those 6 values into `ranked-config.js`**, replacing the `YOUR_...` placeholders. (`storageBucket` can stay as-is even though you're not using Storage — it's harmless.)
5. **Project settings → Service accounts tab → Generate new private key** → downloads a JSON file. This is the **Admin SDK** credential the backend uses — never put this in `ranked-config.js` or any client file. Instead:
   ```
   base64 -w0 path/to/serviceAccountKey.json
   ```
   (on Mac: `base64 -i path/to/serviceAccountKey.json | tr -d '\n'`) and paste the output as the `FIREBASE_SERVICE_ACCOUNT_BASE64` environment variable in EdgeOne's dashboard.
6. **Firestore → Rules tab** → paste in the contents of `firestore.rules` (denies all direct client access, since only your server touches Firestore) → Publish.
7. For Google popup sign-in to work on your deployed domain, add your EdgeOne domain (and `localhost` for local testing) under **Authentication → Settings → Authorized domains**.
8. The first time each Firestore query in `routes/ranked.js` actually runs in production, Firestore will reject it with an error containing a direct "create this index" link (compound queries need composite indexes: `candidates` by status+score, `nominations` by status+createdAt, `votes` by voterUid+institutionId, etc.). Click each link once — takes a few minutes per index to build, then it works permanently.

Firebase Storage is not used at all — `storage.rules` from the earlier round of files is no longer needed, skip it.

## 5. Testing locally before you deploy
```
npm install
node server.js
```
Visit `http://localhost:8080/ranked.html` — with a real Firebase config pasted in, it talks to your real project; with the placeholder config still in `ranked-config.js`, it runs in the built-in browser-localStorage demo mode instead, so you can click around without touching Firebase at all.

## 6. Known limitations, unchanged from before
- Nominee confirmation is "whoever has the link can confirm," not email-verified — no email service is wired in.
- Rate limiting (`middleware/rateLimit`) is in-memory, so it resets on cold starts and isn't shared across concurrent function instances — fine for an MVP's abuse protection, not bulletproof at scale.
- K-12 institutions are blocked server-side by type + name pattern in `routes/ranked.js` — this can't be bypassed from the browser regardless of what UI changes you make later.
