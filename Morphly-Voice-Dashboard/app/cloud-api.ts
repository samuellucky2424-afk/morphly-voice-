import type {
  AdminListQuery,
  AdminLiveSession,
  AdminLogEntry,
  AdminNotification,
  AdminOverview,
  AdminPurchase,
  AdminUser,
  ClientEventInput,
  ClientHeartbeatInput,
  CreateNotificationInput,
  CreditAdjustmentInput,
  CreditAdjustmentResult,
  PaginatedResult,
  PaymentInitializationInput,
  PaymentInitializationResult,
  PlatformSession,
  PublicNotification,
  SupportConfig,
  SuspensionInput,
  UpdateSupportConfigInput,
  UserBootstrap,
} from "./platform-types";

const CLOUD_API_TIMEOUT_MS = 25_000;

export class CloudApiConfigurationError extends Error {
  constructor(message = "Morphly cloud services are not configured on this installation.") {
    super(message);
    this.name = "CloudApiConfigurationError";
  }
}

export class CloudApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, status = 0, code: string | null = null, details: unknown = null) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function configuredBaseUrl() {
  return String(import.meta.env.VITE_MORPHLY_API_URL || "").trim().replace(/\/+$/, "");
}

export function isCloudApiConfigured() {
  return configuredBaseUrl().length > 0;
}

export function getCloudApiBaseUrl() {
  const baseUrl = configuredBaseUrl();
  if (!baseUrl) {
    throw new CloudApiConfigurationError(
      "Set VITE_MORPHLY_API_URL to the deployed Vercel serverless API URL. Local /api routes belong to the voice engine and are not used automatically.",
    );
  }
  return baseUrl;
}

function endpoint(path: string) {
  return `${getCloudApiBaseUrl()}/${path.replace(/^\/+/, "")}`;
}

function errorDetail(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return { message: fallback, code: null };
  const record = payload as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null;
  const message = String(nested?.message || record.message || record.detail || record.error || fallback);
  const codeValue = nested?.code || record.code;
  return { message, code: typeof codeValue === "string" ? codeValue : null };
}

function unwrapData<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

async function cloudRequest<T>(
  path: string,
  token: string,
  options: RequestInit = {},
  timeoutMs = CLOUD_API_TIMEOUT_MS,
): Promise<T> {
  if (!token.trim()) throw new CloudApiError("A Firebase ID token is required for this request.", 401, "missing_token");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint(path), {
      ...options,
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });

    const responseText = await response.text();
    let payload: unknown = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }
    }

    if (!response.ok) {
      const detail = errorDetail(payload, `Morphly cloud request failed (${response.status}).`);
      throw new CloudApiError(detail.message, response.status, detail.code, payload);
    }
    return unwrapData<T>(payload);
  } catch (error) {
    if (error instanceof CloudApiError || error instanceof CloudApiConfigurationError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new CloudApiError("The Morphly cloud service did not respond in time.", 0, "request_timeout");
    }
    throw new CloudApiError(error instanceof Error ? error.message : "The Morphly cloud service is unavailable.");
  } finally {
    window.clearTimeout(timeout);
  }
}

function jsonBody(method: string, value: unknown): RequestInit {
  return { method, body: JSON.stringify(value) };
}

