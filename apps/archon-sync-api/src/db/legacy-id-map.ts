/**
 * Legacy 24-char hex id → UUID translation.
 *
 * Some pre-existing JWTs and MCP device tokens carry 24-char hex ids in
 * fields like `sub`, `activeOrgId`, `activeSpaceId`, audit `targetId`, etc.
 * Each entity has a UUID PK; the legacy hex is stored permanently in
 * `legacy_object_id_map(scope, legacy_id, new_id)`.
 *
 * This module is the only place that knows about that translation. Auth and
 * MCP boundary code goes through `translateLegacyId(scope, legacyId)`; once
 * the payload is rewritten, handlers see UUIDs end-to-end.
 *
 * Cached via a simple LRU (size 1024) keyed on `${scope}:${legacyId}`.
 */
import { eq, and } from "drizzle-orm";
import { getDb } from "../pg.js";
import { legacyObjectIdMap } from "./schema.js";

/** Recognised scopes — one per legacy hex-id-keyed entity. */
export type LegacyIdScope =
  | "users"
  | "organizations"
  | "org_memberships"
  | "org_invites"
  | "spaces"
  | "space_memberships"
  | "space_announcements"
  | "teams"
  | "team_memberships"
  | "team_space_grants"
  | "workspace_shares"
  | "project_shares"
  | "audit_events"
  | "notifications"
  | "mcp_device_sessions";

const OBJECT_ID_HEX_RE = /^[0-9a-f]{24}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `s` looks like a 24-char lowercase ObjectId hex string. */
export function isObjectIdHex(s: unknown): s is string {
  return typeof s === "string" && OBJECT_ID_HEX_RE.test(s);
}

/** True iff `s` looks like a canonical UUID (any version, any case). */
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

// ---------- LRU cache ----------

const CACHE_CAPACITY = 1024;
// Insertion-order Map gives us LRU semantics with delete+set on hit.
const cache = new Map<string, string>();

function cacheKey(scope: LegacyIdScope, legacyId: string): string {
  return `${scope}:${legacyId}`;
}

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, value: string): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= CACHE_CAPACITY) {
    // Evict the oldest entry (first key in insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

/** Test-only: clear the in-memory cache. */
export function _resetLegacyIdMapCache(): void {
  cache.clear();
}

/** Test-only: current cache size. */
export function _legacyIdMapCacheSize(): number {
  return cache.size;
}

// ---------- translation ----------

/**
 * Translate a legacy ObjectId hex into the canonical UUID for `scope`.
 * Returns the UUID on success; throws if no row exists in
 * `legacy_object_id_map`. Cache-aware: at most one DB hit per `(scope, id)`
 * within the cache lifetime.
 */
export async function translateLegacyId(
  scope: LegacyIdScope,
  legacyId: string,
): Promise<string> {
  if (!isObjectIdHex(legacyId)) {
    throw new Error(
      `translateLegacyId(${scope}): expected ObjectId hex, got ${JSON.stringify(legacyId)}`,
    );
  }
  const key = cacheKey(scope, legacyId);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const rows = await getDb()
    .select({ newId: legacyObjectIdMap.newId })
    .from(legacyObjectIdMap)
    .where(
      and(eq(legacyObjectIdMap.scope, scope), eq(legacyObjectIdMap.legacyId, legacyId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`legacy id not found: scope=${scope} legacy_id=${legacyId}`);
  }
  cachePut(key, row.newId);
  return row.newId;
}

/**
 * If `id` is a UUID, returns it unchanged. If it's an ObjectId hex, translates
 * via `translateLegacyId`. Anything else throws.
 *
 * Used by the auth boundary where a token field may carry either form.
 */
export async function ensureUuid(scope: LegacyIdScope, id: string): Promise<string> {
  if (isUuid(id)) return id;
  if (isObjectIdHex(id)) return translateLegacyId(scope, id);
  throw new Error(`ensureUuid(${scope}): not a UUID or ObjectId hex: ${JSON.stringify(id)}`);
}
