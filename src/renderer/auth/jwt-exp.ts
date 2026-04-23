/**
 * JWT payload decoding helpers. We do NOT verify signatures — the server is the
 * authority on token validity. These helpers exist so the client can (a) seed UI
 * state from access-token claims and (b) schedule a proactive refresh before
 * `exp` without waiting for a 401.
 */

export type JwtPayload = Record<string, unknown>;

export function decodeJwtPayload(token: string | null | undefined): JwtPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = atob(padded + pad);
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== "object") return null;
    return obj as JwtPayload;
  } catch {
    return null;
  }
}

export type AccessTokenExpiry = {
  /** Unix epoch ms of `exp` claim. */
  expMs: number;
  /** Unix epoch ms of `iat` claim, or `null` if missing. */
  iatMs: number | null;
};

export function decodeAccessTokenExpiry(
  token: string | null | undefined,
): AccessTokenExpiry | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  const iat = payload.iat;
  return {
    expMs: Math.trunc(exp * 1000),
    iatMs: typeof iat === "number" && Number.isFinite(iat) ? Math.trunc(iat * 1000) : null,
  };
}
