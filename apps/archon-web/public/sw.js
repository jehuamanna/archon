/**
 * Minimal service worker for PWA install criteria and offline shell hint.
 * Full route/data caching can be expanded later (e.g. Workbox).
 * With Next.js, navigations are usually network-first; this keeps scope explicit.
 */
const CACHE = "archon-pwa-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/favicon.svg"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(request);
      if (cached) {
        return cached;
      }
      return caches.match("/favicon.svg");
    }),
  );
});
