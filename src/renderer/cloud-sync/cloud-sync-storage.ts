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
