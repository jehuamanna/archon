import type { RemoteApi } from "./ports";
import type { SyncDocument, SyncPullResponse, SyncPushResponse } from "./sync-types";
import {
  ARCHON_SYNC_ACCESS_TOKEN_KEY,
  ARCHON_SYNC_REFRESH_TOKEN_KEY,
} from "./sync-auth-storage-keys";
import { withSyncRetry } from "./sync-retry";

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, "");
  return path.startsWith("/") ? `${b}${path}` : `${b}/${path}`;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const t = await res.text();
    const raw = t?.trim() ? t.trim() : res.statusText;
    if (!raw) {
      return res.statusText;
    }
    try {
      const j = JSON.parse(raw) as {
        message?: unknown;
        error?: unknown;
        statusCode?: unknown;
      };
      const msg =
        (typeof j.message === "string" && j.message.trim()) ||
        (typeof j.error === "string" && j.error.trim());
      if (msg) {
        const code =
          typeof j.statusCode === "number"
            ? ` (${j.statusCode})`
            : typeof j.statusCode === "string" && j.statusCode
              ? ` (${j.statusCode})`
              : "";
        return `${msg}${code}`;
      }
    } catch {
      /* not JSON */
    }
    return raw;
  } catch {
    return res.statusText;
  }
}

function persistSyncedAuthTokens(access: string, refresh: string): void {
  try {
    localStorage.setItem(ARCHON_SYNC_ACCESS_TOKEN_KEY, access);
    localStorage.setItem(ARCHON_SYNC_REFRESH_TOKEN_KEY, refresh);
  } catch {
    /* private mode */
  }
}

export type CreateFetchRemoteApiOptions = {
  /** After clearing tokens due to 401 + failed refresh, or 401 after a refresh retry. */
  onSessionInvalidated?: () => void;
};

/**
 * HTTP client for `@archon/sync-api` (Fastify + Mongo).
 * If base URL is empty, `syncPush` / `syncPull` no-op; `auth*` throws.
 */
export function createFetchRemoteApi(
  getBaseUrl: () => string,
  options: CreateFetchRemoteApiOptions = {},
): RemoteApi {
  const onSessionInvalidated = options.onSessionInvalidated;
  let token: string | null = null;
  let refreshToken: string | null = null;

  const invalidateSession = (): void => {
    token = null;
    refreshToken = null;
    try {
      localStorage.removeItem(ARCHON_SYNC_ACCESS_TOKEN_KEY);
      localStorage.removeItem(ARCHON_SYNC_REFRESH_TOKEN_KEY);
    } catch {
      /* private mode */
    }
    onSessionInvalidated?.();
  };

  const jsonHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      h.Authorization = `Bearer ${token}`;
    }
    return h;
  };

  const requireBase = (): string => {
    const b = getBaseUrl().trim().replace(/\/$/, "");
    if (!b) {
      throw new Error(
        "Archon sync API URL is not configured (set NEXT_PUBLIC_ARCHON_SYNC_API_URL or window.__ARCHON_SYNC_API_BASE__)",
      );
    }
    return b;
  };

  const tryRefreshTokens = async (base: string): Promise<boolean> => {
    const rt = refreshToken;
    if (!rt) {
      return false;
    }
    const res = await fetch(joinUrl(base, "/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { token: string; refreshToken: string };
    token = body.token;
    refreshToken = body.refreshToken;
    persistSyncedAuthTokens(body.token, body.refreshToken);
    return true;
  };

  const fetchAuthed = async (
    path: string,
    init: RequestInit,
  ): Promise<Response> => {
    const base = getBaseUrl().trim().replace(/\/$/, "");
    if (!base) {
      return new Response(null, { status: 204 });
    }
    const url = joinUrl(base, path);
    const first = await fetch(url, init);
    if (first.status !== 401 || path === "/auth/refresh") {
      return first;
    }
    const ok = await tryRefreshTokens(base);
    if (!ok) {
      invalidateSession();
      return first;
    }
    const second = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        ...jsonHeaders(),
      },
    });
    if (second.status === 401) {
      invalidateSession();
    }
    return second;
  };

  return {
    getBaseUrl: () => getBaseUrl().trim().replace(/\/$/, ""),
    setAuthToken: (t) => {
      token = t;
    },
    setRefreshToken: (t) => {
      refreshToken = t;
    },
    authRegister: async (email, password) => {
      const base = requireBase();
      const res = await fetch(joinUrl(base, "/auth/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        throw new Error(await readErrorBody(res));
      }
      return (await res.json()) as {
        token: string;
        refreshToken: string;
        userId: string;
      };
    },
    authLogin: async (email, password) => {
      const base = requireBase();
      const res = await fetch(joinUrl(base, "/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        throw new Error(await readErrorBody(res));
      }
      return (await res.json()) as {
        token: string;
        refreshToken: string;
        userId: string;
        mustSetPassword?: boolean;
      };
    },
    authRefresh: async (rt: string) => {
      const base = requireBase();
      const res = await fetch(joinUrl(base, "/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) {
        throw new Error(await readErrorBody(res));
      }
      return (await res.json()) as { token: string; refreshToken: string };
    },
    authMe: async () => {
      const base = requireBase();
      if (!token) {
        throw new Error("Not signed in");
      }
      const res = await fetchAuthed("/auth/me", {
        method: "GET",
        headers: jsonHeaders(),
      });
      if (!res.ok) {
        throw new Error(await readErrorBody(res));
      }
      return (await res.json()) as {
        userId: string;
        email: string;
        mustSetPassword?: boolean;
        isMasterAdmin?: boolean;
        lockedOrgId?: string | null;
      };
    },
    authChangePassword: async (currentPassword, newPassword) => {
      requireBase();
      if (!token) {
        throw new Error("Not signed in");
      }
      const res = await fetchAuthed("/auth/change-password", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        throw new Error(await readErrorBody(res));
      }
      return (await res.json()) as { ok: true; mustSetPassword: false };
    },
    syncPush: async (
      collection: string,
      documents: SyncDocument[],
    ): Promise<SyncPushResponse> => {
      const base = getBaseUrl().trim().replace(/\/$/, "");
      if (!base) {
        return { accepted: [], conflicts: [] };
      }
      if (!token) {
        return { accepted: [], conflicts: [] };
      }
      return withSyncRetry(async () => {
        const res = await fetchAuthed("/sync/push", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ collection, documents }),
        });
        if (!res.ok) {
          throw new Error(await readErrorBody(res));
        }
        return (await res.json()) as SyncPushResponse;
      });
    },
    syncPull: async (
      collection: string,
      since: number,
    ): Promise<SyncPullResponse> => {
      const base = getBaseUrl().trim().replace(/\/$/, "");
      if (!base) {
        return { documents: [], lastSync: Date.now() };
      }
      if (!token) {
        return { documents: [], lastSync: Date.now() };
      }
      const q = new URLSearchParams({
        collection,
        since: String(since),
      });
      return withSyncRetry(async () => {
        const res = await fetchAuthed(`/sync/pull?${q}`, {
          method: "GET",
          headers: jsonHeaders(),
        });
        if (!res.ok) {
          throw new Error(await readErrorBody(res));
        }
        return (await res.json()) as SyncPullResponse;
      });
    },
  };
}
