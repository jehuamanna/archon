/**
 * Resolve HTTP base + mutable tokens for WPN calls.
 *
 * Local: ARCHON_LOCAL_WPN_URL + ARCHON_LOCAL_WPN_TOKEN.
 * Cloud: ARCHON_SYNC_API_BASE (must include `/api/v1`) + ARCHON_ACCESS_TOKEN or ARCHON_JWT,
 *   or with ARCHON_MCP_CLOUD_SESSION=1 optional env token + optional persisted session file.
 */
import { McpTokenHolder } from "./mcp-token-holder.js";
import { readPersistedMcpAuth, resolveMcpAuthPersistPath } from "./mcp-cloud-auth-persist.js";

export type WpnHttpConfig = {
  baseUrl: string;
  bearerToken: string;
};

export type McpAuthRuntime = {
  baseUrl: string;
  holder: McpTokenHolder;
  /** True when ARCHON_MCP_CLOUD_SESSION=1 (cloud only). */
  cloudSession: boolean;
  /** Absolute path for cloud session persistence; null for local / env-only cloud. */
  persistPath: string | null;
  /** local | cloud_env | cloud_session */
  mode: "local" | "cloud_env" | "cloud_session";
};

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function normalizeSyncBase(raw: string): string {
  const t = trimSlash(raw.trim());
  if (t.endsWith("/api/v1")) {
    return t;
  }
  return `${t}/api/v1`;
}

function truthyEnv(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

/**
 * Load MCP auth: local loopback, cloud with required env token, or cloud session (optional token + persist).
 */
export function loadMcpAuthRuntime(): McpAuthRuntime {
  const localUrl = process.env.ARCHON_LOCAL_WPN_URL?.trim();
  const localToken = process.env.ARCHON_LOCAL_WPN_TOKEN?.trim();
  if (localUrl && localToken) {
    const holder = new McpTokenHolder();
    holder.setTokens(localToken, null);
    return {
      baseUrl: trimSlash(localUrl),
      holder,
      cloudSession: false,
      persistPath: null,
      mode: "local",
    };
  }

  const syncRaw = process.env.ARCHON_SYNC_API_BASE?.trim();
  if (!syncRaw) {
    throw new Error(
      "Set either (ARCHON_LOCAL_WPN_URL + ARCHON_LOCAL_WPN_TOKEN) for Electron loopback, or " +
        "ARCHON_SYNC_API_BASE for cloud sync-api.",
    );
  }
  const baseUrl = normalizeSyncBase(syncRaw);
  const envAccess =
    process.env.ARCHON_ACCESS_TOKEN?.trim() || process.env.ARCHON_JWT?.trim() || "";
  const cloudSession = truthyEnv(process.env.ARCHON_MCP_CLOUD_SESSION);

  if (!cloudSession) {
    if (!envAccess) {
      throw new Error(
        "Cloud mode requires ARCHON_ACCESS_TOKEN or ARCHON_JWT (Bearer value, no 'Bearer ' prefix), " +
          "or set ARCHON_MCP_CLOUD_SESSION=1 for interactive login / persisted session.",
      );
    }
    const envRefresh = process.env.ARCHON_REFRESH_TOKEN?.trim() || null;
    const holder = new McpTokenHolder();
    holder.setTokens(envAccess, envRefresh);
    return {
      baseUrl,
      holder,
      cloudSession: false,
      persistPath: null,
      mode: "cloud_env",
    };
  }

  const persistPath = resolveMcpAuthPersistPath();
  const persisted = readPersistedMcpAuth(persistPath);
  const initialAccess = envAccess || persisted?.accessToken || "";
  const initialRefresh = persisted?.refreshToken?.trim()
    ? persisted.refreshToken
    : null;
  const holder = new McpTokenHolder();
  holder.setTokens(initialAccess, initialRefresh);
  return {
    baseUrl,
    holder,
    cloudSession: true,
    persistPath,
    mode: "cloud_session",
  };
}

/** @deprecated use loadMcpAuthRuntime + holder */
export function loadWpnHttpConfig(): WpnHttpConfig {
  const r = loadMcpAuthRuntime();
  return { baseUrl: r.baseUrl, bearerToken: r.holder.accessToken };
}
