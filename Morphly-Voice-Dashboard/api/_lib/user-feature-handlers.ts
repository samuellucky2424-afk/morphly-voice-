import { FieldPath, FieldValue, Timestamp, type DocumentData, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { authenticate, type AuthenticatedUser } from "./auth.js";
import { adminDb, adminMessaging } from "./firebase-admin.js";
import {
  BILLING_CREDITS_PER_PERIOD,
  BILLING_PERIOD_SECONDS,
  collections,
  documentJson,
  loadActiveNotifications,
  loadBillingConfig,
  stableId,
} from "./data.js";
import {
  HttpError,
  booleanField,
  numericField,
  readBody,
  requireObject,
  stringField,
  type ApiRequest,
} from "./http.js";

const NOTIFICATION_RECEIPTS = "notification_receipts";
const PUSH_SUBSCRIPTIONS = "push_subscriptions";
const DEFAULT_PERIOD_SECONDS = BILLING_PERIOD_SECONDS;
const DEFAULT_CREDITS_PER_PERIOD = BILLING_CREDITS_PER_PERIOD;
const MAX_ACCEPTED_HEARTBEAT_GAP_MS = 15_000;
const USAGE_LEASE_MS = 20_000;
const PREPARED_USAGE_LEASE_MS = 120_000;
const PUSH_SUBSCRIPTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20;

type BillingSnapshot = {
  periodSeconds: number;
  creditsPerPeriod: number;
};

type UsageResult = {
  accepted: boolean;
  duplicate: boolean;
  allowed: boolean;
  status: string;
  creditsRemaining: number;
  chargedCredits: number;
  totalChargedCredits: number;
  billedPeriods: number;
  nextHeartbeatSeconds: number;
};

function safeSessionId(value: string | undefined): string {
  if (!value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new HttpError(400, "invalid_session_id", "sessionId is required and contains unsupported characters.");
  }
  return value;
}

function sessionReference(uid: string, sessionId: string) {
  return adminDb().collection(collections.sessions).doc(stableId(`${uid}:${sessionId}`));
}

function timestampMillis(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("toMillis" in value)) return null;
  const toMillis = (value as { toMillis?: () => number }).toMillis;
  return typeof toMillis === "function" ? toMillis.call(value) : null;
}

async function billingSnapshot(): Promise<BillingSnapshot> {
  const config = await loadBillingConfig();
  return {
    periodSeconds: config.periodSeconds,
    creditsPerPeriod: config.creditsPerPeriod,
  };
}

function usageFields(body: Record<string, unknown>) {
  const engineMode = stringField(body, "engineMode", { max: 30 }) || stringField(body, "engine", { max: 30 });
  if (engineMode !== "rvc" && engineMode !== "beatrice") {
    throw new HttpError(400, "invalid_engine_mode", "engineMode must be rvc or beatrice.");
  }
  return {
    engineMode,
    voiceName: stringField(body, "voiceName", { max: 160 }) || "",
    modelName: stringField(body, "modelName", { max: 200 }) || "",
    sampleRate: numericField(body, "sampleRate", { min: 0, max: 384_000, integer: true }) || 0,
    chunkSize: numericField(body, "chunkSize", { min: 0, max: 65_536, integer: true }) || 0,
    latencyMs: numericField(body, "latencyMs", { min: 0, max: 120_000 }) ?? null,
  };
}

