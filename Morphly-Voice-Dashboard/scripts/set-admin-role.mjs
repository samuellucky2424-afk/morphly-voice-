import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const email = String(process.argv[2] || process.env.MORPHLY_ADMIN_EMAIL || "").trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/set-admin-role.mjs admin@example.com");
  process.exit(2);
}

function serviceAccount() {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (encoded) {
    const candidate = encoded.trim();
    const decoded = candidate.startsWith("{") ? candidate : Buffer.from(candidate, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return {
      projectId: parsed.project_id || parsed.projectId,
      clientEmail: parsed.client_email || parsed.clientEmail,
      privateKey: String(parsed.private_key || parsed.privateKey || "").replace(/\\n/g, "\n"),
    };
  }
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };
  }
  return null;
}

const account = serviceAccount();
const app = getApps()[0] || initializeApp(account
  ? { credential: cert(account), projectId: account.projectId }
  : { credential: applicationDefault() });
const auth = getAuth(app);
const database = getFirestore(app);

try {
  const user = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(user.uid, {
    ...(user.customClaims || {}),
    admin: true,
    role: "admin",
  });
  const profileReference = database.collection("users").doc(user.uid);
  const profileSnapshot = await profileReference.get();
  await profileReference.set({
    uid: user.uid,
    email: user.email || email,
    emailLower: email,
    displayName: user.displayName || email.split("@")[0],
    role: "admin",
    status: "active",
    updatedAt: FieldValue.serverTimestamp(),
    ...(!profileSnapshot.exists ? { createdAt: FieldValue.serverTimestamp(), credits: 0 } : {}),
  }, { merge: true });
  await auth.revokeRefreshTokens(user.uid);
  console.log(`Admin role granted to Firebase user ${user.uid}. Sign in again to refresh the ID token.`);
} catch (error) {
  console.error("Could not grant the Morphly admin role:", error instanceof Error ? error.message : error);
  process.exit(1);
}
