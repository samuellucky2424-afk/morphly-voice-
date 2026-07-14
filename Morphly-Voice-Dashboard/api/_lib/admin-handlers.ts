import { FieldValue, Timestamp, type Query } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "./firebase-admin.js";
import { requireAdmin } from "./auth.js";
import {
  adminUserJson,
  collections,
  jsonValue,
  loadSupport,
  notificationJson,
  stableId,
  timestampFromOptionalIso,
} from "./data.js";
import {
  HttpError,
  booleanField,
  boundedLimit,
  headerValue,
  numericField,
  readBody,
  requestUrl,
  requireObject,
  stringField,
  type ApiRequest,
} from "./http.js";

async function queryCount(query: Query): Promise<number> {
  const snapshot = await query.count().get();
  return snapshot.data().count;
}

function validatedUid(value: string): string {
  if (!value || value.length > 128 || /[\/\\\u0000-\u001f]/.test(value)) {
    throw new HttpError(400, "invalid_uid", "Firebase user ID is invalid.");
  }
  return value;
}

export async function adminOverview(request: ApiRequest): Promise<Record<string, unknown>> {
  await requireAdmin(request);
  const database = adminDb();
  const users = database.collection(collections.users);
  const payments = database.collection(collections.payments);
  const presence = database.collection(collections.presence);
  const activeSince = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
  const liveSince = Timestamp.fromMillis(Date.now() - 90 * 1000);
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const today = Timestamp.fromDate(startOfToday);
  const chartStart = Timestamp.fromMillis(Date.now() - 6 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    activeUsers,
    suspendedUsers,
    activeToday,
    successfulPurchases,
    purchasesToday,
    sessionsToday,
    logsToday,
    errorsToday,
    userBalances,
    livePresence,
    chartUsers,
    chartPayments,
    chartSessions,
  ] = await Promise.all([
    queryCount(users),
    queryCount(users.where("status", "==", "active")),
    queryCount(users.where("status", "==", "suspended")),
    queryCount(users.where("lastSeenAt", ">=", activeSince)),
    queryCount(payments.where("status", "==", "successful")),
    queryCount(payments.where("createdAt", ">=", today)),
    queryCount(database.collection(collections.sessions).where("startedAt", ">=", today)),
    queryCount(database.collection(collections.logs).where("createdAt", ">=", today)),
    queryCount(database.collection(collections.logs).where("severity", "in", ["error", "critical"]).where("createdAt", ">=", today)),
    users.limit(1000).get(),
    presence.where("lastSeenAt", ">=", liveSince).limit(500).get(),
    users.where("createdAt", ">=", chartStart).limit(2000).get(),
    payments.where("status", "==", "successful").where("createdAt", ">=", chartStart).limit(2000).get(),
    database.collection(collections.sessions).where("startedAt", ">=", chartStart).limit(2000).get(),
  ]);

  const revenueSnapshot = await payments.where("status", "==", "successful").limit(1000).get();
  const reportingCurrency = process.env.MORPHLY_REPORTING_CURRENCY || "USD";
  const totalRevenue = revenueSnapshot.docs.reduce((sum, document) => {
    if (String(document.data().currency || reportingCurrency).toUpperCase() !== reportingCurrency.toUpperCase()) return sum;
    const amount = Number(document.data().amount);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  const totalCredits = userBalances.docs.reduce((sum, document) => {
    const credits = Number(document.data().credits);
    return sum + (Number.isFinite(credits) ? credits : 0);
  }, 0);
  const latencies = livePresence.docs
    .map((document) => Number(document.data().latencyMs))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const averageLatencyMs = latencies.length
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : 0;
  const engineUsage = livePresence.docs.reduce(
    (usage, document) => {
      const engine = String(document.data().engineMode || document.data().engine || "").toLowerCase();
      if (engine === "rvc" || engine === "beatrice") usage[engine] += 1;
      return usage;
    },
    { rvc: 0, beatrice: 0 },
  );
  const metrics = {
    totalUsers,
    activeUsers,
    liveUsers: livePresence.size,
    suspendedUsers,
    totalCredits,
    totalRevenue,
    purchasesToday,
    sessionsToday,
    averageLatencyMs,
    errorRate: logsToday ? Number(((errorsToday / logsToday) * 100).toFixed(2)) : 0,
  };

  return {
    metrics,
    userGrowth: dailySeries(chartUsers.docs.map((document) => document.data().createdAt), () => 1),
    revenue: dailySeries(
      chartPayments.docs.map((document) => document.data().createdAt),
      (index) => Number(chartPayments.docs[index]?.data().amount) || 0,
    ),
    sessions: dailySeries(chartSessions.docs.map((document) => document.data().startedAt), () => 1),
    engineUsage,
    generatedAt: new Date().toISOString(),
    meta: {
      activeToday,
      successfulPurchases,
      userCreditsPartial: userBalances.size >= 1000,
      revenuePartial: revenueSnapshot.size >= 1000,
    },
  };
}

function dailySeries(timestamps: unknown[], valueAt: (index: number) => number): Array<{ label: string; value: number }> {
  const days = new Map<string, number>();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    days.set(date.toISOString().slice(0, 10), 0);
  }
  timestamps.forEach((timestamp, index) => {
    const value = timestamp && typeof timestamp === "object" && "toDate" in timestamp
      ? (timestamp as { toDate: () => Date }).toDate()
      : null;
    if (!value) return;
    const key = value.toISOString().slice(0, 10);
    if (days.has(key)) days.set(key, (days.get(key) || 0) + valueAt(index));
  });
  return [...days.entries()].map(([label, value]) => ({ label, value }));
}

export async function adminUsers(request: ApiRequest): Promise<Record<string, unknown>> {
  await requireAdmin(request);
  const url = requestUrl(request);
  const limit = boundedLimit(url, 50, 100);
  const status = url.searchParams.get("status")?.trim();
  const search = (url.searchParams.get("q") || url.searchParams.get("search"))?.trim().toLowerCase();
  const cursor = url.searchParams.get("cursor")?.trim();
  const collection = adminDb().collection(collections.users);
  let query: Query = collection;

  if (status) {
    if (!new Set(["active", "suspended"]).has(status)) {
      throw new HttpError(400, "invalid_status", "status must be active or suspended.");
    }
    query = query.where("status", "==", status);
  }
  query = query.orderBy("createdAt", "desc");

  if (cursor) {
    const cursorSnapshot = await collection.doc(cursor).get();
    if (cursorSnapshot.exists) query = query.startAfter(cursorSnapshot);
  }

  const snapshot = await query.limit(search ? Math.min(limit * 4, 300) : limit).get();
  let records = snapshot.docs.map((document) => adminUserJson(document.id, document.data()));
  if (search) {
    records = records.filter((user) =>
      `${String(user.displayName || "")} ${String(user.email || "")} ${String(user.uid || "")}`
        .toLowerCase()
        .includes(search),
    );
  }
  records = records.slice(0, limit);
  const last = snapshot.docs.at(-1);

  return {
    items: records,
    users: records,
    nextCursor: snapshot.size >= limit && last ? last.id : null,
    total: records.length,
  };
}

export async function adminLive(request: ApiRequest): Promise<Record<string, unknown>> {
  await requireAdmin(request);
  const url = requestUrl(request);
  const windowSeconds = Math.max(30, Math.min(300, Number(url.searchParams.get("windowSeconds") || 90)));
  const cutoff = Timestamp.fromMillis(Date.now() - windowSeconds * 1000);
  const snapshot = await adminDb()
    .collection(collections.presence)
    .where("lastSeenAt", ">=", cutoff)
    .orderBy("lastSeenAt", "desc")
    .limit(250)
    .get();
  const liveSessions = snapshot.docs.map((document) => {
    const presence = document.data();
    const engine = String(presence.engineMode || presence.engine || "rvc").toLowerCase() === "beatrice" ? "beatrice" : "rvc";
    const status = new Set(["starting", "live", "idle", "ended", "error"]).has(presence.status)
      ? presence.status
      : presence.running ? "live" : "idle";
    return {
      id: String(presence.sessionId || document.id),
      userId: presence.uid || document.id,
      userEmail: presence.email || "",
      userName: presence.displayName || "Morphly user",
      engine,
      voiceName: presence.voiceName || "",
      startedAt: jsonValue(presence.startedAt) || jsonValue(presence.lastSeenAt),
      lastHeartbeatAt: jsonValue(presence.lastSeenAt),
      latencyMs: Number.isFinite(presence.latencyMs) ? presence.latencyMs : null,
      cpuPercent: Number.isFinite(presence.cpuPercent) ? presence.cpuPercent : null,
      memoryMb: Number.isFinite(presence.memoryMb) ? presence.memoryMb : null,
      appVersion: presence.appVersion || null,
      platform: presence.platform || null,
      status,
    };
  });
  return { items: liveSessions, liveSessions, sessions: liveSessions, total: liveSessions.length, nextCursor: null, windowSeconds };
}

export async function adminPurchases(request: ApiRequest): Promise<Record<string, unknown>> {
  await requireAdmin(request);
  const url = requestUrl(request);
  const limit = boundedLimit(url, 50, 100);
  const status = url.searchParams.get("status")?.trim();
  const collection = adminDb().collection(collections.payments);
  let query: Query = collection;
  if (status) query = query.where("status", "==", status);
  query = query.orderBy("createdAt", "desc");

  const cursor = url.searchParams.get("cursor")?.trim();
  if (cursor) {
    const cursorSnapshot = await collection.doc(cursor).get();
    if (cursorSnapshot.exists) query = query.startAfter(cursorSnapshot);
  }
  const snapshot = await query.limit(limit).get();
  const last = snapshot.docs.at(-1);
  const purchases = snapshot.docs.map((document) => {
    const payment = document.data();
    return {
      id: document.id,
      userId: payment.uid || "",
      userEmail: payment.email || "",
      amount: Number(payment.amount) || 0,
      currency: payment.currency || "USD",
      credits: Number(payment.credits) || 0,
      status: payment.status || "pending",
      provider: "flutterwave",
      providerReference: payment.flutterwaveTransactionId ? String(payment.flutterwaveTransactionId) : payment.txRef || document.id,
      createdAt: jsonValue(payment.createdAt) || new Date(0).toISOString(),
      paidAt: jsonValue(payment.paidAt),
    };
  });
  return {
    items: purchases,
    purchases,
    total: purchases.length,
    nextCursor: snapshot.size === limit && last ? last.id : null,
  };
}

export async function adminLogs(request: ApiRequest): Promise<Record<string, unknown>> {
  await requireAdmin(request);
  const url = requestUrl(request);
  const limit = boundedLimit(url, 75, 150);
  const severity = url.searchParams.get("severity")?.trim();
  const type = url.searchParams.get("type")?.trim();
  const collection = adminDb().collection(collections.logs);
  let query: Query = collection;
  if (severity) query = query.where("severity", "==", severity);
  if (type) query = query.where("type", "==", type);
  query = query.orderBy("createdAt", "desc");

  const cursor = url.searchParams.get("cursor")?.trim();
  if (cursor) {
    const cursorSnapshot = await collection.doc(cursor).get();
    if (cursorSnapshot.exists) query = query.startAfter(cursorSnapshot);
  }
  const snapshot = await query.limit(limit).get();
  const last = snapshot.docs.at(-1);
  const logs = snapshot.docs.map((document) => {
    const log = document.data();
    return {
      id: document.id,
      level: log.level || log.severity || "info",
      category: log.category || "client",
      event: log.event || log.type || "event",
      message: log.message || "",
      userId: log.uid || null,
      sessionId: log.sessionId || null,
      engine: log.engine || log.engineMode || null,
      timestamp: jsonValue(log.createdAt) || new Date(0).toISOString(),
      metadata: log.details || log.metadata || {},
    };
  });
  return {
    items: logs,
    logs,
    total: logs.length,
    nextCursor: snapshot.size === limit && last ? last.id : null,
  };
}

export async function adminNotifications(request: ApiRequest): Promise<Record<string, unknown>> {
  await requireAdmin(request);
  const url = requestUrl(request);
  const limit = boundedLimit(url, 50, 100);
  const collection = adminDb().collection(collections.notifications);
  let query: Query = collection;
  const active = url.searchParams.get("active");
  if (active === "true" || active === "false") query = query.where("active", "==", active === "true");
  const snapshot = await query.orderBy("createdAt", "desc").limit(limit).get();
  const notifications = snapshot.docs.map((document) => notificationJson(document.id, document.data(), true));
  return { items: notifications, notifications, total: notifications.length, nextCursor: null };
}

export async function adminSupport(request: ApiRequest): Promise<Record<string, unknown>> {
  await requireAdmin(request);
  return await loadSupport();
}

export async function adjustCredits(
  request: ApiRequest,
  routeUid?: string,
): Promise<Record<string, unknown>> {
  const admin = await requireAdmin(request);
  const body = requireObject((await readBody(request)).value);
  const uidValue = routeUid || stringField(body, "uid", { required: true, max: 128 });
  if (!uidValue) throw new HttpError(400, "missing_uid", "uid is required.");
  const uid = validatedUid(uidValue);
  const rawAmount = body.amount ?? body.delta;
  const amountBody = { amount: rawAmount };
  const amount = numericField(amountBody, "amount", { required: true, integer: true, min: -10_000_000, max: 10_000_000 });
  if (!amount) throw new HttpError(400, "invalid_amount", "Credit adjustment cannot be zero.");
  const reason = stringField(body, "reason", { required: true, max: 500 });
  if (!reason) throw new HttpError(400, "missing_reason", "reason is required.");
  const idempotencyKey =
    headerValue(request.headers["idempotency-key"]) ||
    stringField(body, "idempotencyKey", { required: true, max: 200 });
  if (!idempotencyKey) throw new HttpError(400, "missing_idempotency_key", "An idempotency key is required.");

  const database = adminDb();
  const userReference = database.collection(collections.users).doc(uid);
  const operationReference = database.collection(collections.operations).doc(stableId(`admin-credit:${admin.uid}:${idempotencyKey}`));
  const ledgerReference = database.collection(collections.ledger).doc();
  const auditReference = database.collection(collections.audit).doc();

  const result = await database.runTransaction(async (transaction) => {
    const [operationSnapshot, userSnapshot] = await Promise.all([
      transaction.get(operationReference),
      transaction.get(userReference),
    ]);
    if (operationSnapshot.exists) {
      const operation = operationSnapshot.data() || {};
      if (operation.uid !== uid || operation.amount !== amount || operation.reason !== reason) {
        throw new HttpError(409, "idempotency_conflict", "This idempotency key was used for a different credit adjustment.");
      }
      return {
        uid,
        amount,
        previousBalance: operation.previousBalance,
        newBalance: operation.newBalance,
        ledgerId: operation.ledgerId,
        auditLogId: operation.auditLogId,
        duplicate: true,
      };
    }
    if (!userSnapshot.exists) throw new HttpError(404, "user_not_found", "The selected user does not exist.");

    const profile = userSnapshot.data() || {};
    const previousBalance = Number.isSafeInteger(profile.credits) ? profile.credits : 0;
    const newBalance = previousBalance + amount;
    if (!Number.isSafeInteger(newBalance)) {
      throw new HttpError(409, "credit_balance_overflow", "This adjustment would exceed the supported credit balance.");
    }
    if (newBalance < 0) {
      throw new HttpError(409, "insufficient_credits", "This adjustment would make the user's balance negative.");
    }
    const timestamp = FieldValue.serverTimestamp();
    const operation = {
      type: "admin_credit_adjustment",
      uid,
      amount,
      previousBalance,
      newBalance,
      ledgerId: ledgerReference.id,
      auditLogId: auditReference.id,
      actorUid: admin.uid,
      idempotencyKey,
      reason,
      createdAt: timestamp,
    };
    transaction.update(userReference, { credits: newBalance, updatedAt: timestamp });
    transaction.create(ledgerReference, {
      uid,
      type: "admin_adjustment",
      amount,
      previousBalance,
      newBalance,
      reason,
      actorUid: admin.uid,
      actorEmail: admin.email,
      createdAt: timestamp,
    });
    transaction.create(operationReference, operation);
    transaction.create(auditReference, {
      actorUid: admin.uid,
      actorEmail: admin.email,
      action: "credits.adjusted",
      targetType: "user",
      targetId: uid,
      metadata: { amount, previousBalance, newBalance, reason, ledgerId: ledgerReference.id },
      createdAt: timestamp,
    });
    return {
      uid,
      amount,
      previousBalance,
      newBalance,
      ledgerId: ledgerReference.id,
      auditLogId: auditReference.id,
      duplicate: false,
    };
  });

  const updatedUser = await userReference.get();
  const user = adminUserJson(uid, updatedUser.data() || { credits: result.newBalance });
  return {
    user,
    previousBalance: result.previousBalance,
    newBalance: result.newBalance,
    auditLogId: result.auditLogId,
    adjustment: result,
  };
}

export async function updateUserSuspension(
  request: ApiRequest,
  routeUid?: string,
): Promise<Record<string, unknown>> {
  const admin = await requireAdmin(request);
  const body = requireObject((await readBody(request)).value);
  const uidValue = routeUid || stringField(body, "uid", { required: true, max: 128 });
  if (!uidValue) throw new HttpError(400, "missing_uid", "uid is required.");
  const uid = validatedUid(uidValue);
  const suspended = booleanField(body, "suspended");
  const requestedStatus = stringField(body, "status", { max: 30 });
  const status = suspended !== undefined ? (suspended ? "suspended" : "active") : requestedStatus;
  if (status !== "active" && status !== "suspended") {
    throw new HttpError(400, "invalid_status", "Provide suspended or a status of active/suspended.");
  }
  if (uid === admin.uid && status === "suspended") {
    throw new HttpError(409, "cannot_suspend_self", "Administrators cannot suspend their own account.");
  }
  const reason = stringField(body, "reason", { max: 500 }) || null;

  try {
    await adminAuth().updateUser(uid, { disabled: status === "suspended" });
    if (status === "suspended") await adminAuth().revokeRefreshTokens(uid);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "auth/user-not-found") throw new HttpError(404, "user_not_found", "The selected Firebase user does not exist.");
    throw error;
  }

  const database = adminDb();
  const timestamp = FieldValue.serverTimestamp();
  const batch = database.batch();
  batch.set(
    database.collection(collections.users).doc(uid),
    {
      status,
      suspendedAt: status === "suspended" ? timestamp : null,
      suspensionReason: status === "suspended" ? reason : null,
      updatedAt: timestamp,
    },
    { merge: true },
  );
  batch.create(database.collection(collections.audit).doc(), {
    actorUid: admin.uid,
    actorEmail: admin.email,
    action: status === "suspended" ? "user.suspended" : "user.reactivated",
    targetType: "user",
    targetId: uid,
    metadata: { reason },
    createdAt: timestamp,
  });
  await batch.commit();
  const updatedUser = await database.collection(collections.users).doc(uid).get();
  return { user: adminUserJson(uid, updatedUser.data() || { status }) };
}

