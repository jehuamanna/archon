import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import type { JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import { orgMemberships, spaceMemberships, spaces } from "./db/schema.js";
import type { SpaceRole } from "./org-schemas.js";
import { effectiveRoleInSpace } from "./permission-resolver.js";
import {
  ensureUuid,
  isObjectIdHex,
  isUuid,
} from "./db/legacy-id-map.js";

/** PG-row shape for space records used as return types. */
export type SpaceRow = typeof spaces.$inferSelect;
export type SpaceMembershipRow = typeof spaceMemberships.$inferSelect;

export type SpaceContext = {
  space: SpaceRow;
  role: SpaceRole;
};

export async function getSpaceMembership(
  userId: string,
  spaceId: string,
): Promise<SpaceMembershipRow | null> {
  const rows = await getDb()
    .select()
    .from(spaceMemberships)
    .where(
      and(
        eq(spaceMemberships.spaceId, spaceId),
        eq(spaceMemberships.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listSpaceMembershipsForUser(
  userId: string,
): Promise<SpaceMembershipRow[]> {
  return getDb()
    .select()
    .from(spaceMemberships)
    .where(eq(spaceMemberships.userId, userId));
}

/**
 * Tolerant id resolver for callers that may still pass a legacy ObjectId hex
 * via URL params. Returns the canonical UUID, or null if the input is neither
 * a UUID nor a known legacy id.
 */
async function resolveSpaceId(spaceId: string): Promise<string | null> {
  if (isUuid(spaceId)) return spaceId;
  if (isObjectIdHex(spaceId)) {
    try {
      return await ensureUuid("spaces", spaceId);
    } catch {
      return null;
    }
  }
  return null;
}

async function loadSpace(spaceId: string): Promise<SpaceRow | null> {
  const canonical = await resolveSpaceId(spaceId);
  if (!canonical) return null;
  const rows = await getDb()
    .select()
    .from(spaces)
    .where(eq(spaces.id, canonical))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireSpaceRole(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  spaceId: string,
  required: SpaceRole,
): Promise<SpaceContext | null> {
  const space = await loadSpace(spaceId);
  if (!space) {
    await reply.status(404).send({ error: "Space not found" });
    return null;
  }
  const role = await effectiveRoleInSpace(auth.sub, space.id);
  if (!role) {
    await reply.status(404).send({ error: "Space not found" });
    return null;
  }
  if (required === "owner" && role !== "owner") {
    await reply.status(403).send({ error: "Space owner role required" });
    return null;
  }
  return { space, role };
}

export async function requireSpaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  spaceId: string,
): Promise<SpaceContext | null> {
  return requireSpaceRole(request, reply, auth, spaceId, "member");
}

/** Space owner OR org admin (implicit cross-space CRUD). */
export async function requireSpaceManage(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  spaceId: string,
): Promise<SpaceContext | null> {
  const space = await loadSpace(spaceId);
  if (!space) {
    await reply.status(404).send({ error: "Space not found" });
    return null;
  }
  const spaceRole = await effectiveRoleInSpace(auth.sub, space.id);
  if (spaceRole === "owner") {
    return { space, role: spaceRole };
  }
  const orgRows = await getDb()
    .select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, space.orgId),
        eq(orgMemberships.userId, auth.sub),
      ),
    )
    .limit(1);
  if (orgRows[0]?.role === "admin") {
    return { space, role: spaceRole ?? "owner" };
  }
  await reply.status(403).send({ error: "Space owner role required" });
  return null;
}

/** Active space resolution priority: header → JWT claim → caller's default. */
export function resolveActiveSpaceId(
  request: FastifyRequest,
  auth: JwtPayload,
): string | null {
  const header = request.headers["x-archon-space"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  if (typeof auth.activeSpaceId === "string" && auth.activeSpaceId.trim()) {
    return auth.activeSpaceId.trim();
  }
  return null;
}
