export type UpdaterPhase =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export type UpdaterStatus = {
  ok: boolean;
  supported: boolean;
  phase: UpdaterPhase;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  progressPercent: number | null;
  lastCheckedAt: string | null;
  error: string | null;
  updateAvailable: boolean;
  canInstall: boolean;
};

const UPDATER_REQUEST_TIMEOUT_MS = 30_000;

export class UpdaterApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "UpdaterApiError";
    this.status = status;
  }
}

function optionalText(value: unknown) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function finiteNumber(value: unknown, fallback: number | null = null) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function updaterPhase(value: unknown): UpdaterPhase {
  const normalized = String(value || "idle");
  if (
    normalized === "idle" ||
    normalized === "checking" ||
    normalized === "up_to_date" ||
    normalized === "available" ||
    normalized === "downloading" ||
    normalized === "ready" ||
    normalized === "installing" ||
    normalized === "error"
  ) return normalized;
  return "error";
}

function normalizeUpdaterStatus(payload: unknown): UpdaterStatus {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const totalBytes = finiteNumber(value.totalBytes);
  const progress = finiteNumber(value.progressPercent);
  return {
    ok: value.ok !== false,
    supported: value.supported === true,
    phase: updaterPhase(value.phase),
    currentVersion: String(value.currentVersion || "Unknown"),
    latestVersion: optionalText(value.latestVersion),
    releaseName: optionalText(value.releaseName),
    releaseNotes: optionalText(value.releaseNotes),
    releaseUrl: optionalText(value.releaseUrl),
    downloadedBytes: Math.max(0, finiteNumber(value.downloadedBytes, 0) || 0),
    totalBytes: totalBytes === null ? null : Math.max(0, totalBytes),
    progressPercent: progress === null ? null : Math.max(0, Math.min(100, progress)),
    lastCheckedAt: optionalText(value.lastCheckedAt),
    error: optionalText(value.error),
    updateAvailable: value.updateAvailable === true,
    canInstall: value.canInstall === true,
  };
}

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as Record<string, unknown>;
  return String(value.error || value.message || fallback);
}

async function updaterRequest(path: string, token: string, method: "GET" | "POST") {
  if (!token.trim()) throw new UpdaterApiError("Sign in before checking for Morphly updates.", 401);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), UPDATER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
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
      throw new UpdaterApiError(errorMessage(payload, `The updater request failed (${response.status}).`), response.status);
    }
    return normalizeUpdaterStatus(payload);
  } catch (error) {
    if (error instanceof UpdaterApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new UpdaterApiError("The local updater did not respond in time.");
    }
    throw new UpdaterApiError(error instanceof Error ? error.message : "The local updater is unavailable.");
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getUpdaterStatus(token: string) {
  return updaterRequest("/api/morphly/updater/status", token, "GET");
}

export function checkForUpdaterUpdate(token: string) {
  return updaterRequest("/api/morphly/updater/check", token, "POST");
}

export function startUpdaterDownload(token: string) {
  return updaterRequest("/api/morphly/updater/download", token, "POST");
}

export function installUpdaterUpdate(token: string) {
  return updaterRequest("/api/morphly/updater/install", token, "POST");
}
