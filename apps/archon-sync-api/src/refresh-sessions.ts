/** Multi-device refresh sessions (see docs/auth-concurrent-sessions-mcp-persist-401.md). */

export type RefreshSessionEntry = { jti: string; createdAt: Date };

const DEFAULT_MAX = 20;
const ABS_CAP = 100;

export function maxRefreshSessionsPerUser(): number {
  const raw = process.env.ARCHON_MAX_REFRESH_SESSIONS;
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_MAX;
  }
  return Math.min(ABS_CAP, n);
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v;
  }
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function normalizeRefreshSessions(user: {
  refreshSessions?: unknown;
}): RefreshSessionEntry[] {
  const raw = user.refreshSessions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RefreshSessionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as { jti?: unknown; createdAt?: unknown };
    if (typeof o.jti !== "string" || !o.jti) {
      continue;
    }
    const createdAt = asDate(o.createdAt) ?? new Date(0);
    out.push({ jti: o.jti, createdAt });
  }
  return out;
}

export function userHasRefreshJti(
  user: { refreshSessions?: unknown; activeRefreshJti?: string | null },
  jti: string,
): boolean {
  if (user.activeRefreshJti === jti) {
    return true;
  }
  return normalizeRefreshSessions(user).some((s) => s.jti === jti);
}

/** Append a new refresh session; migrates legacy `activeRefreshJti` into the array when needed. */
export function buildSessionsAfterAppend(
  user: { refreshSessions?: unknown; activeRefreshJti?: string | null },
  newJti: string,
): RefreshSessionEntry[] {
  let sessions = normalizeRefreshSessions(user);
  if (sessions.length === 0 && user.activeRefreshJti) {
    sessions = [{ jti: user.activeRefreshJti, createdAt: new Date(0) }];
  }
  sessions.push({ jti: newJti, createdAt: new Date() });
  const max = maxRefreshSessionsPerUser();
  if (sessions.length > max) {
    sessions.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    sessions = sessions.slice(-max);
  }
  return sessions;
}

/** Rotate `oldJti` → `newJti` for the matching session entry. */
export function rotateRefreshSession(
  user: { refreshSessions?: unknown; activeRefreshJti?: string | null },
  oldJti: string,
  newJti: string,
): RefreshSessionEntry[] | null {
  if (!userHasRefreshJti(user, oldJti)) {
    return null;
  }
  const sessions = normalizeRefreshSessions(user);
  const idx = sessions.findIndex((s) => s.jti === oldJti);
  if (idx >= 0) {
    return sessions.map((s) =>
      s.jti === oldJti ? { jti: newJti, createdAt: s.createdAt } : s,
    );
  }
  if (user.activeRefreshJti === oldJti) {
    return [{ jti: newJti, createdAt: new Date() }];
  }
  return null;
}