export async function prepareUsageSession(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const sessionId = safeSessionId(stringField(body, "sessionId", { required: true, max: 160 }));
  const fields = usageFields(body);
  const billing = await billingSnapshot();
  const requestFingerprint = stableId(JSON.stringify({ fields, billing }));
  const database = adminDb();
  const userRef = database.collection(collections.users).doc(user.uid);
  const usageRef = sessionReference(user.uid, sessionId);

  const result = await database.runTransaction(async (transaction) => {
    const [userSnapshot, usageSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(usageRef),
    ]);
    const profile = userSnapshot.data() || {};
    const credits = Number.isSafeInteger(profile.credits) ? profile.credits : 0;
    const now = Timestamp.now();
    const activeLeaseExpiresAt = timestampMillis(profile.activeUsageExpiresAt) || 0;
    if (profile.activeUsageSessionId && profile.activeUsageSessionId !== sessionId && activeLeaseExpiresAt > Date.now()) {
      throw new HttpError(409, "usage_session_already_active", "Stop the active voice session before starting another one.");
    }
    const preparedLeaseExpiresAt = timestampMillis(profile.preparedUsageExpiresAt) || 0;
    if (profile.preparedUsageSessionId && profile.preparedUsageSessionId !== sessionId && preparedLeaseExpiresAt > Date.now()) {
      throw new HttpError(409, "usage_session_already_prepared", "Another voice session is already being prepared for this account.");
    }
    if (credits < billing.creditsPerPeriod) {
      throw new HttpError(402, "insufficient_credits", `At least ${billing.creditsPerPeriod} credits are required to start.`);
    }

    const expiredActiveSessionId = profile.activeUsageSessionId && profile.activeUsageSessionId !== sessionId
      && activeLeaseExpiresAt <= now.toMillis()
      ? String(profile.activeUsageSessionId)
      : null;
    const expiredPreparedSessionId = profile.preparedUsageSessionId && profile.preparedUsageSessionId !== sessionId
      && preparedLeaseExpiresAt <= now.toMillis()
      ? String(profile.preparedUsageSessionId)
      : null;
    const cleanupTargets = [
      ...(expiredActiveSessionId ? [{ kind: "stale", reference: sessionReference(user.uid, expiredActiveSessionId) }] : []),
      ...(expiredPreparedSessionId ? [{ kind: "cancelled", reference: sessionReference(user.uid, expiredPreparedSessionId) }] : []),
    ];
    const cleanupSnapshots = await Promise.all(cleanupTargets.map((target) => transaction.get(target.reference)));
    cleanupSnapshots.forEach((snapshot, index) => {
      if (!snapshot.exists || snapshot.data()?.uid !== user.uid) return;
      const target = cleanupTargets[index];
      const status = String(snapshot.data()?.status || "");
      if (target.kind === "stale" && status !== "live") return;
      if (target.kind === "cancelled" && status !== "prepared") return;
      transaction.update(target.reference, {
        status: target.kind,
        running: false,
        endedAt: now,
        updatedAt: now,
      });
    });
    if (usageSnapshot.exists) {
      const existing = usageSnapshot.data() || {};
      if (existing.uid !== user.uid || existing.clientSessionId !== sessionId) {
        throw new HttpError(409, "session_conflict", "This usage session conflicts with an existing record.");
      }
      if (!new Set(["prepared", "live"]).has(String(existing.status || ""))) {
        throw new HttpError(409, "session_already_finished", "Use a new sessionId for every voice connection.");
      }
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new HttpError(409, "session_request_conflict", "This sessionId was already prepared with different engine settings.");
      }
      return { duplicate: true, credits, status: String(existing.status || "prepared") };
    }

    transaction.create(usageRef, {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      clientSessionId: sessionId,
      requestFingerprint,
      ...fields,
      status: "prepared",
      running: false,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
      billing: {
        ...billing,
        remainderMs: 0,
        billedPeriods: 0,
        totalChargedCredits: 0,
        lastSequence: -1,
        lastHeartbeatAt: null,
      },
    });
    transaction.update(userRef, {
      ...(expiredActiveSessionId ? { activeUsageSessionId: null, activeUsageExpiresAt: null } : {}),
      preparedUsageSessionId: sessionId,
      preparedUsageExpiresAt: Timestamp.fromMillis(now.toMillis() + PREPARED_USAGE_LEASE_MS),
      updatedAt: now,
    });
    return { duplicate: false, credits, status: "prepared" };
  });

  return {
    accepted: true,
    sessionId,
    allowed: true,
    creditsRemaining: result.credits,
    status: result.status,
    duplicate: result.duplicate,
    billing,
  };
}

