const SYNC_API_V1_SUFFIX = "/api/v1";

function readSameOriginApiFlag(): boolean {
  try {
    return (
      typeof process !== "undefined" &&
      (process.env.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "1" ||
        process.env.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "true")
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function browserHostnameIsLoopback(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  return isLoopbackHostname(window.location.hostname);
}

function configuredSyncBaseUsesLoopback(base: string): boolean {
  try {
    return isLoopbackHostname(new URL(base).hostname);
  } catch {
    return false;
  }
}

function isAnyAddrHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "0.0.0.0" || h === "::";
}

/**
 * When the app is opened on a real host (e.g. https://archon.studio) but the build still baked
 * `NEXT_PUBLIC_ARCHON_SYNC_API_URL=http://127.0.0.1:8080/api/v1`, use the page origin so the browser
 * hits the gateway on the same host instead of the visitor's loopback.
 *
 * `0.0.0.0` / `::` are "bind any" addresses — the dev server *is* reachable on every interface,
 * so when the browser is on a non-loopback host the page's own hostname is a valid client target.
 * Swap the hostname only and preserve the configured port (sync-api on :4010 while the page is on :3000).
 */
function rewriteLoopbackSyncBaseForPublicPage(base: string): string {
  if (typeof window === "undefined" || !base) {
    return base;
  }
  if (browserHostnameIsLoopback()) {
    return base;
  }
  let configuredHost: string | null = null;
  try {
    configuredHost = new URL(base).hostname.toLowerCase();
  } catch {
    return base;
  }
  if (isAnyAddrHostname(configuredHost)) {
    try {
      const u = new URL(base);
      u.hostname = window.location.hostname;
      return normalizeSyncApiBaseUrl(u.toString());
    } catch {
      return base;
    }
  }
  if (!configuredSyncBaseUsesLoopback(base)) {
    return base;
  }
  const origin = window.location.origin.replace(/\/$/, "");
  return normalizeSyncApiBaseUrl(`${origin}/api/v1`);
}

/**
 * Ensures the sync HTTP base ends with `/api/v1` (no trailing slash) when the URL is only an origin
 * (e.g. `http://127.0.0.1:4010`). Leaves URLs that already include a path segment unchanged.
 */
export function normalizeSyncApiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) {
    return "";
  }
  const lc = trimmed.toLowerCase();
  if (lc.endsWith(SYNC_API_V1_SUFFIX)) {
    return trimmed;
  }
  try {
    const u = new URL(trimmed);
    const path = u.pathname.replace(/\/$/, "") || "";
    if (path === "" || path === "/") {
      u.pathname = SYNC_API_V1_SUFFIX;
      return u.toString().replace(/\/$/, "");
    }
  } catch {
    /* non-absolute URL or invalid — return trimmed as-is */
  }
  return trimmed;
}

/**
 * Resolves the Fastify sync API base URL (no trailing slash).
 * Precedence: `getSyncApiBaseUrl` option → `window.__ARCHON_SYNC_API_BASE__` →
 * (browser) `NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN` → `NEXT_PUBLIC_ARCHON_SYNC_API_URL` /
 * `ARCHON_SYNC_API_URL` → dev default `http://127.0.0.1:4010/api/v1`.
 *
 * In the browser: same-origin flag forces the current tab origin + `/api/v1`. If the page is not
 * on loopback but the chosen URL (from env or dev default) targets loopback, it is rewritten to
 * the current origin + `/api/v1` so production sites are not stuck calling the visitor's 127.0.0.1.
 */
export function createSyncBaseUrlResolver(
  override?: () => string,
): () => string {
  return () => {
    if (override) {
      const o = normalizeSyncApiBaseUrl(override());
      if (o) {
        return rewriteLoopbackSyncBaseForPublicPage(o);
      }
    }
    if (typeof window !== "undefined") {
      const w = window as Window & { __ARCHON_SYNC_API_BASE__?: string };
      const fromWin = w.__ARCHON_SYNC_API_BASE__?.trim();
      if (fromWin) {
        return rewriteLoopbackSyncBaseForPublicPage(normalizeSyncApiBaseUrl(fromWin));
      }
      if (readSameOriginApiFlag()) {
        return normalizeSyncApiBaseUrl(`${window.location.origin}/api/v1`);
      }
    }
    try {
      const pub =
        typeof process !== "undefined" &&
        typeof process.env?.NEXT_PUBLIC_ARCHON_SYNC_API_URL === "string"
          ? process.env.NEXT_PUBLIC_ARCHON_SYNC_API_URL.trim()
          : "";
      if (pub) {
        return rewriteLoopbackSyncBaseForPublicPage(normalizeSyncApiBaseUrl(pub));
      }
      const env =
        typeof process !== "undefined" &&
        typeof process.env?.ARCHON_SYNC_API_URL === "string"
          ? process.env.ARCHON_SYNC_API_URL.trim()
          : "";
      if (env) {
        return rewriteLoopbackSyncBaseForPublicPage(normalizeSyncApiBaseUrl(env));
      }
      if (
        typeof process !== "undefined" &&
        process.env?.NODE_ENV === "development"
      ) {
        const devDefault = "http://127.0.0.1:4010/api/v1";
        return rewriteLoopbackSyncBaseForPublicPage(devDefault);
      }
    } catch {
      /* no process in browser without bundler */
    }
    return "";
  };
}
