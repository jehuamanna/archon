import { ARCHON_POST_AUTH_REDIRECT_KEY } from "@archon/platform";
import { isElectronUserAgent } from "../archon-web-shim";

/** Query param on `/` carrying the return path after sign-in (see {@link buildMcpDevicePostAuthSignInHref}). */
export const ARCHON_POST_AUTH_QUERY_PARAM = "archon_post_auth";

/**
 * Validates a path+query from the URL param; only `/mcp-auth?user_code=…` is allowed (open-redirect safe).
 */
export function parseSafeMcpAuthReturnPath(encoded: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded.trim());
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) {
    return null;
  }
  if (decoded.includes("://")) {
    return null;
  }
  try {
    const u = new URL(decoded, "https://archon.invalid");
    if (u.pathname !== "/mcp-auth") {
      return null;
    }
    const uc = u.searchParams.get("user_code")?.trim();
    if (!uc || uc.length < 4 || uc.length > 128) {
      return null;
    }
    if (!/^[A-Za-z0-9]+$/.test(uc)) {
      return null;
    }
    return `/mcp-auth?user_code=${encodeURIComponent(uc)}`;
  } catch {
    return null;
  }
}

export function buildMcpDevicePostAuthSignInHref(userCode: string): string {
  const path = `/mcp-auth?user_code=${encodeURIComponent(userCode.trim())}`;
  return `/?${ARCHON_POST_AUTH_QUERY_PARAM}=${encodeURIComponent(path)}`;
}

/** Read `archon_post_auth` from the current URL, store in sessionStorage, strip from the address bar. */
export function captureArchonPostAuthRedirectQueryParam(): void {
  if (typeof window === "undefined") {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(ARCHON_POST_AUTH_QUERY_PARAM);
  if (!raw) {
    return;
  }
  const path = parseSafeMcpAuthReturnPath(raw);
  if (!path) {
    return;
  }
  try {
    sessionStorage.setItem(ARCHON_POST_AUTH_REDIRECT_KEY, path);
    params.delete(ARCHON_POST_AUTH_QUERY_PARAM);
    const q = params.toString();
    const next = window.location.pathname + (q ? `?${q}` : "") + window.location.hash;
    window.history.replaceState(null, "", next);
  } catch {
    /* ignore */
  }
}

/** After successful web login/signup: return to MCP authorize page if one was requested. */
export function consumePostAuthRedirectAfterSignIn(): void {
  if (typeof window === "undefined" || isElectronUserAgent()) {
    return;
  }
  try {
    const path = sessionStorage.getItem(ARCHON_POST_AUTH_REDIRECT_KEY);
    if (!path) {
      return;
    }
    sessionStorage.removeItem(ARCHON_POST_AUTH_REDIRECT_KEY);
    window.location.assign(path);
  } catch {
    /* ignore */
  }
}
