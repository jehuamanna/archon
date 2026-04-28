/**
 * Archon web service worker — stamped with a build ID at build time
 * (see `scripts/build-sw.mjs`). Each deploy yields a unique byte sequence
 * so the browser can detect that a new app version is available and the
 * page can surface the in-app "Reload to update" banner.
 *
 * UX contract (matches Gmail / Slack / Linear / Google Docs):
 *   - install: cache the shell, but do NOT auto-skipWaiting. We let the
 *     page show a banner so the user picks the moment to reload.
 *   - activate: claim clients, drop stale shell caches.
 *   - message {type:"SKIP_WAITING"}: page-driven activation. Triggers
 *     `controllerchange` in the registrar, which then reloads the tab.
 *   - fetch: network-first, cache fallback for offline. Granular caching
 *     of `_next/static/*` is left as a follow-up — the immediate UX win
 *     is from the update banner, not from offline coverage.
 */
const BUILD_ID = "__ARCHON_BUILD_ID__";
const CACHE = `archon-pwa-shell-${BUILD_ID}`;
const APP_SHELL = ["/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {
        /* shell not available at install time — non-fatal */
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("archon-pwa-shell-") && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      return caches.match("/favicon.svg");
    }),
  );
});
