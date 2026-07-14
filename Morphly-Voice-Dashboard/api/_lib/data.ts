import { createHash } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin.js";

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

export const BILLING_PERIOD_SECONDS = 10;
export const BILLING_CREDITS_PER_PERIOD = 2;
export const SUPPORTED_BILLING_CURRENCIES = ["USD", "NGN"] as const;

export type BillingCurrency = (typeof SUPPORTED_BILLING_CURRENCIES)[number];

export type BillingPlan = {
  id: string;
  label: string;
  credits: number;
  amountMinor: number;
  enabled: boolean;
  bestValue: boolean;
  sortOrder: number;
};

export type BillingConfig = {
  version: number;
  currency: BillingCurrency;
  periodSeconds: number;
  creditsPerPeriod: number;
  plans: BillingPlan[];
  updatedAt: string | null;
  updatedBy: string | null;
};

export class BillingConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingConfigValidationError";
  }
}

export class BillingConfigConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super("Billing packages changed in another administrator session. Reload them before saving again.");
    this.name = "BillingConfigConflictError";
    this.currentVersion = currentVersion;
  }
}

const DEFAULT_BILLING_PLANS: BillingPlan[] = [
  {
    id: "starter",
    label: "Starter credits",
    credits: 1000,
    amountMinor: 1000,
    enabled: true,
    bestValue: false,
    sortOrder: 0,
  },
  {
    id: "creator",
    label: "Creator credits",
    credits: 2500,
    amountMinor: 2200,
    enabled: true,
    bestValue: true,
    sortOrder: 1,
  },
  {
    id: "studio",
    label: "Studio credits",
    credits: 6000,
    amountMinor: 4800,
    enabled: true,
    bestValue: false,
    sortOrder: 2,
  },
];

export function defaultBillingConfig(): BillingConfig {
  return {
    version: 1,
    currency: "USD",
    periodSeconds: BILLING_PERIOD_SECONDS,
    creditsPerPeriod: BILLING_CREDITS_PER_PERIOD,
    plans: DEFAULT_BILLING_PLANS.map((plan) => ({ ...plan })),
    updatedAt: null,
    updatedBy: null,
  };
}

/**
 * Converts an integer minor-unit amount into the decimal amount Flutterwave
 * expects. Morphly currently supports currencies with two fractional digits.
 */
export function billingAmountFromMinor(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new BillingConfigValidationError("Credit package amountMinor must be a positive safe integer.");
  }
  return Number((amountMinor / 100).toFixed(2));
}

export function validateBillingConfig(value: unknown): BillingConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingConfigValidationError("Billing configuration must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const currency = String(candidate.currency || "").trim().toUpperCase();
  if (!SUPPORTED_BILLING_CURRENCIES.includes(currency as BillingCurrency)) {
    throw new BillingConfigValidationError("Billing currency must be USD or NGN.");
  }

  const periodSeconds = numberOrDefault(candidate.periodSeconds, BILLING_PERIOD_SECONDS);
  const creditsPerPeriod = numberOrDefault(candidate.creditsPerPeriod, BILLING_CREDITS_PER_PERIOD);
  if (periodSeconds !== BILLING_PERIOD_SECONDS || creditsPerPeriod !== BILLING_CREDITS_PER_PERIOD) {
    throw new BillingConfigValidationError(
      `Morphly usage billing must remain ${BILLING_CREDITS_PER_PERIOD} credits per ${BILLING_PERIOD_SECONDS} seconds.`,
    );
  }

  if (!Array.isArray(candidate.plans) || candidate.plans.length < 1 || candidate.plans.length > 20) {
    throw new BillingConfigValidationError("Billing configuration must contain between 1 and 20 credit packages.");
  }

  const ids = new Set<string>();
  const plans = candidate.plans.map((rawPlan, index) => {
    if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
      throw new BillingConfigValidationError(`Credit package ${index + 1} must be an object.`);
    }
    const plan = rawPlan as Record<string, unknown>;
    const id = String(plan.id || "").trim();
    const label = String(plan.label || id).trim();
    const credits = Number(plan.credits);
    const amountMinor = normalizedAmountMinor(plan);
    const planCurrency = plan.currency === undefined
      ? currency
      : String(plan.currency || "").trim().toUpperCase();

    if (!/^[A-Za-z0-9_-]{1,50}$/.test(id)) {
      throw new BillingConfigValidationError(`Credit package ${index + 1} has an invalid id.`);
    }
    if (ids.has(id)) throw new BillingConfigValidationError(`Credit package id '${id}' is duplicated.`);
    ids.add(id);
    if (!label || label.length > 100) {
      throw new BillingConfigValidationError(`Credit package '${id}' must have a label of at most 100 characters.`);
    }
    if (!Number.isSafeInteger(credits) || credits <= 0 || credits > 100_000_000) {
      throw new BillingConfigValidationError(`Credit package '${id}' has an invalid credit amount.`);
    }
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 100_000_000_000) {
      throw new BillingConfigValidationError(`Credit package '${id}' has an invalid minor-unit price.`);
    }
    if (planCurrency !== currency) {
      throw new BillingConfigValidationError(`Credit package '${id}' currency must match the billing currency.`);
    }

    const sortOrder = plan.sortOrder === undefined ? index : Number(plan.sortOrder);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
      throw new BillingConfigValidationError(`Credit package '${id}' has an invalid sortOrder.`);
    }
    if (plan.enabled !== undefined && typeof plan.enabled !== "boolean") {
      throw new BillingConfigValidationError(`Credit package '${id}' enabled must be true or false.`);
    }
    if (plan.bestValue !== undefined && typeof plan.bestValue !== "boolean") {
      throw new BillingConfigValidationError(`Credit package '${id}' bestValue must be true or false.`);
    }

    return {
      id,
      label,
      credits,
      amountMinor,
      enabled: plan.enabled !== false,
      bestValue: plan.bestValue === true,
      sortOrder,
    } satisfies BillingPlan;
  }).sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));

  if (!plans.some((plan) => plan.enabled)) {
    throw new BillingConfigValidationError("At least one credit package must be enabled.");
  }

  const version = numberOrDefault(candidate.version, 1);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new BillingConfigValidationError("Billing configuration version must be a positive integer.");
  }

  return {
    version,
    currency: currency as BillingCurrency,
    periodSeconds,
    creditsPerPeriod,
    plans,
    updatedAt: serializedConfigTimestamp(candidate.updatedAt),
    updatedBy: nullableString(candidate.updatedBy, 128),
  };
}

