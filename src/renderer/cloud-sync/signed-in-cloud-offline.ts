/**
 * When the web app uses sync-api for WPN and the user has cloud sync tokens,
 * we treat that as a signed-in cloud session. If the browser is offline, WPN mutations
 * and durable chrome persistence are blocked (read-only until online).
 */
import { createSyncBaseUrlResolver } from "@archon/platform";
import { isElectronCloudWpnSession } from "../auth/electron-cloud-session";
import { readCloudSyncToken } from "./cloud-sync-storage";

function syncWpnUsesSyncApiEnv(): boolean {
  if (
    typeof window !== "undefined" &&
    (window as Window & { __ARCHON_WPN_USE_SYNC_API__?: boolean })
      .__ARCHON_WPN_USE_SYNC_API__ === true
  ) {
    return true;
  }
  if (typeof window !== "undefined" && isElectronCloudWpnSession()) {
    return true;
  }
  try {
    return process.env.NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API === "1";
  } catch {
    return false;
  }
}

const resolveSyncBase = createSyncBaseUrlResolver();

/** Web UI configured for cloud WPN via sync-api and user has an access token. */
export function isSignedInCloudWpnWeb(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (!syncWpnUsesSyncApiEnv()) {
    return false;
  }
  if (!resolveSyncBase().trim()) {
    return false;
  }
  const t = readCloudSyncToken();
  return typeof t === "string" && t.length > 0;
}

export function isNavigatorOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Cloud WPN session + no network → read-only mode for mutations / durable UI. */
export function isSignedInCloudWpnOffline(): boolean {
  return isSignedInCloudWpnWeb() && isNavigatorOffline();
}

function isMutatingHttpMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";
}

/** Throws if a mutating WPN/sync request should not run while offline. */
export function assertSignedInCloudWpnOnlineForMutation(method: string): void {
  if (!isMutatingHttpMethod(method)) {
    return;
  }
  if (!isSignedInCloudWpnOffline()) {
    return;
  }
  throw new Error(
    "You're offline. Connect to the internet to save changes to your cloud workspace.",
  );
}

/** Skip localStorage / host layout / URL hash updates for chrome. */
export function shouldSkipDurableChromePersistence(): boolean {
  return isSignedInCloudWpnOffline();
}
