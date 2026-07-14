"use strict";

const DEFAULT_TITLE = "Morphly Voice";
const DEFAULT_BODY = "You have a new Morphly notification.";
const DEFAULT_URL = "/";

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parsedObject(value) {
  if (typeof value !== "string") return objectValue(value);
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function cleanText(value, fallback, limit) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, limit);
}

function safeSameOriginUrl(value) {
  try {
    const url = new URL(typeof value === "string" && value.trim() ? value : DEFAULT_URL, self.location.origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return self.location.origin;
    return url.origin === self.location.origin ? url.href : self.location.origin;
  } catch {
    return self.location.origin;
  }
}

function notificationDetails(rawPayload) {
  const raw = objectValue(rawPayload);
  const payload = objectValue(raw.FCM_MSG || raw);
  const notification = objectValue(payload.notification);
  const data = objectValue(payload.data);
  const nestedNotification = parsedObject(data.notification);
  const fcmOptions = objectValue(payload.fcmOptions || payload.webpush?.fcmOptions);

  const title = cleanText(
    notification.title || nestedNotification.title || data.title,
    DEFAULT_TITLE,
    140,
  );
  const body = cleanText(
    notification.body || nestedNotification.body || data.body || data.message,
    DEFAULT_BODY,
    1000,
  );
  const requestedUrl =
    fcmOptions.link ||
    notification.click_action ||
    nestedNotification.click_action ||
    data.actionUrl ||
    data.clickAction ||
    data.url ||
    DEFAULT_URL;

  return {
    title,
    options: {
      body,
      icon: cleanText(notification.icon || data.icon, "/morphly-icon-192.png", 500),
      badge: "/morphly-icon-48.png",
      tag: cleanText(data.notificationId || data.id || payload.messageId, "morphly-notification", 160),
      renotify: Boolean(data.notificationId || data.id),
      data: {
        url: safeSameOriginUrl(requestedUrl),
        notificationId: cleanText(data.notificationId || data.id, "", 160),
      },
    },
  };
}

self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { data: { body: event.data.text() } };
    }
  }
  const notification = notificationDetails(payload);
  event.waitUntil(self.registration.showNotification(notification.title, notification.options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = safeSameOriginUrl(event.notification.data?.url);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });

    if (existing) {
      if ("navigate" in existing && existing.url !== targetUrl) {
        try {
          await existing.navigate(targetUrl);
        } catch {
          // Keep the existing Morphly window when navigation is unavailable.
        }
      }
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
