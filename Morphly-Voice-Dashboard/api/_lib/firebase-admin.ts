import { applicationDefault, cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let adminApp: App | undefined;

function serviceAccount(): { projectId: string; clientEmail: string; privateKey: string } | null {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (encoded) {
    const candidate = encoded.trim();
    const decoded = candidate.startsWith("{")
      ? candidate
      : Buffer.from(candidate, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const projectId = String(parsed.project_id || parsed.projectId || "");
    const clientEmail = String(parsed.client_email || parsed.clientEmail || "");
    const privateKey = String(parsed.private_key || parsed.privateKey || "").replace(/\\n/g, "\n");
    if (projectId && clientEmail && privateKey) return { projectId, clientEmail, privateKey };
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email, or private_key.");
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) return { projectId, clientEmail, privateKey };
  return null;
}

export function getAdminApp(): App {
  if (adminApp) return adminApp;
  const existing = getApps()[0];
  if (existing) {
    adminApp = existing;
    return adminApp;
  }

  const account = serviceAccount();
  adminApp = account
    ? initializeApp({ credential: cert(account), projectId: account.projectId })
    : initializeApp({ credential: applicationDefault() });
  return adminApp;
}

export function adminAuth(): Auth {
  return getAuth(getAdminApp());
}

export function adminDb(): Firestore {
  const databaseId = process.env.FIRESTORE_DATABASE_ID?.trim();
  return databaseId
    ? getFirestore(getAdminApp(), databaseId)
    : getFirestore(getAdminApp());
}