export async function createNotification(request: ApiRequest): Promise<Record<string, unknown>> {
  const admin = await requireAdmin(request);
  const body = requireObject((await readBody(request)).value);
  const title = stringField(body, "title", { required: true, max: 140 });
  const message = stringField(body, "message", { required: true, max: 5000 });
  if (!title || !message) throw new HttpError(400, "invalid_notification", "title and message are required.");
  const kind =
    stringField(body, "kind", { max: 30 }) ||
    stringField(body, "severity", { max: 30 }) ||
    "info";
  const audience = stringField(body, "audience", { max: 30 }) || "all";
  if (!new Set(["info", "success", "warning", "critical"]).has(kind)) {
    throw new HttpError(400, "invalid_kind", "Unsupported notification kind.");
  }
  if (!new Set(["all", "users", "admins", "selected"]).has(audience)) {
    throw new HttpError(400, "invalid_audience", "audience must be all, users, admins, or selected.");
  }
  const selectedUserIds = Array.isArray(body.selectedUserIds)
    ? body.selectedUserIds.map((value) => validatedUid(String(value))).slice(0, 500)
    : [];
  if (audience === "selected" && !selectedUserIds.length) {
    throw new HttpError(400, "missing_recipients", "selectedUserIds is required for selected notifications.");
  }
  const startsAtText = stringField(body, "startsAt", { max: 80 });
  const expiresAtText =
    stringField(body, "endsAt", { max: 80 }) ||
    stringField(body, "expiresAt", { max: 80 });
  let startsAt: Timestamp | null;
  let expiresAt: Timestamp | null;
  try {
    startsAt = timestampFromOptionalIso(startsAtText);
    expiresAt = timestampFromOptionalIso(expiresAtText);
  } catch {
    throw new HttpError(400, "invalid_schedule", "startsAt and expiresAt must be valid ISO timestamps.");
  }
  if (startsAt && expiresAt && expiresAt.toMillis() <= startsAt.toMillis()) {
    throw new HttpError(400, "invalid_schedule", "expiresAt must be later than startsAt.");
  }

  const database = adminDb();
  const reference = database.collection(collections.notifications).doc();
  const auditReference = database.collection(collections.audit).doc();
  const timestamp = FieldValue.serverTimestamp();
  const notification = {
    title,
    message,
    kind,
    audience,
    selectedUserIds,
    active: booleanField(body, "active") ?? true,
    startsAt,
    endsAt: expiresAt,
    actionLabel: stringField(body, "actionLabel", { max: 100 }) || null,
    actionUrl: validatedActionUrl(stringField(body, "actionUrl", { max: 500 })),
    createdBy: admin.uid,
    deliveryCount: 0,
    readCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const batch = database.batch();
  batch.create(reference, notification);
  batch.create(auditReference, {
    actorUid: admin.uid,
    actorEmail: admin.email,
    action: "notification.created",
    targetType: "notification",
    targetId: reference.id,
    metadata: { title, kind, audience, selectedUserCount: selectedUserIds.length },
    createdAt: timestamp,
  });
  await batch.commit();
  return notificationJson(reference.id, {
    ...notification,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  }, true);
}

function validatedActionUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_action_url", "Notification actionUrl must be a valid URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new HttpError(400, "invalid_action_url", "Notification actionUrl must use HTTP or HTTPS.");
  }
  return value;
}

