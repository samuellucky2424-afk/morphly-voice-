import { createHash } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

export const collections = {
  users: "users",
  presence: "presence",
  sessions: "sessions",
  logs: "software_logs",
  audit: "audit_logs",
  notifications: "notifications",
  payments: "payments",
  ledger: "credit_ledger",
  operations: "idempotency_operations",
  config: "app_config",
} as const;

export function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const candidate = value as { toDate?: () => Date };
    if (typeof candidate.toDate === "function") return candidate.toDate().toISOString();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return value;
}

export function documentJson(snapshot: QueryDocumentSnapshot): Record<string, unknown> {
  return { id: snapshot.id, ...(jsonValue(snapshot.data()) as Record<string, unknown>) };
}

export function adminUserJson(id: string, profile: DocumentData): Record<string, unknown> {
  return {
    uid: id,
    email: profile.email || "",
    displayName: profile.displayName || "Morphly user",
    photoUrl: profile.photoURL || profile.photoUrl || null,
    role: profile.role === "admin" ? "admin" : "user",
    status: profile.status === "suspended" ? "suspended" : "active",
    credits: Number.isFinite(profile.credits) ? profile.credits : 0,
    plan: profile.plan || "free",
    createdAt: jsonValue(profile.createdAt) || new Date(0).toISOString(),
    updatedAt: jsonValue(profile.updatedAt),
    lastSeenAt: jsonValue(profile.lastSeenAt),
    lastLoginAt: jsonValue(profile.lastLoginAt),
    sessionCount: Number.isFinite(profile.sessionCount) ? profile.sessionCount : 0,
    totalUsageSeconds: Number.isFinite(profile.totalUsageSeconds) ? profile.totalUsageSeconds : 0,
    totalSpent: Number.isFinite(profile.totalSpent) ? profile.totalSpent : 0,
    currency: profile.currency || process.env.MORPHLY_REPORTING_CURRENCY || "USD",
    country: profile.country || null,
  };
}

export function notificationJson(
  id: string,
  notification: DocumentData,
  includeAdminFields = false,
): Record<string, unknown> {
  const kind = notification.kind || notification.severity || "info";
  const normalizedKind = kind === "error" || kind === "maintenance" ? "critical" : kind;
  const publicFields: Record<string, unknown> = {
    id,
    title: notification.title || "Morphly update",
    message: notification.message || "",
    kind: normalizedKind,
    createdAt: jsonValue(notification.createdAt) || new Date(0).toISOString(),
    startsAt: jsonValue(notification.startsAt),
    endsAt: jsonValue(notification.endsAt || notification.expiresAt),
    actionLabel: notification.actionLabel || null,
    actionUrl: notification.actionUrl || null,
  };
  if (!includeAdminFields) return publicFields;
  return {
    ...publicFields,
    audience: notification.audience || "all",
    selectedUserIds: Array.isArray(notification.selectedUserIds) ? notification.selectedUserIds : [],
    active: notification.active !== false,
    createdBy: notification.createdBy || "",
    deliveryCount: Number.isFinite(notification.deliveryCount) ? notification.deliveryCount : 0,
    readCount: Number.isFinite(notification.readCount) ? notification.readCount : 0,
  };
}

export async function writeAudit(input: {
  actorUid: string;
  actorEmail?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await adminDb().collection(collections.audit).add({
    ...input,
    actorEmail: input.actorEmail || null,
    metadata: input.metadata || {},
    createdAt: FieldValue.serverTimestamp(),
  });
}

export async function loadSupport(): Promise<Record<string, unknown>> {
  const snapshot = await adminDb().collection(collections.config).doc("support").get();
  if (!snapshot.exists) {
    return {
      email: "",
      phone: "",
      whatsapp: "",
      website: "",
      workingHours: "",
      helpCenterUrl: "",
      updatedAt: null,
      updatedBy: null,
    };
  }
  const support = snapshot.data() || {};
  return {
    email: support.email || "",
    phone: support.phone || "",
    whatsapp: support.whatsapp || "",
    website: support.website || "",
    workingHours: support.workingHours || support.hours || "",
    helpCenterUrl: support.helpCenterUrl || "",
    updatedAt: jsonValue(support.updatedAt),
    updatedBy: support.updatedBy || null,
  };
}

export async function loadActiveNotifications(
  limit = 20,
  role: "user" | "admin" = "user",
  uid?: string,
): Promise<Record<string, unknown>[]> {
  const now = Date.now();
  const snapshot = await adminDb()
    .collection(collections.notifications)
    .orderBy("createdAt", "desc")
    .limit(Math.max(limit, 50))
    .get();

  return snapshot.docs
    .filter((document) => {
      const notification = document.data();
      const audience = notification.audience || "all";
      if (audience === "admins" && role !== "admin") return false;
      if (audience === "users" && role !== "user") return false;
      if (audience === "selected") {
        if (!uid || !Array.isArray(notification.selectedUserIds) || !notification.selectedUserIds.includes(uid)) {
          return false;
        }
      }
      if (notification.active === false) return false;
      const startsAt = notification.startsAt?.toDate?.().getTime?.() ?? Number.NaN;
      const expiresAt = (notification.endsAt || notification.expiresAt)?.toDate?.().getTime?.() ?? Number.NaN;
      return (!Number.isFinite(startsAt) || startsAt <= now) && (!Number.isFinite(expiresAt) || expiresAt > now);
    })
    .map((document) => notificationJson(document.id, document.data()))
    .slice(0, limit);
}

export function timestampFromOptionalIso(value: string | undefined): Timestamp | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid ISO timestamp.");
  return Timestamp.fromDate(parsed);
}
