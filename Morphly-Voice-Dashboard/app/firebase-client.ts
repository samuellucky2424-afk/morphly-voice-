import { getApp, getApps, initializeApp, type FirebaseOptions } from "firebase/app";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type Auth,
  type Unsubscribe,
  type User,
} from "firebase/auth";

export class FirebaseClientConfigurationError extends Error {
  constructor(message = "Firebase authentication is not configured on this installation.") {
    super(message);
    this.name = "FirebaseClientConfigurationError";
  }
}

function environmentConfig(): FirebaseOptions {
  return {
    apiKey: String(import.meta.env.VITE_FIREBASE_API_KEY || "").trim(),
    authDomain: String(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "").trim(),
    projectId: String(import.meta.env.VITE_FIREBASE_PROJECT_ID || "").trim(),
    appId: String(import.meta.env.VITE_FIREBASE_APP_ID || "").trim(),
    storageBucket: String(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "").trim() || undefined,
    messagingSenderId: String(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "").trim() || undefined,
  };
}

export function getFirebaseConfigurationIssue() {
  const config = environmentConfig();
  const missing = [
    ["VITE_FIREBASE_API_KEY", config.apiKey],
    ["VITE_FIREBASE_AUTH_DOMAIN", config.authDomain],
    ["VITE_FIREBASE_PROJECT_ID", config.projectId],
    ["VITE_FIREBASE_APP_ID", config.appId],
  ].filter(([, value]) => !value).map(([name]) => name);
  return missing.length ? `Missing ${missing.join(", ")}.` : null;
}

export function isFirebaseConfigured() {
  return getFirebaseConfigurationIssue() === null;
}

export function getFirebaseAuth(): Auth {
  const issue = getFirebaseConfigurationIssue();
  if (issue) throw new FirebaseClientConfigurationError(issue);
  const app = getApps().length ? getApp() : initializeApp(environmentConfig());
  return getAuth(app);
}

let preparedAuth: Promise<Auth> | null = null;

export function prepareFirebaseAuth() {
  if (!preparedAuth) {
    preparedAuth = (async () => {
      const auth = getFirebaseAuth();
      await setPersistence(auth, browserLocalPersistence);
      return auth;
    })().catch((error) => {
      preparedAuth = null;
      throw error;
    });
  }
  return preparedAuth;
}

export async function observeFirebaseUser(
  listener: (user: User | null) => void,
  onError?: (error: Error) => void,
): Promise<Unsubscribe> {
  const auth = await prepareFirebaseAuth();
  return onAuthStateChanged(auth, listener, (error) => onError?.(error));
}

export async function signInWithFirebaseEmail(email: string, password: string) {
  const auth = await prepareFirebaseAuth();
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  return credential.user;
}

export async function sendFirebasePasswordResetEmail(email: string) {
  const auth = await prepareFirebaseAuth();
  await sendPasswordResetEmail(auth, email.trim());
}

export async function createFirebaseEmailAccount(email: string, password: string, displayName: string) {
  const auth = await prepareFirebaseAuth();
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const cleanName = displayName.trim();
  if (cleanName) await updateProfile(credential.user, { displayName: cleanName });
  await credential.user.getIdToken(true);
  return credential.user;
}

export async function getFirebaseIdToken(user: User, forceRefresh = false) {
  return user.getIdToken(forceRefresh);
}

export async function signOutFirebase() {
  const auth = await prepareFirebaseAuth();
  await signOut(auth);
}

export function firebaseAuthErrorMessage(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "The email or password is incorrect.";
  }
  if (code.includes("email-already-in-use")) return "An account already exists for this email.";
  if (code.includes("weak-password")) return "Use a stronger password with at least 8 characters.";
  if (code.includes("invalid-email")) return "Enter a valid email address.";
  if (code.includes("too-many-requests")) return "Too many attempts. Please wait a moment and try again.";
  if (code.includes("network-request-failed")) return "Firebase could not be reached. Check your internet connection.";
  return error instanceof Error ? error.message : "Authentication could not be completed.";
}

export type { User as FirebaseUser } from "firebase/auth";