export async function loadBillingConfig(): Promise<BillingConfig> {
  const snapshot = await adminDb().collection(collections.config).doc("billing").get();
  if (snapshot.exists) return validateBillingConfig(snapshot.data());

  const legacy = legacyEnvironmentBillingConfig();
  return legacy || defaultBillingConfig();
}

export async function saveBillingConfig(value: unknown, actorUid: string): Promise<BillingConfig> {
  if (!actorUid || actorUid.length > 128) {
    throw new BillingConfigValidationError("A valid administrator user ID is required.");
  }
  const requested = validateBillingConfig(value);
  const database = adminDb();
  const configReference = database.collection(collections.config).doc("billing");
  const auditReference = database.collection(collections.audit).doc();

  const saved = await database.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(configReference);
    const currentVersion = currentSnapshot.exists && Number.isSafeInteger(currentSnapshot.data()?.version)
      ? Number(currentSnapshot.data()?.version)
      : defaultBillingConfig().version;
    if (requested.version !== currentVersion) {
      throw new BillingConfigConflictError(currentVersion);
    }
    // The server owns version progression; an administrator cannot skip or
    // roll back versions by modifying a request body.
    const nextVersion = currentVersion + 1;
    const timestamp = FieldValue.serverTimestamp();
    const stored = {
      ...requested,
      version: nextVersion,
      updatedAt: timestamp,
      updatedBy: actorUid,
    };
    transaction.set(configReference, stored);
    transaction.create(auditReference, {
      actorUid,
      actorEmail: null,
      action: "billing.config_updated",
      targetType: "app_config",
      targetId: "billing",
      metadata: {
        previousVersion: currentVersion,
        version: nextVersion,
        currency: requested.currency,
        periodSeconds: requested.periodSeconds,
        creditsPerPeriod: requested.creditsPerPeriod,
        planIds: requested.plans.map((plan) => plan.id),
      },
      createdAt: timestamp,
    });
    return { ...requested, version: nextVersion };
  });

  return {
    ...saved,
    updatedAt: new Date().toISOString(),
    updatedBy: actorUid,
  };
}

function numberOrDefault(value: unknown, fallback: number): number {
  return value === undefined || value === null || value === "" ? fallback : Number(value);
}

function normalizedAmountMinor(plan: Record<string, unknown>): number {
  if (plan.amountMinor !== undefined && plan.amountMinor !== null && plan.amountMinor !== "") {
    return Number(plan.amountMinor);
  }
  const majorAmount = Number(plan.amount);
  if (!Number.isFinite(majorAmount) || majorAmount <= 0) return Number.NaN;
  const amountMinor = majorAmount * 100;
  if (Math.abs(amountMinor - Math.round(amountMinor)) > 0.000_001) return Number.NaN;
  return Math.round(amountMinor);
}

function nullableString(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maximum) {
    throw new BillingConfigValidationError(`Billing configuration string cannot exceed ${maximum} characters.`);
  }
  return value.trim() || null;
}

function serializedConfigTimestamp(value: unknown): string | null {
  const serialized = jsonValue(value);
  if (serialized === undefined || serialized === null || serialized === "") return null;
  if (typeof serialized !== "string" || Number.isNaN(new Date(serialized).getTime())) {
    throw new BillingConfigValidationError("Billing configuration updatedAt must be a valid timestamp.");
  }
  return serialized;
}

function legacyEnvironmentBillingConfig(): BillingConfig | null {
  const raw = process.env.MORPHLY_CREDIT_PLANS_JSON?.trim();
  if (!raw) return null;

  let plans: unknown;
  try {
    plans = JSON.parse(raw) as unknown;
  } catch {
    throw new BillingConfigValidationError("MORPHLY_CREDIT_PLANS_JSON must contain valid JSON.");
  }
  if (!Array.isArray(plans)) {
    throw new BillingConfigValidationError("MORPHLY_CREDIT_PLANS_JSON must be an array.");
  }
  const currencies = plans
    .map((plan) => plan && typeof plan === "object" ? String((plan as Record<string, unknown>).currency || "") : "")
    .filter(Boolean)
    .map((currency) => currency.toUpperCase());
  const currency = currencies[0] || String(process.env.MORPHLY_REPORTING_CURRENCY || "USD").toUpperCase();
  if (currencies.some((candidate) => candidate !== currency)) {
    throw new BillingConfigValidationError("All legacy Morphly credit packages must use the same currency.");
  }
  return validateBillingConfig({
    version: 1,
    currency,
    periodSeconds: BILLING_PERIOD_SECONDS,
    creditsPerPeriod: BILLING_CREDITS_PER_PERIOD,
    plans,
  });
}

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
    .limit(Math.max(limit, 500))
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
