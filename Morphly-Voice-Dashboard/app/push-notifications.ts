import {
  deleteToken,
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type MessagePayload,
  type Messaging,
} from "firebase/messaging";
import { getFirebaseAuth } from "./firebase-client";

const DEFAULT_SERVICE_WORKER_URL = "/morphly-notifications-sw.js";
const DEFAULT_SERVICE_WORKER_SCOPE = "/";

let activeMessaging: Messaging | null = null;
let activeServiceWorker: ServiceWorkerRegistration | null = null;
let activeToken: string | null = null;
let stopForegroundListener: (() => void) | null = null;

export type ForegroundPushHandler = (payload: MessagePayload) => void;

export interface EnablePushNotificationsOptions {
  /** Receives Firebase messages while the dashboard has focus. */
  onForegroundMessage?: ForegroundPushHandler;
  /** Persist the token through the authenticated Morphly API. */
  onToken?: (token: string) => void | Promise<void>;
  serviceWorkerUrl?: string;
  serviceWorkerScope?: string;
}

export interface DisablePushNotificationsOptions {
  /** A remembered token can be supplied when logout happens after a reload. */
  token?: string | null;
  /** Remove the token from the authenticated Morphly API before local deletion. */
  onTokenRevoked?: (token: string) => void | Promise<void>;
  /** Usually false: the worker can safely remain installed for the next login. */
  unregisterServiceWorker?: boolean;
}

export interface EnabledPushNotifications {
  token: string;
  permission: "granted";
  serviceWorker: ServiceWorkerRegistration;
  stopForegroundMessages(): void;
  disable(options?: DisablePushNotificationsOptions): Promise<DisabledPushNotifications>;
}

export interface DisabledPushNotifications {
  firebaseTokenDeleted: boolean;
  serviceWorkerUnregistered: boolean;
}

export class PushNotificationsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushNotificationsUnavailableError";
  }
}

function vapidKey(): string {
  return String(import.meta.env.VITE_FIREBASE_VAPID_KEY || "").trim();
}

function requireBrowserSupport(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new PushNotificationsUnavailableError("Push notifications are only available in a browser window.");
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    throw new PushNotificationsUnavailableError("This browser does not support push notifications.");
  }
  if (!window.isSecureContext) {
    throw new PushNotificationsUnavailableError("Push notifications require HTTPS or localhost.");
  }
}

async function requestPermissionFromUserInteraction(): Promise<"granted"> {
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") {
    throw new PushNotificationsUnavailableError(
      "Notification permission is blocked. Enable it in the browser site settings and try again.",
    );
  }
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    throw new PushNotificationsUnavailableError(
      "Enable notifications from a button click or another explicit user action.",
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushNotificationsUnavailableError("Notification permission was not granted.");
  }
  return permission;
}

function stopForegroundMessages(): void {
  stopForegroundListener?.();
  stopForegroundListener = null;
}

/**
 * Requests permission and enables Firebase Cloud Messaging.
 * Call this directly from an explicit user action such as an "Enable notifications" button.
 */
export async function enablePushNotifications(
  options: EnablePushNotificationsOptions = {},
): Promise<EnabledPushNotifications> {
  requireBrowserSupport();
  const permission = await requestPermissionFromUserInteraction();

  if (!(await isSupported())) {
    throw new PushNotificationsUnavailableError("Firebase messaging is not supported by this browser.");
  }

  const serviceWorker = await navigator.serviceWorker.register(
    options.serviceWorkerUrl || DEFAULT_SERVICE_WORKER_URL,
    { scope: options.serviceWorkerScope || DEFAULT_SERVICE_WORKER_SCOPE },
  );
  await serviceWorker.update().catch(() => undefined);

  const messaging = getMessaging(getFirebaseAuth().app);
  const publicVapidKey = vapidKey();
  const token = await getToken(messaging, {
    ...(publicVapidKey ? { vapidKey: publicVapidKey } : {}),
    serviceWorkerRegistration: serviceWorker,
  });
  if (!token) {
    throw new PushNotificationsUnavailableError("Firebase did not return a push notification token.");
  }

  activeMessaging = messaging;
  activeServiceWorker = serviceWorker;
  activeToken = token;
  try {
    if (options.onToken) await options.onToken(token);
  } catch (error) {
    await deleteToken(messaging).catch(() => false);
    activeMessaging = null;
    activeServiceWorker = null;
    activeToken = null;
    throw error;
  }

  stopForegroundMessages();
  if (options.onForegroundMessage) {
    stopForegroundListener = onMessage(messaging, options.onForegroundMessage);
  }

  return {
    token,
    permission,
    serviceWorker,
    stopForegroundMessages,
    disable: disablePushNotifications,
  };
}

/** Deletes the local FCM token and optionally unregisters its service worker. */
export async function disablePushNotifications(
  options: DisablePushNotificationsOptions = {},
): Promise<DisabledPushNotifications> {
  stopForegroundMessages();

  if (!activeMessaging && typeof window !== "undefined" && typeof navigator !== "undefined") {
    try {
      if (await isSupported()) activeMessaging = getMessaging(getFirebaseAuth().app);
      activeServiceWorker = activeServiceWorker || await navigator.serviceWorker?.getRegistration(DEFAULT_SERVICE_WORKER_SCOPE) || null;
    } catch {
      // Logout still continues when messaging was never supported on this device.
    }
  }

  const token = options.token || activeToken;
  let revokeError: unknown;
  if (token && options.onTokenRevoked) {
    try {
      await options.onTokenRevoked(token);
    } catch (error) {
      revokeError = error;
    }
  }

  let firebaseTokenDeleted = false;
  let serviceWorkerUnregistered = false;
  try {
    if (activeMessaging) firebaseTokenDeleted = await deleteToken(activeMessaging);
  } finally {
    if (options.unregisterServiceWorker && activeServiceWorker) {
      serviceWorkerUnregistered = await activeServiceWorker.unregister();
    }
    activeMessaging = null;
    activeServiceWorker = null;
    activeToken = null;
  }

  if (revokeError) throw revokeError;
  return { firebaseTokenDeleted, serviceWorkerUnregistered };
}