export async function activateUsageSession(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const sessionId = safeSessionId(stringField(body, "sessionId", { required: true, max: 160 }));
  const database = adminDb();
  const userRef = database.collection(collections.users).doc(user.uid);
  const usageRef = sessionReference(user.uid, sessionId);
  const firstPeriodLedgerRef = database.collection(collections.ledger).doc(
    stableId(`usage:${user.uid}:${sessionId}:1-1`),
  );

  const result = await database.runTransaction(async (transaction) => {
    const [userSnapshot, usageSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(usageRef),
    ]);
    if (!usageSnapshot.exists || usageSnapshot.data()?.uid !== user.uid) {
      throw new HttpError(404, "usage_session_not_found", "Prepare this usage session before activating it.");
    }
    const usage = usageSnapshot.data() || {};
    const billing = usage.billing || {};
    const required = Number.isSafeInteger(billing.creditsPerPeriod)
      ? billing.creditsPerPeriod
      : DEFAULT_CREDITS_PER_PERIOD;
    const credits = Number.isSafeInteger(userSnapshot.data()?.credits) ? userSnapshot.data()?.credits : 0;
    const profile = userSnapshot.data() || {};
    const activeLeaseExpiresAt = timestampMillis(profile.activeUsageExpiresAt) || 0;
    if (profile.activeUsageSessionId && profile.activeUsageSessionId !== sessionId && activeLeaseExpiresAt > Date.now()) {
      throw new HttpError(409, "usage_session_already_active", "Another voice session is already active for this account.");
    }
    const preparedLeaseExpiresAt = timestampMillis(profile.preparedUsageExpiresAt) || 0;
    if (profile.preparedUsageSessionId && profile.preparedUsageSessionId !== sessionId && preparedLeaseExpiresAt > Date.now()) {
      throw new HttpError(409, "usage_session_already_prepared", "A different voice session is currently being prepared.");
    }
    if (usage.status === "live") {
      const leaseValid = profile.activeUsageSessionId === sessionId && activeLeaseExpiresAt > Date.now();
      if (!leaseValid) {
        throw new HttpError(409, "usage_session_expired", "This usage authorization has expired. Start a new session.");
      }
      return { duplicate: true, credits, startedAt: usage.startedAt };
    }
    if (credits < required) {
      throw new HttpError(402, "insufficient_credits", `At least ${required} credits are required to start.`);
    }
    if (usage.status !== "prepared") {
      throw new HttpError(409, "usage_session_not_prepared", "This usage session can no longer be activated.");
    }
    if (profile.preparedUsageSessionId !== sessionId || preparedLeaseExpiresAt <= Date.now()) {
      throw new HttpError(409, "usage_session_expired", "This prepared usage session has expired. Start again.");
    }
    const now = Timestamp.now();
    const newCredits = credits - required;
    transaction.create(firstPeriodLedgerRef, {
      uid: user.uid,
      type: "usage_charge",
      amount: -required,
      previousBalance: credits,
      newBalance: newCredits,
      sessionId,
      periodSeconds: Number.isSafeInteger(billing.periodSeconds) ? billing.periodSeconds : DEFAULT_PERIOD_SECONDS,
      creditsPerPeriod: required,
      periods: 1,
      firstPeriod: 1,
      lastPeriod: 1,
      billingModel: "prepaid_blocks",
      createdAt: now,
    });
    transaction.update(usageRef, {
      status: "live",
      running: true,
      startedAt: now,
      updatedAt: now,
      "billing.billingModel": "prepaid_blocks",
      "billing.billedPeriods": 1,
      "billing.totalChargedCredits": required,
      "billing.lastHeartbeatAt": now,
      "billing.lastSequence": 0,
    });
    transaction.update(userRef, {
      credits: newCredits,
      activeUsageSessionId: sessionId,
      activeUsageExpiresAt: Timestamp.fromMillis(now.toMillis() + USAGE_LEASE_MS),
      preparedUsageSessionId: null,
      preparedUsageExpiresAt: null,
      updatedAt: now,
    });
    return { duplicate: false, credits: newCredits, startedAt: now };
  });

  return {
    accepted: true,
    sessionId,
    allowed: true,
    creditsRemaining: result.credits,
    status: "live",
    duplicate: result.duplicate,
    startedAt: result.startedAt instanceof Timestamp ? result.startedAt.toDate().toISOString() : null,
    nextHeartbeatSeconds: 5,
  };
}

export async function heartbeatUsageSession(request: ApiRequest): Promise<Record<string, unknown>> {
  return processUsageTick(request, false);
}

export async function stopUsageSession(request: ApiRequest): Promise<Record<string, unknown>> {
  return processUsageTick(request, true);
}

