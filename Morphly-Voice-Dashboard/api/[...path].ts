import {
  adjustCredits,
  adminLive,
  adminLogs,
  adminNotifications,
  adminOverview,
  adminPurchases,
  adminSupport,
  adminUsers,
  createNotification,
  updateSupport,
  updateUserSuspension,
} from "./_lib/admin-handlers.js";
import {
  HttpError,
  applyCors,
  handleError,
  methodNotAllowed,
  sendJson,
  sendSuccess,
  type ApiRequest,
  type ApiResponse,
} from "./_lib/http.js";
import { flutterwaveWebhook, initializePayment } from "./_lib/payment-handlers.js";
import {
  sessionBootstrap,
  telemetryEvent,
  telemetryHeartbeat,
  userSupport,
} from "./_lib/user-handlers.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

type RouteHandler = (request: ApiRequest) => Promise<Record<string, unknown>>;

const GET_ROUTES: Record<string, RouteHandler> = {
  "user/bootstrap": sessionBootstrap,
  support: userSupport,
  "admin/overview": adminOverview,
  "admin/users": adminUsers,
  "admin/live": adminLive,
  "admin/live-sessions": adminLive,
  "admin/purchases": adminPurchases,
  "admin/logs": adminLogs,
  "admin/notifications": adminNotifications,
  "admin/support": adminSupport,
};

const POST_ROUTES: Record<string, RouteHandler> = {
  "auth/session": sessionBootstrap,
  "telemetry/heartbeat": telemetryHeartbeat,
  "telemetry/event": telemetryEvent,
  "telemetry/events": telemetryEvent,
  "admin/credits": adjustCredits,
  "admin/notifications": createNotification,
  "payments/initialize": initializePayment,
  "webhooks/flutterwave": flutterwaveWebhook,
};

const PUT_ROUTES: Record<string, RouteHandler> = {
  "admin/support": updateSupport,
};

const PATCH_ROUTES: Record<string, RouteHandler> = {
  "admin/users": updateUserSuspension,
};

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  try {
    if (!applyCors(request, response)) {
      throw new HttpError(403, "origin_not_allowed", "This browser origin is not allowed to call the Morphly API.");
    }
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Content-Length", "0");
      response.end();
      return;
    }

    const path = requestPath(request);
    if (path === "health" && request.method === "GET") {
      sendSuccess(response, {
        service: "morphly-cloud-api",
        firebaseConfigured: Boolean(
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
          (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY),
        ),
        flutterwaveConfigured: Boolean(process.env.FLUTTERWAVE_SECRET_KEY && process.env.FLUTTERWAVE_SECRET_HASH),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const dynamicCredit = path.match(/^admin\/users\/([^/]+)\/credits$/);
    if (dynamicCredit) {
      if (request.method !== "POST") return methodNotAllowed(response, ["POST", "OPTIONS"]);
      const payload = await adjustCredits(request, decodePathParameter(dynamicCredit[1]));
      sendSuccess(response, payload);
      return;
    }
    const dynamicSuspension = path.match(/^admin\/users\/([^/]+)\/suspension$/);
    if (dynamicSuspension) {
      if (request.method !== "PATCH") return methodNotAllowed(response, ["PATCH", "OPTIONS"]);
      const payload = await updateUserSuspension(request, decodePathParameter(dynamicSuspension[1]));
      sendSuccess(response, payload);
      return;
    }

    const routes = request.method === "GET"
      ? GET_ROUTES
      : request.method === "POST"
        ? POST_ROUTES
        : request.method === "PUT"
          ? PUT_ROUTES
          : request.method === "PATCH"
            ? PATCH_ROUTES
            : undefined;
    const route = routes?.[path];
    if (route) {
      const payload = await route(request);
      sendSuccess(response, payload, path === "admin/notifications" && request.method === "POST" ? 201 : 200);
      return;
    }

    const allowed = allowedMethods(path);
    if (allowed.length) {
      methodNotAllowed(response, [...allowed, "OPTIONS"]);
      return;
    }
    sendJson(response, 404, {
      ok: false,
      error: { code: "route_not_found", message: "Morphly API route not found." },
    });
  } catch (error) {
    handleError(response, error);
  }
}

function requestPath(request: ApiRequest): string {
  const queryPath = request.query?.path;
  const raw = Array.isArray(queryPath)
    ? queryPath.join("/")
    : queryPath || new URL(request.url || "/", "https://morphly.local").pathname.replace(/^\/api\/?/, "");
  const normalized = raw.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
    throw new HttpError(400, "invalid_path", "API path is invalid.");
  }
  return normalized;
}

function allowedMethods(path: string): string[] {
  const methods: string[] = [];
  if (GET_ROUTES[path]) methods.push("GET");
  if (POST_ROUTES[path]) methods.push("POST");
  if (PUT_ROUTES[path]) methods.push("PUT");
  if (PATCH_ROUTES[path]) methods.push("PATCH");
  if (path === "health") methods.push("GET");
  return methods;
}

function decodePathParameter(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_path_parameter", "API path parameter is malformed.");
  }
}
