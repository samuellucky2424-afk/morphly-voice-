import type { IncomingMessage, ServerResponse } from "node:http";

export type ApiRequest = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
};

export type ApiResponse = ServerResponse;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:18000",
  "http://127.0.0.1:18000",
];

const MAX_BODY_BYTES = 1024 * 1024;

export function configuredAllowedOrigins(): Set<string> {
  const configured = (process.env.APP_ALLOWED_ORIGINS || process.env.MORPHLY_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

export function applyCors(request: ApiRequest, response: ApiResponse): boolean {
  const origin = request.headers.origin?.replace(/\/$/, "");
  if (!origin) return true;

  if (!configuredAllowedOrigins().has(origin)) return false;

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Idempotency-Key, X-Requested-With",
  );
  response.setHeader("Access-Control-Max-Age", "600");
  return true;
}

export function sendJson(response: ApiResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.end(body);
}

export function sendSuccess(response: ApiResponse, payload: Record<string, unknown> = {}, status = 200): void {
  sendJson(response, status, { ok: true, data: payload });
}

export function methodNotAllowed(response: ApiResponse, allowed: string[]): void {
  response.setHeader("Allow", allowed.join(", "));
  sendJson(response, 405, {
    ok: false,
    error: { code: "method_not_allowed", message: "Method not allowed." },
  });
}

export function handleError(response: ApiResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(response, error.status, {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  console.error("[Morphly API] Unhandled request failure", error);
  sendJson(response, 500, {
    ok: false,
    error: { code: "internal_error", message: "The server could not complete this request." },
  });
}

export async function readBody(request: ApiRequest): Promise<{ value: unknown; raw: Buffer }> {
  if (request.body !== undefined) {
    if (Buffer.isBuffer(request.body)) {
      return { value: parseJsonBuffer(request.body), raw: request.body };
    }
    if (typeof request.body === "string") {
      const raw = Buffer.from(request.body, "utf8");
      return { value: parseJsonBuffer(raw), raw };
    }
    const raw = Buffer.from(JSON.stringify(request.body), "utf8");
    return { value: request.body, raw };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "body_too_large", "Request body exceeds the 1 MB limit.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  return { value: raw.length ? parseJsonBuffer(raw) : {}, raw };
}

function parseJsonBuffer(raw: Buffer): unknown {
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must contain valid JSON.");
  }
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function stringField(
  body: Record<string, unknown>,
  field: string,
  options: { required?: boolean; max?: number; allowEmpty?: boolean } = {},
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (options.required) throw new HttpError(400, "missing_field", `${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_field", `${field} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized && options.required && !options.allowEmpty) {
    throw new HttpError(400, "invalid_field", `${field} cannot be empty.`);
  }
  const maximum = options.max ?? 500;
  if (normalized.length > maximum) {
    throw new HttpError(400, "invalid_field", `${field} cannot exceed ${maximum} characters.`);
  }
  return normalized;
}

export function numericField(
  body: Record<string, unknown>,
  field: string,
  options: { required?: boolean; min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) throw new HttpError(400, "missing_field", `${field} is required.`);
    return undefined;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || (options.integer && !Number.isInteger(value))) {
    throw new HttpError(400, "invalid_field", `${field} must be a valid number.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new HttpError(400, "invalid_field", `${field} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new HttpError(400, "invalid_field", `${field} cannot exceed ${options.max}.`);
  }
  return value;
}

export function booleanField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_field", `${field} must be true or false.`);
  }
  return value;
}

export function requestUrl(request: ApiRequest): URL {
  return new URL(request.url || "/", "https://morphly.local");
}

export function boundedLimit(url: URL, fallback = 50, maximum = 100): number {
  const parsed = Number(url.searchParams.get("limit") || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