async function processUsageTick(request: ApiRequest, ending: boolean): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const sessionId = safeSessionId(stringField(body, "sessionId", { required: true, max: 160 }));
  const sequence = numericField(body, "sequence", { required: true, min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  if (sequence === undefined) throw new HttpError(400, "missing_sequence", "sequence is required.");
  const result = await runUsageTick(user, sessionId, sequence, ending, body);
  return { sessionId, ...result };
}

async function runUsageTick(
  user: AuthenticatedUser,
  sessionId: string,
  sequence: number,
  ending: boolean,
  body: Record<string, unknown>,
): Promise<UsageResult> {
  const database = adminDb();
  const userRef = database.collection(collections.users).doc(user.uid);
  const usageRef = sessionReference(user.uid, sessionId);

  return database.runTransaction(async (transaction) => {
    const [userSnapshot, usageSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(usageRef),
    ]);
    if (!usageSnapshot.exists || usageSnapshot.data()?.uid !== user.uid) {
      throw new HttpError(404, "usage_session_not_found", "The usage session was not found for this account.");
    }
    const usage = usageSnapshot.data() || {};
    const billing = (usage.billing || {}) as DocumentData;
    const periodSeconds = Number.isSafeInteger(billing.periodSeconds) ? billing.periodSeconds : DEFAULT_PERIOD_SECONDS;
    const creditsPerPeriod = Number.isSafeInteger(billing.creditsPerPeriod)
      ? billing.creditsPerPeriod
      : DEFAULT_CREDITS_PER_PERIOD;
    const currentCredits = Number.isSafeInteger(userSnapshot.data()?.credits) ? userSnapshot.data()?.credits : 0;
    const profile = userSnapshot.data() || {};
    const lastSequence = Number.isSafeInteger(billing.lastSequence) ? billing.lastSequence : -1;
    const totalChargedCredits = Number.isSafeInteger(billing.totalChargedCredits) ? billing.totalChargedCredits : 0;
    const billedPeriods = Number.isSafeInteger(billing.billedPeriods) ? billing.billedPeriods : 0;
    const forceTerminalSequence = ending && new Set(["prepared", "live"]).has(String(usage.status || ""));
    const effectiveSequence = forceTerminalSequence ? lastSequence + 1 : sequence;

    if (!forceTerminalSequence && sequence === lastSequence) {
      const activeLeaseExpiresAt = timestampMillis(profile.activeUsageExpiresAt) || 0;
      const leaseValid = profile.activeUsageSessionId === sessionId && activeLeaseExpiresAt > Date.now();
      // A prepaid block remains authorized even when it used the account's
      // final credits. Duplicate delivery must therefore depend on the live
      // lease, not on spare balance, and must not extend that lease.
      const duplicateAllowed = usage.status === "live" && leaseValid;
      if (usage.status === "live" && !duplicateAllowed) {
        const now = Timestamp.now();
        transaction.update(usageRef, { status: "stale", running: false, endedAt: now, updatedAt: now });
        if (profile.activeUsageSessionId === sessionId) {
          transaction.update(userRef, { activeUsageSessionId: null, activeUsageExpiresAt: null, updatedAt: now });
        }
      }
      return {
        accepted: true,
        duplicate: true,
        allowed: duplicateAllowed,
        status: duplicateAllowed ? "live" : usage.status === "live" ? "stale" : String(usage.status || "ended"),
        creditsRemaining: currentCredits,
        chargedCredits: 0,
        totalChargedCredits,
        billedPeriods,
        nextHeartbeatSeconds: 5,
      };
    }
    if (!forceTerminalSequence && sequence !== lastSequence + 1) {
      throw new HttpError(409, "invalid_usage_sequence", `Expected usage sequence ${lastSequence + 1}.`);
    }

    if (usage.status === "live" && profile.activeUsageSessionId && profile.activeUsageSessionId !== sessionId) {
      const now = Timestamp.now();
      transaction.update(usageRef, {
        status: "superseded",
        running: false,
        endedAt: now,
        updatedAt: now,
        "billing.lastSequence": effectiveSequence,
      });
      return {
        accepted: true,
        duplicate: false,
        allowed: false,
        status: "superseded",
        creditsRemaining: currentCredits,
        chargedCredits: 0,
        totalChargedCredits,
        billedPeriods,
        nextHeartbeatSeconds: 5,
      };
    }

    if (usage.status !== "live") {
      if (ending && usage.status === "prepared") {
        const now = Timestamp.now();
        transaction.update(usageRef, {
          status: "cancelled",
          running: false,
          endedAt: now,
          updatedAt: now,
          "billing.lastSequence": effectiveSequence,
        });
        if (profile.preparedUsageSessionId === sessionId) {
          transaction.update(userRef, {
            preparedUsageSessionId: null,
            preparedUsageExpiresAt: null,
            updatedAt: now,
          });
        }
        return {
          accepted: true,
          duplicate: false,
          allowed: false,
          status: "cancelled",
          creditsRemaining: currentCredits,
          chargedCredits: 0,
          totalChargedCredits,
          billedPeriods,
          nextHeartbeatSeconds: 5,
        };
      }
      return {
        accepted: true,
        duplicate: false,
        allowed: false,
        status: String(usage.status || "ended"),
        creditsRemaining: currentCredits,
        chargedCredits: 0,
        totalChargedCredits,
        billedPeriods,
        nextHeartbeatSeconds: 5,
      };
    }

    const now = Timestamp.now();
    const lastHeartbeatMs = timestampMillis(billing.lastHeartbeatAt) ?? now.toMillis();
    const rawElapsedMs = Math.max(0, now.toMillis() - lastHeartbeatMs);
    const staleHeartbeat = rawElapsedMs > MAX_ACCEPTED_HEARTBEAT_GAP_MS;
    const elapsedMs = Math.min(rawElapsedMs, MAX_ACCEPTED_HEARTBEAT_GAP_MS);
    const previousRemainder = Number.isFinite(Number(billing.remainderMs)) ? Math.max(0, Number(billing.remainderMs)) : 0;
    const periodMs = periodSeconds * 1000;
    const accumulatedMs = previousRemainder + elapsedMs;
    // Activation prepays the first 10-second block. While live, crossing a
    // boundary prepays the next block; on an explicit stop, exactly reaching
    // the boundary does not buy a block the user will not consume.
    const billableAccumulatedMs = ending ? Math.max(0, accumulatedMs - 1) : accumulatedMs;
    const completedPeriods = Math.floor(billableAccumulatedMs / periodMs);
    const affordablePeriods = Math.floor(currentCredits / creditsPerPeriod);
    const chargedPeriods = Math.min(completedPeriods, affordablePeriods);
    const chargedCredits = chargedPeriods * creditsPerPeriod;
    const newCredits = currentCredits - chargedCredits;
    const nextBilledPeriods = billedPeriods + chargedPeriods;
    const nextTotalCharged = totalChargedCredits + chargedCredits;
    const insufficientForCompletedPeriod = completedPeriods > chargedPeriods;
    const allowed = !ending && !staleHeartbeat && !insufficientForCompletedPeriod;
    const status = staleHeartbeat ? "stale" : ending ? "completed" : allowed ? "live" : "credit_exhausted";
    const remainderMs = insufficientForCompletedPeriod ? 0 : accumulatedMs - chargedPeriods * periodMs;
    const startedAtMs = timestampMillis(usage.startedAt) ?? now.toMillis();
    const durationSeconds = Math.max(0, Math.round((now.toMillis() - startedAtMs) / 1000));

    if (chargedCredits > 0) {
      const ledgerRef = database.collection(collections.ledger).doc(
        stableId(`usage:${user.uid}:${sessionId}:${billedPeriods + 1}-${nextBilledPeriods}`),
      );
      transaction.create(ledgerRef, {
        uid: user.uid,
        type: "usage_charge",
        amount: -chargedCredits,
        previousBalance: currentCredits,
        newBalance: newCredits,
        sessionId,
        periodSeconds,
        creditsPerPeriod,
        periods: chargedPeriods,
        firstPeriod: billedPeriods + 1,
        lastPeriod: nextBilledPeriods,
        createdAt: now,
      });
    }

    const shouldEnd = ending || !allowed;
    transaction.update(userRef, {
      ...(chargedCredits > 0 ? {
        credits: newCredits,
        totalUsageSeconds: FieldValue.increment(chargedPeriods * periodSeconds),
      } : {}),
      activeUsageSessionId: shouldEnd ? null : sessionId,
      activeUsageExpiresAt: shouldEnd ? null : Timestamp.fromMillis(now.toMillis() + USAGE_LEASE_MS),
      updatedAt: now,
    });
    transaction.update(usageRef, {
      status,
      running: !shouldEnd,
      latencyMs: numericField(body, "latencyMs", { min: 0, max: 120_000 }) ?? usage.latencyMs ?? null,
      updatedAt: now,
      ...(shouldEnd ? { endedAt: now, durationSeconds } : {}),
      "billing.remainderMs": remainderMs,
      "billing.billedPeriods": nextBilledPeriods,
      "billing.totalChargedCredits": nextTotalCharged,
      "billing.lastSequence": effectiveSequence,
      "billing.lastHeartbeatAt": now,
    });

    return {
      accepted: true,
      duplicate: false,
      allowed,
      status,
      creditsRemaining: newCredits,
      chargedCredits,
      totalChargedCredits: nextTotalCharged,
      billedPeriods: nextBilledPeriods,
      nextHeartbeatSeconds: 5,
    };
  });
}