function queryString(query: AdminListQuery = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function paginated<T>(payload: unknown, collectionKeys: string[] = []): PaginatedResult<T> {
  if (Array.isArray(payload)) return { items: payload as T[], total: payload.length, nextCursor: null };
  const value = unwrapData<Record<string, unknown>>(payload);
  const collection = ["items", ...collectionKeys]
    .map((key) => value?.[key])
    .find(Array.isArray);
  const items = Array.isArray(collection) ? collection as T[] : [];
  return {
    items,
    total: Number.isFinite(Number(value?.total ?? value?.count)) ? Number(value.total ?? value.count) : items.length,
    nextCursor: typeof value?.nextCursor === "string" && value.nextCursor ? value.nextCursor : null,
  };
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numericValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function supportFromPayload(payload: unknown): SupportConfig {
  const root = objectValue(unwrapData<unknown>(payload));
  const support = objectValue(root.support || root);
  return {
    email: text(support.email),
    phone: text(support.phone),
    whatsapp: text(support.whatsapp),
    website: text(support.website),
    workingHours: text(support.workingHours || support.hours),
    helpCenterUrl: text(support.helpCenterUrl),
    updatedAt: nullableText(support.updatedAt),
    updatedBy: nullableText(support.updatedBy),
  };
}

function notificationKind(value: unknown): PublicNotification["kind"] {
  if (value === "success" || value === "warning" || value === "critical") return value;
  if (value === "error") return "critical";
  if (value === "maintenance") return "warning";
  return "info";
}

function notificationFromPayload(payload: unknown): PublicNotification {
  const value = objectValue(payload);
  return {
    id: text(value.id),
    title: text(value.title, "Morphly notification"),
    message: text(value.message),
    kind: notificationKind(value.kind || value.severity),
    createdAt: text(value.createdAt, new Date().toISOString()),
    startsAt: nullableText(value.startsAt),
    endsAt: nullableText(value.endsAt || value.expiresAt),
    actionLabel: nullableText(value.actionLabel),
    actionUrl: nullableText(value.actionUrl),
  };
}

function adminNotificationFromPayload(payload: unknown): AdminNotification {
  const value = objectValue(payload);
  const notification = notificationFromPayload(value);
  const audience = value.audience === "users" || value.audience === "admins" || value.audience === "selected"
    ? value.audience
    : "all";
  return {
    ...notification,
    audience,
    selectedUserIds: Array.isArray(value.selectedUserIds) ? value.selectedUserIds.filter((item): item is string => typeof item === "string") : [],
    active: value.active !== false,
    createdBy: text(value.createdBy),
    deliveryCount: Math.max(0, numericValue(value.deliveryCount)),
    readCount: Math.max(0, numericValue(value.readCount)),
  };
}

function analyticsSeries(value: unknown): AdminOverview["sessions"] {
  if (!Array.isArray(value)) return [];
  return value.map((point) => {
    const candidate = objectValue(point);
    return {
      label: text(candidate.label),
      value: numericValue(candidate.value),
      ...(candidate.secondaryValue !== undefined ? { secondaryValue: numericValue(candidate.secondaryValue) } : {}),
    };
  });
}

function overviewFromPayload(payload: unknown): AdminOverview {
  const root = objectValue(unwrapData<unknown>(payload));
  const legacy = objectValue(root.overview || root.stats);
  const legacyUsers = objectValue(legacy.users);
  const legacyPurchases = objectValue(legacy.purchases);
  const metrics = objectValue(root.metrics);
  const engineUsage = objectValue(root.engineUsage);
  return {
    metrics: {
      totalUsers: numericValue(metrics.totalUsers ?? legacyUsers.total),
      activeUsers: numericValue(metrics.activeUsers ?? legacyUsers.active ?? legacyUsers.activeToday),
      liveUsers: numericValue(metrics.liveUsers ?? legacy.liveUsers),
      suspendedUsers: numericValue(metrics.suspendedUsers ?? legacyUsers.suspended),
      totalCredits: numericValue(metrics.totalCredits ?? legacy.totalCredits),
      totalRevenue: numericValue(metrics.totalRevenue ?? legacyPurchases.revenue),
      purchasesToday: numericValue(metrics.purchasesToday ?? legacyPurchases.successful),
      sessionsToday: numericValue(metrics.sessionsToday ?? legacy.sessionsToday),
      averageLatencyMs: numericValue(metrics.averageLatencyMs ?? legacy.averageLatencyMs),
      errorRate: numericValue(metrics.errorRate ?? legacy.errorRate),
    },
    userGrowth: analyticsSeries(root.userGrowth),
    revenue: analyticsSeries(root.revenue),
    sessions: analyticsSeries(root.sessions),
    engineUsage: {
      rvc: numericValue(engineUsage.rvc),
      beatrice: numericValue(engineUsage.beatrice),
    },
    generatedAt: text(root.generatedAt, new Date().toISOString()),
  };
}

function sessionFromPayload(payload: unknown): PlatformSession {
  const unwrapped = unwrapData<Record<string, unknown>>(payload);
  const candidate = unwrapped?.session && typeof unwrapped.session === "object"
    ? unwrapped.session as Record<string, unknown>
    : unwrapped?.user && typeof unwrapped.user === "object"
      ? unwrapped.user as Record<string, unknown>
      : unwrapped;
  const role = candidate?.role;
  if (role !== "user" && role !== "admin") {
    throw new CloudApiError("The backend did not return a valid account role.", 403, "invalid_role", payload);
  }
  const statusValue = candidate.status;
  const status = statusValue === "suspended" || statusValue === "pending" || statusValue === "disabled"
    ? statusValue
    : "active";
  const uid = text(candidate.uid || candidate.id);
  const email = text(candidate.email);
  if (!uid || !email) throw new CloudApiError("The backend returned an incomplete user session.", 502, "invalid_session", payload);

  return {
    uid,
    email,
    displayName: text(candidate.displayName || candidate.name, email.split("@")[0] || "Morphly user"),
    photoUrl: nullableText(candidate.photoUrl || candidate.photoURL),
    role,
    status,
    credits: Math.max(0, Number(candidate.credits) || 0),
    source: "cloud",
    createdAt: nullableText(candidate.createdAt),
    lastSeenAt: nullableText(candidate.lastSeenAt),
  };
}

/** Verifies a Firebase ID token through the Vercel API and returns its authoritative backend role. */
export async function getPlatformSession(token: string) {
  const payload = await cloudRequest<unknown>("/auth/session", token, { method: "POST" });
  return sessionFromPayload(payload);
}

export async function getUserBootstrap(token: string) {
  const payload = await cloudRequest<unknown>("/user/bootstrap", token);
  const root = objectValue(unwrapData<unknown>(payload));
  const rawNotifications = Array.isArray(root.notifications) ? root.notifications : [];
  return {
    session: sessionFromPayload(root.session || root.user || root),
    notifications: rawNotifications.map(notificationFromPayload),
    support: supportFromPayload(root.support || {}),
    serverTime: text(root.serverTime, new Date().toISOString()),
  } satisfies UserBootstrap;
}

export async function getAdminOverview(token: string) {
  return overviewFromPayload(await cloudRequest<unknown>("/admin/overview", token));
}

export async function getAdminUsers(token: string, query: AdminListQuery = {}) {
  const normalizedQuery = { ...query, ...(query.search ? { q: query.search, search: undefined } : {}) };
  return paginated<AdminUser>(await cloudRequest<unknown>(`/admin/users${queryString(normalizedQuery)}`, token), ["users"]);
}

export async function getAdminLiveSessions(token: string, query: AdminListQuery = {}) {
  return paginated<AdminLiveSession>(await cloudRequest<unknown>(`/admin/live-sessions${queryString(query)}`, token), ["liveSessions", "sessions"]);
}

export async function getAdminPurchases(token: string, query: AdminListQuery = {}) {
  return paginated<AdminPurchase>(await cloudRequest<unknown>(`/admin/purchases${queryString(query)}`, token), ["purchases"]);
}

export async function getAdminLogs(token: string, query: AdminListQuery = {}) {
  return paginated<AdminLogEntry>(await cloudRequest<unknown>(`/admin/logs${queryString(query)}`, token), ["logs"]);
}

export async function getAdminNotifications(token: string, query: AdminListQuery = {}) {
  const result = paginated<unknown>(await cloudRequest<unknown>(`/admin/notifications${queryString(query)}`, token), ["notifications"]);
  return { ...result, items: result.items.map(adminNotificationFromPayload) };
}

export async function getSupportConfig(token: string) {
  return supportFromPayload(await cloudRequest<unknown>("/support", token));
}

export function adjustUserCredits(token: string, userId: string, input: CreditAdjustmentInput) {
  const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
  return cloudRequest<CreditAdjustmentResult>(
    `/admin/users/${encodeURIComponent(userId)}/credits`,
    token,
    {
      ...jsonBody("POST", { ...input, idempotencyKey }),
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );
}

export async function setUserSuspension(token: string, userId: string, input: SuspensionInput) {
  const payload = await cloudRequest<AdminUser | { user: AdminUser }>(
    `/admin/users/${encodeURIComponent(userId)}/suspension`,
    token,
    jsonBody("PATCH", input),
  );
  return "user" in payload ? payload.user : payload;
}

export function createNotification(token: string, input: CreateNotificationInput) {
  return cloudRequest<unknown>("/admin/notifications", token, jsonBody("POST", {
    ...input,
    severity: input.kind === "critical" ? "error" : input.kind,
    expiresAt: input.endsAt,
  })).then((payload) => {
    const root = objectValue(unwrapData<unknown>(payload));
    return adminNotificationFromPayload(root.notification || root);
  });
}

export async function updateSupportConfig(token: string, input: UpdateSupportConfigInput) {
  const payload = await cloudRequest<unknown>("/admin/support", token, jsonBody("PUT", {
    ...input,
    hours: input.workingHours,
  }));
  return supportFromPayload(payload);
}

export async function sendHeartbeat(token: string, input: ClientHeartbeatInput) {
  await cloudRequest<unknown>("/telemetry/heartbeat", token, jsonBody("POST", {
    ...input,
    engineMode: input.engine,
    running: input.status === "live",
  }));
}

export async function sendClientEvent(token: string, input: ClientEventInput) {
  await cloudRequest<unknown>("/telemetry/events", token, jsonBody("POST", {
    ...input,
    type: input.event,
    severity: input.level || "info",
    engineMode: input.engine,
    details: { ...(input.metadata || {}), category: input.category },
  }));
}

export async function initializePayment(token: string, input: PaymentInitializationInput) {
  const payload = await cloudRequest<unknown>("/payments/initialize", token, jsonBody("POST", input));
  const root = objectValue(unwrapData<unknown>(payload));
  const payment = objectValue(root.payment);
  return {
    checkoutUrl: text(root.checkoutUrl || root.link),
    reference: text(root.reference || payment.txRef),
    amount: numericValue(root.amount ?? payment.amount),
    currency: text(root.currency || payment.currency, "USD"),
    credits: numericValue(root.credits ?? payment.credits),
    status: "pending",
  } satisfies PaymentInitializationResult;
}
