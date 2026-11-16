const CACHE = "classlie-v159";
const API_CACHE = "classlie-api-v152";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css?v=158",
  "/app.js?v=163",
  "/manifest.json",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== API_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "clear-api-cache") caches.delete(API_CACHE);
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API reads: network-first, with the last good response as an offline fallback.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(API_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // HTML navigations: network-first, so app updates show up immediately (cache is only an offline fallback).
  if (request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/index.html", copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached || caches.match("/")))
    );
    return;
  }

  // Versioned assets (styles.css?v=152 ...) are safe to serve cache-first.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      return response;
    }).catch(() => cached))
  );
});

// ---------- web push ----------
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* plain text or empty */ }
  const title = data.title || "Classlie";
  const options = {
    body: data.body || "You have a new update.",
    tag: data.tag || undefined,
    data: { url: data.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) { client.navigate(target); return client.focus(); }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    })
  );
});
