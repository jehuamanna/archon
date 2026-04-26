/**
 * Auth boundary translation (Q1=B resolution).
 *
 * Pre-cutover JWTs and MCP device tokens carry 24-char Mongo ObjectId hex in
 * `sub`, `activeOrgId`, `activeSpaceId`. Post-cutover, every entity has a
 * freshly minted `uuid` PK and a permanent `legacy_object_id_map` entry that
 * lets the boundary translate the legacy form to its UUID equivalent.
 *
 * `verifyAndTranslate` wraps `verifyToken` from `auth.ts` and post-processes
 * the payload — handlers downstream of this point only see UUIDs. Tokens
 * issued post-cutover (already UUID `sub`) skip translation; the LRU in
 * `legacy-id-map.ts` keeps the warm-cache path cheap.
 */
import { verifyToken, type JwtPayload, type RefreshJwtPayload } from "./auth.js";
import { ensureUuid } from "./db/legacy-id-map.js";

/**
 * Verify a token (any variant) and rewrite legacy ObjectId fields in place
 * with their UUID equivalents. Throws on signature mismatch, expired token,
 * malformed payload, or a legacy id with no `legacy_object_id_map` row.
 */
export async function verifyAndTranslate(
  secret: string,
  token: string,
): Promise<JwtPayload> {
  const payload = verifyToken(secret, token);
  return translatePayloadIds(payload);
}

/** Same as `verifyAndTranslate` but enforces typ='access' (rejects refresh). */
export async function verifyAndTranslateAccess(
  secret: string,
  token: string,
): Promise<JwtPayload> {
  const payload = verifyToken(secret, token);
  if (payload.typ === "refresh") {
    throw new Error("Invalid token type");
  }
  return translatePayloadIds(payload);
}

/** Same as `verifyAndTranslate` but enforces typ='refresh'. Returns RefreshJwtPayload. */
export async function verifyAndTranslateRefresh(
  secret: string,
  token: string,
): Promise<RefreshJwtPayload> {
  const payload = verifyToken(secret, token) as RefreshJwtPayload;
  if (payload.typ !== "refresh" || typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new Error("Invalid refresh token");
  }
  const translated = (await translatePayloadIds(payload)) as RefreshJwtPayload;
  return translated;
}

/**
 * In-place translation of every id field that may carry a legacy ObjectId hex.
 * Currently: `sub` (users), `activeOrgId` (organizations), `activeSpaceId`
 * (spaces). Returns a *new* object — does not mutate the input.
 */
export async function translatePayloadIds<T extends JwtPayload>(payload: T): Promise<T> {
  // Work on a shallow copy so callers don't see mid-translation state if
  // they happen to share the object reference.
  const out: T = { ...payload };
  out.sub = await ensureUuid("users", payload.sub);
  if (typeof payload.activeOrgId === "string" && payload.activeOrgId.length > 0) {
    out.activeOrgId = await ensureUuid("organizations", payload.activeOrgId);
  }
  if (typeof payload.activeSpaceId === "string" && payload.activeSpaceId.length > 0) {
    out.activeSpaceId = await ensureUuid("spaces", payload.activeSpaceId);
  }
  return out;
}
