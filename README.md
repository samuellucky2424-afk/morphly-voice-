# Morphly Voice

Morphly Voice is a Windows real-time voice-changing application with one shared dashboard for the RVC and Beatrice V2 engines. The dashboard includes Firebase Authentication, server-verified administrator access, user and credit management, live operational telemetry, notifications, customer-care settings, purchase history, software logs, and Flutterwave payment integration through a Vercel serverless API.

## Repository layout

- `Morphly-Voice-Dashboard/` — React/Vite dashboard and Vercel API functions.
- `server/` — RVC voice engine derived from the upstream w-okada voice changer.
- `morphly_supervisor.py` — local dashboard gateway and engine-mode supervisor.
- `start_http.bat` — starts the local dashboard on `http://localhost:18000`.
- `start_engine_mode.bat` — starts either the RVC or Beatrice V2 engine.

Large model files, Python environments, Beatrice binaries, runtime logs, credentials, and local environment files are intentionally not stored in Git.

## Dashboard development

```powershell
cd Morphly-Voice-Dashboard
npm ci
npm run typecheck:static
npm run typecheck:api
npm run build:static
```

Copy `.env.example` to `.env.local` and configure the public Firebase values and deployed Vercel API URL. See [ADMIN_SETUP.md](Morphly-Voice-Dashboard/ADMIN_SETUP.md) for Firebase, Vercel, Flutterwave, Firestore, and administrator setup.

## Vercel deployment

Create the Vercel project with `Morphly-Voice-Dashboard` as its Root Directory. The included `vercel.json` builds `dist-static` and deploys the serverless API under `/api`.

Server-only Firebase Admin and Flutterwave values must be configured in Vercel Project Settings. Never commit `.env.local` or a Firebase service-account JSON key.

## Local Windows launch

The local application expects:

- `.venv\Scripts\python.exe`
- the built dashboard at `Morphly-Voice-Dashboard\dist-static`
- RVC dependencies and models under the ignored local runtime directories
- optional Beatrice V2 binaries under `engines\beatrice-v2`

Then run:

```powershell
.\start_http.bat
```

The RVC engine is the default. The dashboard can switch between RVC and Beatrice without changing the public port.

## Upstream attribution

The RVC engine is based on the [w-okada voice-changer](https://github.com/w-okada/voice-changer) project. Retain and follow the upstream licenses for the engine and bundled components.