export async function userSessions(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  await reconcileExpiredUsageForUser(user.uid);
  const snapshot = await adminDb()
    .collection(collections.sessions)
    .where("uid", "==", user.uid)
    .orderBy("startedAt", "desc")
    .get();
  const sessions = snapshot.docs
    .filter((document) => {
      const session = document.data();
      return !session.hiddenByUserAt && !new Set(["prepared", "live"]).has(String(session.status || ""));
    })
    .map((document) => documentJson(document))
    .slice(0, 50);
  return { items: sessions, sessions, total: sessions.length };
}

export async function clearUserSessions(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  await reconcileExpiredUsageForUser(user.uid);
  const snapshot = await adminDb().collection(collections.sessions).where("uid", "==", user.uid).get();
  const batch = adminDb().batch();
  const now = FieldValue.serverTimestamp();
  const hideable = snapshot.docs.filter((document) =>
    !document.data().hiddenByUserAt && !new Set(["prepared", "live"]).has(String(document.data().status || "")),
  );
  const currentBatch = hideable.slice(0, 450);
  currentBatch.forEach((document) => batch.update(document.ref, { hiddenByUserAt: now, updatedAt: now }));
  if (currentBatch.length) await batch.commit();
  return { hidden: currentBatch.length, deleted: 0, moreRemaining: hideable.length > currentBatch.length };
}

