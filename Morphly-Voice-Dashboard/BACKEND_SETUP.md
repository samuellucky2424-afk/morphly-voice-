# Morphly cloud API setup

The local Morphly gateway reserves `/api/*` for the voice engine. The dashboard must call the
absolute Vercel URL configured in `VITE_MORPHLY_API_URL`; do not send cloud requests to
`http://localhost:18000/api`.

## Required packages

`firebase-admin` is included as a production dependency. The browser dashboard uses the separate
`firebase` client package. The API intentionally uses Node's built-in request types,
so `@vercel/node` is not required.

## Configuration

Copy the names from `.env.example` into Vercel Project Settings. Values beginning with `VITE_`
are public client configuration. Firebase Admin credentials, Flutterwave keys, admin allowlists,
and webhook hashes must never use the `VITE_` prefix.

The preferred production admin bootstrap is a Firebase custom claim:

```powershell
$env:FIREBASE_PROJECT_ID="your-project-id"
$env:FIREBASE_CLIENT_EMAIL="firebase-adminsdk@example.iam.gserviceaccount.com"
$env:FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
node scripts/set-admin-role.mjs admin@example.com
```

The script takes an existing Firebase Auth email, preserves existing claims, sets
`admin: true` and `role: admin`, updates the matching Firestore profile, and revokes refresh
tokens so the administrator signs in again. It never accepts or stores a password.

Deploy `firestore.rules` and `firestore.indexes.json` with the Firebase CLI or Console before
using filtered admin reports. Firebase Admin SDK bypasses rules; browser clients cannot mutate
credits, roles, status, payments, notifications, or audit records.

## Authentication and authorization

Authenticated requests send `Authorization: Bearer <Firebase ID token>`. Every admin handler
verifies the token, checks revocation and suspension, then requires an admin custom claim or
trusted Firestore role. An email address alone never grants administrator access.

Credit adjustments require an `Idempotency-Key` header or `idempotencyKey` body field. The API
uses a Firestore transaction to update the balance and atomically create ledger, idempotency,
and audit documents. Suspension disables the Firebase Auth user and revokes refresh tokens.

## API routes

- `POST /api/auth/session` and `GET /api/user/bootstrap`
- `GET /api/support`
- `POST /api/telemetry/heartbeat`
- `POST /api/telemetry/event` (`/events` is an alias)
- `GET /api/admin/overview`
- `GET /api/admin/users`
- `POST /api/admin/credits` or `/api/admin/users/:uid/credits`
- `PATCH /api/admin/users` or `/api/admin/users/:uid/suspension`
- `GET /api/admin/live` (`/live-sessions` is an alias)
- `GET /api/admin/purchases`
- `GET /api/admin/logs`
- `GET, POST /api/admin/notifications`
- `GET, PUT /api/admin/support`
- `POST /api/payments/initialize`
- `POST /api/webhooks/flutterwave`

Flutterwave package prices are selected server-side. The webhook verifies its secret hash and
then verifies the transaction through Flutterwave's API before crediting. Transaction references
and the `credited` flag make webhook retries idempotent.

The local client should send a heartbeat approximately every 30 seconds. Only operational
metadata is accepted; microphone audio is never uploaded. The admin live view considers a user
online when a heartbeat arrived in the configured 30-300 second window.
