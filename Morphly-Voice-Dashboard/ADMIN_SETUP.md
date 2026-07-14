# Morphly Firebase, Vercel, Flutterwave, and Admin Setup

The desktop dashboard uses Firebase Authentication in the browser and sends the Firebase ID token to the Vercel API. The API verifies the token with Firebase Admin before returning a role or performing any privileged action. The local voice engine remains on `localhost:18000`; cloud requests must use the full Vercel URL because local `/api/*` requests belong to the voice engine gateway.

## 1. Configure Firebase

1. Enable **Email/Password** in Firebase Authentication.
2. Create a Firestore database.
3. Create a Firebase service account for the Vercel API.
4. Copy `.env.example` to `.env.local` for local builds and fill in the browser-safe `VITE_FIREBASE_*` values plus `VITE_MORPHLY_API_URL`.
5. Add the server-only `FIREBASE_*` values to the Vercel project. Never expose the private key through a `VITE_*` variable.
6. Deploy the included rules and indexes:

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   ```

## 2. Configure Vercel and Flutterwave

Use `Morphly-Voice-Dashboard` as the Vercel project root. Add all server variables from `.env.example`, including:

- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`
- `FLUTTERWAVE_PUBLIC_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, and `FLUTTERWAVE_REDIRECT_URL`
- `APP_ALLOWED_ORIGINS` for any hosted dashboard origin

Add the browser-safe Firebase values at build time, including
`VITE_FIREBASE_VAPID_KEY` when web push is enabled. Generate the VAPID key pair
in Firebase Console under **Project settings → Cloud Messaging → Web Push certificates**.

Set the Flutterwave webhook URL to:

```text
https://YOUR-VERCEL-DOMAIN/api/webhooks/flutterwave
```

Credits are awarded only after the transaction is re-verified server-side with Flutterwave. The signed webhook and the authenticated Inline callback share the same idempotent fulfillment transaction, so duplicate callbacks cannot add credits twice.

## 3. Grant an administrator role

First create the administrator through Firebase Authentication. For local administration, point `GOOGLE_APPLICATION_CREDENTIALS` at a Firebase service-account JSON key (or place the documented `FIREBASE_*` values in `.env.local`). Then run this command from the repository root:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="D:\secure\morphly-firebase-admin.json"
npm run admin:grant -- admin@example.com
```

The root command automatically reads `Morphly-Voice-Dashboard/.env.local` when that file exists. The script sets the Firebase custom claims and the matching Firestore profile. It never stores or accepts the administrator password. Sign out and back in afterward so Firebase issues a fresh ID token.

## 4. Build the local dashboard

The Firebase and Vercel browser variables are embedded when Vite builds the dashboard:

```bash
npm run typecheck:static
npm run build:static
```

Then start the application from the repository root with `start_http.bat`. A verified `admin` role opens the Admin Console; a normal account opens the voice workspace. Firebase sign-in or account creation is mandatory; the local-mode bypass has been removed. If the cloud configuration is missing, the application stays on the sign-in screen and reports the missing values.

## Data and privacy

The admin console stores operational metadata such as engine mode, model name, session duration, latency, errors, and last heartbeat. It does not transmit or store microphone audio. Session-history queries are always scoped by the Firebase UID verified by the API; the browser does not share or migrate legacy global history between accounts.

Primary Firestore collections are `users`, `presence`, `sessions`, `payments`, `credit_ledger`, `notifications`, `app_config`, `software_logs`, and `audit_logs`.