export async function loadUserNotifications(user: AuthenticatedUser): Promise<Record<string, unknown>[]> {
  const notifications = await loadActiveNotifications(20, user.role, user.uid);
  if (!notifications.length) return [];
  const receiptRefs = notifications.map((notification) =>
    adminDb().collection(NOTIFICATION_RECEIPTS).doc(stableId(`${user.uid}:${String(notification.id)}`)),
  );
  const receiptSnapshots = await adminDb().getAll(...receiptRefs);
  return notifications.map((notification, index) => {
    const receipt = receiptSnapshots[index]?.data() || {};
    return {
      ...notification,
      isRead: Boolean(receipt.readAt),
      readAt: receipt.readAt && typeof receipt.readAt.toDate === "function"
        ? receipt.readAt.toDate().toISOString()
        : null,
    };
  });
}

export async function userNotifications(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const notifications = await loadUserNotifications(user);
  return {
    notifications,
    unreadCount: notifications.filter((notification) => !notification.isRead).length,
  };
}

export async function markNotificationsRead(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const requestedIds = Array.isArray(body.notificationIds)
    ? [...new Set(body.notificationIds.filter((value): value is string => typeof value === "string"))].slice(0, 50)
    : [];
  const all = booleanField(body, "all") ?? requestedIds.length === 0;
  const eligible = await loadActiveNotifications(50, user.role, user.uid);
  const eligibleIds = new Set(eligible.map((notification) => String(notification.id)));
  const ids = (all ? [...eligibleIds] : requestedIds.filter((id) => eligibleIds.has(id))).slice(0, 50);
  if (!ids.length) return { markedRead: 0 };

  const database = adminDb();
  const markedRead = await database.runTransaction(async (transaction) => {
    const receiptRefs = ids.map((id) => database.collection(NOTIFICATION_RECEIPTS).doc(stableId(`${user.uid}:${id}`)));
    const receiptSnapshots = await Promise.all(receiptRefs.map((reference) => transaction.get(reference)));
    const now = Timestamp.now();
    let count = 0;
    receiptSnapshots.forEach((snapshot, index) => {
      if (snapshot.data()?.readAt) return;
      const notificationId = ids[index];
      transaction.set(receiptRefs[index], {
        uid: user.uid,
        notificationId,
        deliveredAt: snapshot.data()?.deliveredAt || now,
        readAt: now,
        updatedAt: now,
      }, { merge: true });
      transaction.update(database.collection(collections.notifications).doc(notificationId), {
        readCount: FieldValue.increment(1),
      });
      count += 1;
    });
    return count;
  });
  return { markedRead };
}

