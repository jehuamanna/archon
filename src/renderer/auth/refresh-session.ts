import type { ArchonPlatformDeps } from "@archon/platform";
import { createSyncBaseUrlResolver } from "@archon/platform";
import {
  publishTokensRotated,
  readCloudSyncRefreshToken,
  writeCloudSyncRefreshToken,
  writeCloudSyncToken,
} from "../cloud-sync/cloud-sync-storage";
import { setAccessToken, setActiveOrgId, setActiveSpaceId } from "./auth-session";
import { decodeJwtPayload } from "./jwt-exp";

export type RefreshReason =
  | "no_refresh_token"
  | "refresh_failed_server"
  | "refresh_failed_network"
  | "malformed_server_response"
  | "storage_failed";

export type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; reason: RefreshReason };

export type TokensRotatedHandler = (payload: {
  accessToken: string;
  refreshToken: string;
}) => void;

type Deps = {
  remoteApi: ArchonPlatformDeps["remoteApi"];
  onTokensRotated?: TokensRotatedHandler;
};

let deps: Deps | null = null;
const resolveSyncApiBase = createSyncBaseUrlResolver();

export function setRefreshSessionDeps(next: Deps): void {
  deps = next;
}

const LOG_TAG = "[archon-auth]";

let inFlight: Promise<RefreshResult> | null = null;

export async function refreshSessionOnce(): Promise<RefreshResult> {
  // Single-flight across concurrent callers within this tab. Sibling tabs are
  // handled via BroadcastChannel (see scheduler + withAuthRetry).
  if (inFlight) return inFlight;
  inFlight = doRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRefresh(): Promise<RefreshResult> {
  const refreshToken = readCloudSyncRefreshToken();
  if (!refreshToken) {
    console.info(`${LOG_TAG} refresh: no_refresh_token`);
    return { ok: false, reason: "no_refresh_token" };
  }
  const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
  if (!syncBase) {
    console.warn(`${LOG_TAG} refresh: no sync base configured`);
    return { ok: false, reason: "refresh_failed_network" };
  }
  console.info(`${LOG_TAG} refresh: attempt`);
  let res: Response;
  try {
    res = await fetch(`${syncBase}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      credentials: "omit",
    });
  } catch (err) {
    console.warn(`${LOG_TAG} refresh: network error`, err);
    return { ok: false, reason: "refresh_failed_network" };
  }
  if (!res.ok) {
    console.warn(`${LOG_TAG} refresh: server ${res.status}`);
    return { ok: false, reason: "refresh_failed_server" };
  }
  let body: { token?: unknown; refreshToken?: unknown };
  try {
    body = (await res.json()) as { token?: unknown; refreshToken?: unknown };
  } catch {
    return { ok: false, reason: "malformed_server_response" };
  }
  const newAccess = typeof body.token === "string" ? body.token : "";
  const newRefresh = typeof body.refreshToken === "string" ? body.refreshToken : "";
  if (!newAccess || !newRefresh) {
    return { ok: false, reason: "malformed_server_response" };
  }
  try {
    writeCloudSyncToken(newAccess);
    writeCloudSyncRefreshToken(newRefresh);
  } catch {
    return { ok: false, reason: "storage_failed" };
  }
  setAccessToken(newAccess);
  const claims = decodeJwtPayload(newAccess);
  if (claims) {
    if (typeof claims.activeOrgId === "string") {
      setActiveOrgId(claims.activeOrgId);
    }
    if (typeof claims.activeSpaceId === "string") {
      setActiveSpaceId(claims.activeSpaceId);
    }
  }
  if (deps) {
    try {
      deps.remoteApi.setAuthToken(newAccess);
      deps.remoteApi.setRefreshToken(newRefresh);
    } catch (err) {
      console.warn(`${LOG_TAG} refresh: remoteApi update failed`, err);
    }
    try {
      deps.onTokensRotated?.({ accessToken: newAccess, refreshToken: newRefresh });
    } catch (err) {
      console.warn(`${LOG_TAG} refresh: onTokensRotated handler failed`, err);
    }
  }
  publishTokensRotated();
  console.info(`${LOG_TAG} refresh: success`);
  return { ok: true, accessToken: newAccess, refreshToken: newRefresh };
}
