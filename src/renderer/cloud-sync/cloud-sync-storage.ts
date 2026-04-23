import {
  ARCHON_SYNC_ACCESS_TOKEN_KEY,
  ARCHON_SYNC_REFRESH_TOKEN_KEY,
} from "@archon/platform";

const SINCE_KEY = "archon-cloud-sync-since";

export function readCloudSyncToken(): string | null {
  try {
    return localStorage.getItem(ARCHON_SYNC_ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeCloudSyncToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(ARCHON_SYNC_ACCESS_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(ARCHON_SYNC_ACCESS_TOKEN_KEY);
    }
  } catch {
    /* private mode */
  }
}

export function readCloudSyncRefreshToken(): string | null {
  try {
    return localStorage.getItem(ARCHON_SYNC_REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeCloudSyncRefreshToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(ARCHON_SYNC_REFRESH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(ARCHON_SYNC_REFRESH_TOKEN_KEY);
    }
  } catch {
    /* private mode */
  }
}

const EMAIL_KEY = "archon-sync-user-email";

export function readCloudSyncEmail(): string | null {
  try {
    return localStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
}

export function writeCloudSyncEmail(email: string | null): void {
  try {
    if (email) {
      localStorage.setItem(EMAIL_KEY, email);
    } else {
      localStorage.removeItem(EMAIL_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function readCloudSyncSince(): number {
  try {
    const ls = localStorage.getItem(SINCE_KEY);
    if (ls != null) {
      const n = Number(ls);
      return Number.isFinite(n) ? n : 0;
    }
    const ss = sessionStorage.getItem(SINCE_KEY);
    if (ss != null) {
      localStorage.setItem(SINCE_KEY, ss);
      sessionStorage.removeItem(SINCE_KEY);
      const n = Number(ss);
      return Number.isFinite(n) ? n : 0;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

export function writeCloudSyncSince(ts: number): void {
  try {
    localStorage.setItem(SINCE_KEY, String(ts));
    try {
      sessionStorage.removeItem(SINCE_KEY);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

type TokenChangeSource = "local" | "other-tab";
type TokenChangeListener = (source: TokenChangeSource) => void;

const listeners = new Set<TokenChangeListener>();
let broadcastChannel: BroadcastChannel | null = null;
let storageListenerAttached = false;

function ensureBroadcastWiredUp(): void {
  if (typeof window === "undefined") return;
  if (!broadcastChannel && typeof BroadcastChannel !== "undefined") {
    try {
      broadcastChannel = new BroadcastChannel("archon-auth");
      broadcastChannel.addEventListener("message", (event) => {
        const msg = event.data as { type?: unknown } | null;
        if (msg && msg.type === "tokens-rotated") {
          for (const l of listeners) {
            try {
              l("other-tab");
            } catch {
              /* ignore */
            }
          }
        }
      });
    } catch {
      broadcastChannel = null;
    }
  }
  if (!storageListenerAttached) {
    try {
      window.addEventListener("storage", (event) => {
        if (
          event.key === ARCHON_SYNC_ACCESS_TOKEN_KEY ||
          event.key === ARCHON_SYNC_REFRESH_TOKEN_KEY
        ) {
          for (const l of listeners) {
            try {
              l("other-tab");
            } catch {
              /* ignore */
            }
          }
        }
      });
      storageListenerAttached = true;
    } catch {
      /* ignore */
    }
  }
}

export function subscribeTokenChanges(listener: TokenChangeListener): () => void {
  ensureBroadcastWiredUp();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Notify other tabs that the current tab has rotated its tokens. Also invokes
 * local listeners so a tab may observe its own writes for scheduler restart.
 */
export function publishTokensRotated(): void {
  ensureBroadcastWiredUp();
  try {
    broadcastChannel?.postMessage({ type: "tokens-rotated", at: Date.now() });
  } catch {
    /* ignore */
  }
  for (const l of listeners) {
    try {
      l("local");
    } catch {
      /* ignore */
    }
  }
}