export async function registerPushToken(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const token = stringField(body, "token", { required: true, max: 4096 });
  const deviceId = stringField(body, "deviceId", { required: true, max: 160 });
  if (!token || !deviceId) throw new HttpError(400, "invalid_push_subscription", "token and deviceId are required.");
  const database = adminDb();
  // One document per FCM token prevents a caller from multiplying delivery by
  // replaying the same token under arbitrary device IDs.
  const reference = database.collection(PUSH_SUBSCRIPTIONS).doc(stableId(`token:${token}`));
  const existing = await reference.get();
  if (!existing.exists || existing.data()?.uid !== user.uid) {
    const owned = await database.collection(PUSH_SUBSCRIPTIONS)
      .where("uid", "==", user.uid)
      .limit(MAX_PUSH_SUBSCRIPTIONS_PER_USER)
      .get();
    if (owned.size >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
      throw new HttpError(429, "push_subscription_limit", "Too many notification devices are registered for this account.");
    }
  }
  const now = Timestamp.now();
  await reference.set({
    uid: user.uid,
    role: user.role,
    email: user.email,
    deviceId,
    token,
    active: true,
    userAgent: stringField(body, "userAgent", { max: 500 }) || null,
    expiresAt: Timestamp.fromMillis(now.toMillis() + PUSH_SUBSCRIPTION_TTL_MS),
    updatedAt: now,
    ...(!existing.exists ? { createdAt: now } : {}),
  }, { merge: true });
  return { registered: true };
}

export async function unregisterPushToken(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const deviceId = stringField(body, "deviceId", { required: true, max: 160 });
  if (!deviceId) throw new HttpError(400, "invalid_push_subscription", "deviceId is required.");
  const database = adminDb();
  const snapshot = await database.collection(PUSH_SUBSCRIPTIONS).where("uid", "==", user.uid).limit(100).get();
  const matches = snapshot.docs.filter((document) => document.data().deviceId === deviceId);
  if (matches.length) {
    const batch = database.batch();
    matches.forEach((document) => batch.delete(document.ref));
    await batch.commit();
  }
  return { unregistered: true, removed: matches.length };
}

export const pushSubscriptionCollection = PUSH_SUBSCRIPTIONS;

async function reconcileExpiredUsageForUser(uid: string): Promise<void> {
  const database = adminDb();
  const userRef = database.collection(collections.users).doc(uid);
  await database.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) return;
    const profile = userSnapshot.data() || {};
    const now = Timestamp.now();
    const activeSessionId = profile.activeUsageSessionId && (timestampMillis(profile.activeUsageExpiresAt) || 0) <= now.toMillis()
      ? String(profile.activeUsageSessionId)
      : null;
    const preparedSessionId = profile.preparedUsageSessionId && (timestampMillis(profile.preparedUsageExpiresAt) || 0) <= now.toMillis()
      ? String(profile.preparedUsageSessionId)
      : null;
    const targets = [
      ...(activeSessionId ? [{ kind: "stale", reference: sessionReference(uid, activeSessionId) }] : []),
      ...(preparedSessionId ? [{ kind: "cancelled", reference: sessionReference(uid, preparedSessionId) }] : []),
    ];
    if (!targets.length) return;
    const snapshots = await Promise.all(targets.map((target) => transaction.get(target.reference)));
    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists || snapshot.data()?.uid !== uid) return;
      const target = targets[index];
      const data = snapshot.data() || {};
      const currentStatus = String(data.status || "");
      if (target.kind === "stale" && currentStatus !== "live") return;
      if (target.kind === "cancelled" && currentStatus !== "prepared") return;
      const startedAt = timestampMillis(data.startedAt);
      transaction.update(target.reference, {
        status: target.kind,
        running: false,
        endedAt: now,
        ...(startedAt !== null ? { durationSeconds: Math.max(0, Math.round((now.toMillis() - startedAt) / 1000)) } : {}),
        updatedAt: now,
      });
    });
    transaction.update(userRef, {
      ...(activeSessionId ? { activeUsageSessionId: null, activeUsageExpiresAt: null } : {}),
      ...(preparedSessionId ? { preparedUsageSessionId: null, preparedUsageExpiresAt: null } : {}),
      updatedAt: now,
    });
  });
}