export async function updateSupport(request: ApiRequest): Promise<Record<string, unknown>> {
  const admin = await requireAdmin(request);
  const body = requireObject((await readBody(request)).value);
  const support = {
    email: stringField(body, "email", { max: 254, allowEmpty: true }) || "",
    phone: stringField(body, "phone", { max: 80, allowEmpty: true }) || "",
    whatsapp: stringField(body, "whatsapp", { max: 120, allowEmpty: true }) || "",
    website: stringField(body, "website", { max: 500, allowEmpty: true }) || "",
    workingHours:
      stringField(body, "workingHours", { max: 300, allowEmpty: true }) ||
      stringField(body, "hours", { max: 300, allowEmpty: true }) ||
      "",
    helpCenterUrl: stringField(body, "helpCenterUrl", { max: 500, allowEmpty: true }) || "",
  };
  if (support.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support.email)) {
    throw new HttpError(400, "invalid_email", "Support email address is invalid.");
  }
  if (support.website) {
    let url: URL;
    try {
      url = new URL(support.website);
    } catch {
      throw new HttpError(400, "invalid_website", "Support website must be a valid URL.");
    }
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw new HttpError(400, "invalid_website", "Support website must use HTTP or HTTPS.");
    }
  }
  if (support.helpCenterUrl) {
    let url: URL;
    try {
      url = new URL(support.helpCenterUrl);
    } catch {
      throw new HttpError(400, "invalid_help_center", "Help center URL must be valid.");
    }
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw new HttpError(400, "invalid_help_center", "Help center URL must use HTTP or HTTPS.");
    }
  }

  const database = adminDb();
  const timestamp = FieldValue.serverTimestamp();
  const batch = database.batch();
  batch.set(
    database.collection(collections.config).doc("support"),
    { ...support, updatedAt: timestamp, updatedBy: admin.uid },
    { merge: true },
  );
  batch.create(database.collection(collections.audit).doc(), {
    actorUid: admin.uid,
    actorEmail: admin.email,
    action: "support.updated",
    targetType: "app_config",
    targetId: "support",
    metadata: support,
    createdAt: timestamp,
  });
  await batch.commit();
  return { ...support, updatedAt: new Date().toISOString(), updatedBy: admin.uid };
}
