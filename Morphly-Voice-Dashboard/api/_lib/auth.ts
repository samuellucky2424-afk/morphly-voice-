import type { DecodedIdToken } from "firebase-admin/auth";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "./firebase-admin.js";
import { HttpError, type ApiRequest, headerValue } from "./http.js";

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "suspended";

export type AuthenticatedUser = {
  uid: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  credits: number;
  token: DecodedIdToken;
  profile: DocumentData;
};

function bearerToken(request: ApiRequest): string {
  const authorization = headerValue(request.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    throw new HttpError(401, "authentication_required", "A Firebase ID token is required.");
  }
  return match[1].trim();
}

function tokenHasAdminClaim(token: DecodedIdToken): boolean {
  return token.admin === true || token.role === "admin";
}

function signupCredits(): number {
  const parsed = Number(process.env.MORPHLY_SIGNUP_CREDITS || "0");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function ensureUserProfile(token: DecodedIdToken): Promise<DocumentData> {
  const database = adminDb();
  const reference = database.collection("users").doc(token.uid);
  const claimAdmin = tokenHasAdminClaim(token);
  const now = FieldValue.serverTimestamp();

  return database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const existing = snapshot.exists ? snapshot.data() || {} : {};
    const existingRole = existing.role === "admin" ? "admin" : "user";
    const role: UserRole = claimAdmin || existingRole === "admin" ? "admin" : "user";
    const status: UserStatus = existing.status === "suspended" ? "suspended" : "active";
    const credits = Number.isSafeInteger(existing.credits) && existing.credits >= 0
      ? existing.credits
      : signupCredits();
    const displayName = String(existing.displayName || token.name || token.email?.split("@")[0] || "Morphly user");

    const profile = {
      ...existing,
      uid: token.uid,
      email: token.email || existing.email || null,
      emailLower: String(token.email || existing.email || "").toLowerCase(),
      displayName,
      photoURL: token.picture || existing.photoURL || null,
      role,
      status,
      credits,
      updatedAt: now,
      lastSeenAt: now,
      ...(!snapshot.exists ? { createdAt: now } : {}),
    };

    transaction.set(reference, profile, { merge: true });
    return profile;
  });
}

export async function authenticate(request: ApiRequest): Promise<AuthenticatedUser> {
  let token: DecodedIdToken;
  try {
    token = await adminAuth().verifyIdToken(bearerToken(request), true);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "invalid_token", "The Firebase session is invalid or expired.");
  }

  const profile = await ensureUserProfile(token);
  const status: UserStatus = profile.status === "suspended" ? "suspended" : "active";
  if (status === "suspended") {
    throw new HttpError(403, "account_suspended", "This Morphly account has been suspended.");
  }

  const role: UserRole =
    tokenHasAdminClaim(token) || profile.role === "admin"
      ? "admin"
      : "user";

  return {
    uid: token.uid,
    email: token.email || null,
    displayName: String(profile.displayName || token.name || token.email || "Morphly user"),
    role,
    status,
    credits: Number.isSafeInteger(profile.credits) ? profile.credits : 0,
    token,
    profile,
  };
}

export async function requireAdmin(request: ApiRequest): Promise<AuthenticatedUser> {
  const user = await authenticate(request);
  if (user.role !== "admin") {
    throw new HttpError(403, "admin_required", "Administrator access is required.");
  }
  return user;
}

export function publicSessionUser(user: AuthenticatedUser): Record<string, unknown> {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoUrl: user.profile.photoURL || null,
    photoURL: user.profile.photoURL || null,
    role: user.role,
    status: user.status,
    credits: user.credits,
    plan: user.profile.plan || "free",
    createdAt: serializedTimestamp(user.profile.createdAt),
    lastSeenAt: serializedTimestamp(user.profile.lastSeenAt),
  };
}

function serializedTimestamp(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("toDate" in value)) return null;
  const toDate = (value as { toDate?: () => Date }).toDate;
  return typeof toDate === "function" ? toDate.call(value).toISOString() : null;
}