export async function deliverNotificationPush(input: {
  notificationId: string;
  title: string;
  message: string;
  audience: string;
  selectedUserIds: string[];
  actionUrl: string | null;
}): Promise<{ attempted: number; delivered: number; failed: number }> {
  const configuredAppUrl = String(process.env.MORPHLY_APP_URL || "https://morphly-voice.vercel.app").replace(/\/+$/, "");
  const webLink = input.actionUrl?.startsWith("http://") || input.actionUrl?.startsWith("https://")
    ? input.actionUrl
    : configuredAppUrl;
  const database = adminDb();
  const subscriptionDocuments: QueryDocumentSnapshot[] = [];
  let cursor: QueryDocumentSnapshot | null = null;
  // Page rather than silently dropping every subscriber after the first 1000.
  for (let page = 0; page < 20; page += 1) {
    let query = database.collection(PUSH_SUBSCRIPTIONS)
      .where("active", "==", true)
      .orderBy(FieldPath.documentId())
      .limit(500);
    if (cursor) query = query.startAfter(cursor);
    const pageSnapshot = await query.get();
    subscriptionDocuments.push(...pageSnapshot.docs);
    if (pageSnapshot.size < 500) break;
    cursor = pageSnapshot.docs[pageSnapshot.docs.length - 1] || null;
  }
  const unexpiredSubscriptions = subscriptionDocuments.filter((document) => {
    const expiresAt = timestampMillis(document.data().expiresAt);
    return expiresAt !== null && expiresAt > Date.now();
  });
  const subscriptionUids = [...new Set(unexpiredSubscriptions.map((document) => String(document.data().uid || "")).filter(Boolean))];
  const userSnapshots = subscriptionUids.length
    ? await adminDb().getAll(...subscriptionUids.map((uid) => adminDb().collection(collections.users).doc(uid)))
    : [];
  const currentProfiles = new Map(userSnapshots.map((snapshot) => [snapshot.id, snapshot.data() || {}]));
  const selected = new Set(input.selectedUserIds);
  const uniqueTokens = new Set<string>();
  const subscriptions = unexpiredSubscriptions.filter((document) => {
    const subscription = document.data();
    if (!subscription.token || typeof subscription.token !== "string") return false;
    if (uniqueTokens.has(subscription.token)) return false;
    const uid = String(subscription.uid || "");
    const profile = currentProfiles.get(uid);
    if (!profile || profile.status === "suspended" || profile.status === "disabled") return false;
    const currentRole = profile.role === "admin" ? "admin" : "user";
    const eligible = input.audience === "admins"
      ? currentRole === "admin"
      : input.audience === "users"
        ? currentRole === "user"
        : input.audience === "selected"
          ? selected.has(uid)
          : true;
    if (eligible) uniqueTokens.add(subscription.token);
    return eligible;
  });
  let delivered = 0;
  let failed = 0;
  for (let offset = 0; offset < subscriptions.length; offset += 500) {
    const chunk = subscriptions.slice(offset, offset + 500);
    const response = await adminMessaging().sendEachForMulticast({
      tokens: chunk.map((document) => String(document.data().token)),
      // Keep background content generic on shared machines. The authenticated
      // inbox fetch reveals the actual audience-scoped notification.
      notification: { title: "Morphly Voice", body: "You have a new notification." },
      data: {
        notificationId: input.notificationId,
        actionUrl: input.actionUrl || "/",
      },
      webpush: {
        fcmOptions: { link: webLink },
      },
    });
    delivered += response.successCount;
    failed += response.failureCount;

    const invalidReferences = response.responses
      .map((item, index) => ({ item, reference: chunk[index]?.ref }))
      .filter(({ item }) => {
        const code = item.error?.code || "";
        return code.includes("registration-token-not-registered") || code.includes("invalid-registration-token");
      })
      .map(({ reference }) => reference)
      .filter((reference): reference is NonNullable<typeof reference> => Boolean(reference));
    if (invalidReferences.length) {
      const batch = adminDb().batch();
      invalidReferences.forEach((reference) => batch.delete(reference));
      await batch.commit();
    }
  }
  return { attempted: subscriptions.length, delivered, failed };
}
