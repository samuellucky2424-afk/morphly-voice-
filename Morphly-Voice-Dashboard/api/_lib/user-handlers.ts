import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { authenticate, publicSessionUser } from "./auth";
import { adminDb } from "./firebase-admin";
import { collections, loadActiveNotifications, loadSupport, stableId } from "./data";
import {
  HttpError,
  booleanField,
  numericField,
  readBody,
  requireObject,
  stringField,
  type ApiRequest,
} from "./http";

export async function sessionBootstrap(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = request.method === "POST" ? requireObject((await readBody(request)).value) : {};
  const appVersion = stringField(body, "appVersion", { max: 80 });
  const deviceId = stringField(body, "deviceId", { max: 160 });
  const platform = stringField(body, "platform", { max: 80 });

  if (appVersion || deviceId || platform) {
    await adminDb().collection(collections.users).doc(user.uid).set(
      {
        lastClient: {
          appVersion: appVersion || null,
          deviceId: deviceId || null,
          platform: platform || null,
        },
        lastSeenAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  const [support, notifications] = await Promise.all([
    loadSupport(),
    loadActiveNotifications(20, user.role, user.uid),
  ]);
  const session = publicSessionUser(user);
  return {
    session,
    user: session,
    support,
    notifications,
    serverTime: new Date().toISOString(),
  };
}

export async function userSupport(request: ApiRequest): Promise<Record<string, unknown>> {
  await authenticate(request);
  return await loadSupport();
}

export async function telemetryHeartbeat(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const engineMode =
    stringField(body, "engineMode", { max: 30 }) ||
    stringField(body, "engine", { max: 30 }) ||
    "unknown";
  if (!new Set(["rvc", "beatrice", "unknown"]).has(engineMode)) {
    throw new HttpError(400, "invalid_engine_mode", "engineMode must be rvc or beatrice.");
  }

  const status = stringField(body, "status", { max: 30 }) || null;
  if (status && !new Set(["starting", "live", "idle", "ended", "error"]).has(status)) {
    throw new HttpError(400, "invalid_status", "Unsupported heartbeat status.");
  }
  const running = booleanField(body, "running") ?? (status === "starting" || status === "live");
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + 120_000);
  const presenceReference = adminDb().collection(collections.presence).doc(user.uid);
  const previousPresence = await presenceReference.get();
  const previous = previousPresence.data() || {};
  const sessionId = stringField(body, "sessionId", { max: 160 }) || null;
  const presence = {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    engineMode,
    engine: engineMode,
    running,
    status: status || (running ? "live" : "idle"),
    sessionId,
    voiceName: stringField(body, "voiceName", { max: 160 }) || null,
    modelName: stringField(body, "modelName", { max: 200 }) || null,
    appVersion: stringField(body, "appVersion", { max: 80 }) || null,
    platform: stringField(body, "platform", { max: 80 }) || null,
    deviceId: stringField(body, "deviceId", { max: 160 }) || null,
    latencyMs: numericField(body, "latencyMs", { min: 0, max: 120_000 }) ?? null,
    sampleRate: numericField(body, "sampleRate", { min: 0, max: 384_000, integer: true }) ?? null,
    chunkSize: numericField(body, "chunkSize", { min: 0, max: 65_536, integer: true }) ?? null,
    cpuPercent: numericField(body, "cpuPercent", { min: 0, max: 100 }) ?? null,
    memoryMb: numericField(body, "memoryMb", { min: 0, max: 1_048_576 }) ?? null,
    startedAt: previous.sessionId === sessionId && previous.startedAt ? previous.startedAt : now,
    lastSeenAt: now,
    expiresAt,
  };

  const database = adminDb();
  const batch = database.batch();
  batch.set(presenceReference, presence, { merge: true });
  batch.set(
    database.collection(collections.users).doc(user.uid),
    { lastSeenAt: now, updatedAt: now, lastEngineMode: engineMode },
    { merge: true },
  );
  await batch.commit();

  return { accepted: true, nextHeartbeatSeconds: 30, expiresAt: expiresAt.toDate().toISOString() };
}

export async function telemetryEvent(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const type = stringField(body, "type", { max: 80 }) || stringField(body, "event", { required: true, max: 80 });
  if (!type || !/^[A-Za-z0-9._:-]{1,80}$/.test(type)) {
    throw new HttpError(400, "invalid_event", "event contains unsupported characters.");
  }

  const sessionId = stringField(body, "sessionId", { max: 160 }) || null;
  const severity =
    stringField(body, "severity", { max: 20 }) ||
    stringField(body, "level", { max: 20 }) ||
    (type.endsWith("error") ? "error" : "info");
  if (!new Set(["debug", "info", "warning", "error", "critical"]).has(severity)) {
    throw new HttpError(400, "invalid_severity", "level must be debug, info, warning, error, or critical.");
  }

  const details = safeTelemetryDetails(body.details || body.metadata);
  const engineMode =
    stringField(body, "engineMode", { max: 30 }) ||
    stringField(body, "engine", { max: 30 }) ||
    null;
  const category = stringField(body, "category", { max: 80 }) || "client";
  const now = Timestamp.now();
  const database = adminDb();
  const log = await database.collection(collections.logs).add({
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    type,
    event: type,
    severity,
    level: severity,
    category,
    message: stringField(body, "message", { max: 1000 }) || null,
    engineMode,
    engine: engineMode,
    sessionId,
    appVersion: stringField(body, "appVersion", { max: 80 }) || null,
    details,
    createdAt: now,
  });

  if (sessionId && new Set(["session_started", "session.started", "session_stopped", "session.stopped"]).has(type)) {
    const reference = database.collection(collections.sessions).doc(stableId(`${user.uid}:${sessionId}`));
    const common = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      clientSessionId: sessionId,
      engineMode,
      voiceName: stringField(body, "voiceName", { max: 160 }) || null,
      modelName: stringField(body, "modelName", { max: 200 }) || null,
      updatedAt: now,
    };
    if (type === "session_started" || type === "session.started") {
      await reference.set({ ...common, status: "live", startedAt: now }, { merge: true });
    } else {
      await reference.set(
        {
          ...common,
          status: "completed",
          endedAt: now,
          durationSeconds: numericField(body, "durationSeconds", { min: 0, max: 2_592_000 }) ?? null,
          latencyMs: numericField(body, "latencyMs", { min: 0, max: 120_000 }) ?? null,
        },
        { merge: true },
      );
    }
  }

  return { accepted: true, eventId: log.id };
}

function safeTelemetryDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (serialized.length > 10_000) {
    throw new HttpError(400, "details_too_large", "Telemetry details cannot exceed 10 KB.");
  }
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  return sanitizeTelemetryObject(parsed);
}

const SENSITIVE_TELEMETRY_KEY =
  /(password|token|secret|authorization|cookie|credential|private.?key|raw.?audio|audio.?data)/i;

function sanitizeTelemetryObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_TELEMETRY_KEY.test(key))
      .map(([key, item]) => [key, sanitizeTelemetryValue(item)]),
  );
}

function sanitizeTelemetryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTelemetryValue);
  if (value && typeof value === "object") {
    return sanitizeTelemetryObject(value as Record<string, unknown>);
  }
  return value;
}
