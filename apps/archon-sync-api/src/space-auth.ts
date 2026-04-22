import type { FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import type { JwtPayload } from "./auth.js";
import {
  getOrgMembershipsCollection,
  getSpaceMembershipsCollection,
  getSpacesCollection,
} from "./db.js";
import type { SpaceDoc, SpaceMembershipDoc, SpaceRole } from "./org-schemas.js";
import { effectiveRoleInSpace } from "./permission-resolver.js";

export type SpaceContext = {
  space: SpaceDoc;
  role: SpaceRole;
};

export async function getSpaceMembership(
  userIdHex: string,
  spaceIdHex: string,
): Promise<SpaceMembershipDoc | null> {
  return getSpaceMembershipsCollection().findOne({
    spaceId: spaceIdHex,
    userId: userIdHex,
  });
}

export async function listSpaceMembershipsForUser(
  userIdHex: string,
): Promise<SpaceMembershipDoc[]> {
  return getSpaceMembershipsCollection().find({ userId: userIdHex }).toArray();
}

function isObjectIdHex(s: string): boolean {
  return /^[a-f0-9]{24}$/i.test(s);
}

async function loadSpace(spaceIdHex: string): Promise<SpaceDoc | null> {
  if (!isObjectIdHex(spaceIdHex)) {
    return null;
  }
  return getSpacesCollection().findOne({ _id: new ObjectId(spaceIdHex) });
}

/**
 * Resolves the space + the caller's effective role (direct membership ∪
 * team grants). Sends a response and returns `null` on failure — handlers
 * must early-return on `null`.
 */
export async function requireSpaceRole(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  spaceIdHex: string,
  required: SpaceRole,
): Promise<SpaceContext | null> {
  const space = await loadSpace(spaceIdHex);
  if (!space) {
    await reply.status(404).send({ error: "Space not found" });
    return null;
  }
  const role = await effectiveRoleInSpace(auth.sub, spaceIdHex);
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
  spaceIdHex: string,
): Promise<SpaceContext | null> {
  return requireSpaceRole(request, reply, auth, spaceIdHex, "member");
}

/**
 * Authorize a management action on a space: caller must be the space `owner`
 * OR an `admin` of the parent org. Org admins get implicit CRUD + member
 * management over every space in their org, regardless of direct space
 * membership. Sends 404/403 on failure.
 */
export async function requireSpaceManage(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  spaceIdHex: string,
): Promise<SpaceContext | null> {
  const space = await loadSpace(spaceIdHex);
  if (!space) {
    await reply.status(404).send({ error: "Space not found" });
    return null;
  }
  const spaceRole = await effectiveRoleInSpace(auth.sub, spaceIdHex);
  if (spaceRole === "owner") {
    return { space, role: spaceRole };
  }
  const orgMembership = await getOrgMembershipsCollection().findOne({
    orgId: space.orgId,
    userId: auth.sub,
  });
  if (orgMembership?.role === "admin") {
    return { space, role: spaceRole ?? "owner" };
  }
  await reply.status(403).send({ error: "Space owner role required" });
  return null;
}

/**
 * Active space resolution priority:
 *   1. `X-Archon-Space` header
 *   2. JWT `activeSpaceId` claim (Phase 2.x)
 *   3. caller's default space in active org (callers do this lookup)
 */
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
