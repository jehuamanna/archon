import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import type { JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import { orgMemberships, users } from "./db/schema.js";
import type { OrgRole } from "./org-schemas.js";
import { isUuid } from "./db/legacy-id-map.js";

export type OrgContext = {
  orgId: string;
  role: OrgRole;
};

/** PG-row shape replacing the Mongo OrgMembershipDoc for return types. */
export type OrgMembershipRow = typeof orgMemberships.$inferSelect;

export async function getOrgMembership(
  userId: string,
  orgId: string,
): Promise<OrgMembershipRow | null> {
  const rows = await getDb()
    .select()
    .from(orgMemberships)
    .where(
      and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listMembershipsForUser(
  userId: string,
): Promise<OrgMembershipRow[]> {
  return getDb()
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, userId));
}

/** Authorize against `orgId`; sends response and returns null on failure. */
export async function requireOrgRole(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  orgId: string,
  required: OrgRole,
): Promise<OrgContext | null> {
  const membership = await getOrgMembership(auth.sub, orgId);
  if (!membership) {
    await reply.status(404).send({ error: "Organization not found" });
    return null;
  }
  if (required === "admin" && membership.role !== "admin") {
    await reply.status(403).send({ error: "Admin role required" });
    return null;
  }
  return { orgId, role: membership.role as OrgRole };
}

/** Org admin OR platform master admin. Master admins not enrolled in the org get role='admin'. */
export async function requireOrgAdminOrMaster(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  orgId: string,
): Promise<OrgContext | null> {
  if (!isUuid(auth.sub)) {
    await reply.status(401).send({ error: "Invalid session" });
    return null;
  }
  const userRows = await getDb()
    .select({ flag: users.isMasterAdmin })
    .from(users)
    .where(eq(users.id, auth.sub))
    .limit(1);
  if (userRows[0]?.flag === true) {
    return { orgId, role: "admin" };
  }
  return requireOrgRole(request, reply, auth, orgId, "admin");
}

export async function requireOrgMember(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  orgId: string,
): Promise<OrgContext | null> {
  const membership = await getOrgMembership(auth.sub, orgId);
  if (!membership) {
    await reply.status(404).send({ error: "Organization not found" });
    return null;
  }
  return { orgId, role: membership.role as OrgRole };
}

/**
 * Resolve the active org id for the request. Priority:
 *   1. `X-Archon-Org` header
 *   2. JWT `activeOrgId` claim
 *   3. caller's `defaultOrgId` (callers do this lookup themselves)
 */
export function resolveActiveOrgId(
  request: FastifyRequest,
  auth: JwtPayload,
): string | null {
  const header = request.headers["x-archon-org"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  if (typeof auth.activeOrgId === "string" && auth.activeOrgId.trim()) {
    return auth.activeOrgId.trim();
  }
  return null;
}
