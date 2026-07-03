# Ranked — setup notes

## 1. Firebase config
Paste real values into `ranked-config.js` (used by both `ranked.html` and `ranked-admin.html`). Once `apiKey` is no longer `"YOUR_API_KEY"`, both pages switch from local demo mode to the real backend automatically.

Enable in Firebase console: Email/Password auth, Firestore, Storage.

## 2. Deploy security rules
```
firebase deploy --only firestore:rules,storage:rules
```
`firestore.rules` denies all direct client access — every read/write goes through `routes/ranked.js` via the Admin SDK. `storage.rules` allows authenticated photo uploads to `nominations/` and `candidates/` only, 5MB cap, images only.

## 3. Admin access
Set `RANKED_ADMIN_EMAILS` (comma-separated) as an env var on the server. Anyone logging into `/ranked-admin.html` with one of those emails is auto-flagged admin on first login. You can also flip `isAdmin: true` by hand on a `users/{uid}` doc.

## 4. Firestore composite indexes
The first time each of these queries runs in production, Firestore will throw an error with a direct link to auto-create the needed index. Expect prompts for:
- `candidates`: `status` + `score` (and `status` + `institutionId` + `score`, `status` + `institutionId` + `gender` + `score`)
- `candidates`: `status` + `createdAt` (admin list)
- `nominations`: `status` + `createdAt`
- `nominations`: `institutionId` + `candidateNameNormalized` + `status` (duplicate check)
- `votes`: `voterUid` + `institutionId`

Just click each link the first time it errors, or pre-create them in the Firebase console under Firestore → Indexes.

## 5. Still open (not built)
- **Email/OTP confirmation**: nominees currently confirm by clicking their private link and logging into any account. There's no email delivery service wired up, so it's still "whoever has the link can confirm." Adding real email confirmation needs an email provider (Resend/SendGrid/etc.) and API key — say the word and I'll wire it in.
- **Rate limiting is in-memory** (`middleware/rateLimit`), so it resets on server restart and won't be shared across multiple server instances if you ever scale horizontally.
- **Candidate profile pages, share cards, analytics, custom domain/landing copy** — not built, lower priority than the trust/security work above.

## 6. Hard rule already enforced server-side
`routes/ranked.js` blocks K-12 institutions by type (`college`/`company` only) and by name pattern (`SCHOOL_BLOCKLIST`) on every institution create/edit and on every nomination confirm — this check lives in the backend, not just the UI, so it can't be bypassed from the browser.
