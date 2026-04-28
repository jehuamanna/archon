/**
 * Permission resolution against Postgres.
 *
 * `getEffectiveSpaceRoles` is a single UNION query joining `space_memberships`
 * and `team_space_grants`; we fold by `(spaceId, role)` in JS picking owner >
 * member > viewer.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import type { JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import {
  orgMemberships,
  projectShares,
  spaceMemberships,
  teamMemberships,
  teamSpaceGrants,
  users,
  workspaceShares,
  wpnNotes,
  wpnProjects,
  wpnWorkspaces,
} from "./db/schema.js";
import type { SpaceRole } from "./org-schemas.js";

/** Drizzle row shape for a workspace. */
export type WorkspaceRow = typeof wpnWorkspaces.$inferSelect;
/** Drizzle row shape for a project. */
export type ProjectRow = typeof wpnProjects.$inferSelect;

/**
 * Effective per-space role for a user. Combines direct
 * `space_memberships` and team-mediated `team_space_grants`. Owner wins
 * over member wins over viewer.
 */
export async function getEffectiveSpaceRoles(
  userId: string,
): Promise<Map<string, SpaceRole>> {
  const out = new Map<string, SpaceRole>();
  // Single round-trip: union of direct memberships and team grants.
  const rows = await getDb().execute<{ space_id: string; role: SpaceRole }>(sql`
    SELECT space_id, role FROM ${spaceMemberships} WHERE user_id = ${userId}
    UNION ALL
    SELECT g.space_id, g.role
    FROM ${teamSpaceGrants} g
    JOIN ${teamMemberships} m ON m.team_id = g.team_id
    WHERE m.user_id = ${userId}
  `);
  // drizzle returns rows on `.rows` for the node-postgres driver.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (rows as any).rows ?? rows;
  for (const r of list as { space_id: string; role: SpaceRole }[]) {
    upgradeRole(out, r.space_id, r.role);
  }
  return out;
}

export async function userCanReadSpace(
  userId: string,
  spaceId: string,
): Promise<boolean> {
  const roles = await getEffectiveSpaceRoles(userId);
  return roles.has(spaceId);
}

export async function effectiveRoleInSpace(
  userId: string,
  spaceId: string,
): Promise<SpaceRole | null> {
  const roles = await getEffectiveSpaceRoles(userId);
  return roles.get(spaceId) ?? null;
}

const ROLE_RANK: Record<SpaceRole, number> = { owner: 3, member: 2, viewer: 1 };

function upgradeRole(
  out: Map<string, SpaceRole>,
  spaceId: string,
  next: SpaceRole,
): void {
  const cur = out.get(spaceId);
  if (cur === undefined || ROLE_RANK[next] > ROLE_RANK[cur]) {
    out.set(spaceId, next);
  }
}

async function isMasterAdmin(userId: string): Promise<boolean> {
  try {
    const rows = await getDb()
      .select({ flag: users.isMasterAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.flag === true;
  } catch {
    return false;
  }
}

async function isOrgAdmin(
  userId: string,
  orgId: string | null | undefined,
): Promise<boolean> {
  if (!orgId) return false;
  const rows = await getDb()
    .select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1);
  return rows[0]?.role === "admin";
}

async function findWorkspaceById(workspaceId: string): Promise<WorkspaceRow | null> {
  const rows = await getDb()
    .select()
    .from(wpnWorkspaces)
    .where(eq(wpnWorkspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

async function findProjectById(projectId: string): Promise<ProjectRow | null> {
  const rows = await getDb()
    .select()
    .from(wpnProjects)
    .where(eq(wpnProjects.id, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function findWorkspaceShare(
  workspaceId: string,
  userId: string,
): Promise<{ role: string } | null> {
  const rows = await getDb()
    .select({ role: workspaceShares.role })
    .from(workspaceShares)
    .where(
      and(
        eq(workspaceShares.workspaceId, workspaceId),
        eq(workspaceShares.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function findProjectShare(
  projectId: string,
  userId: string,
): Promise<{ role: string } | null> {
  const rows = await getDb()
    .select({ role: projectShares.role })
    .from(projectShares)
    .where(
      and(eq(projectShares.projectId, projectId), eq(projectShares.userId, userId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Phase 4 — assert the caller can READ the given workspace. 404 (never 403)
 * to avoid leaking workspace existence; returns null on failure so handlers
 * can early-return.
 */
export async function assertCanReadWorkspace(
  reply: FastifyReply,
  auth: JwtPayload,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  const ws = await findWorkspaceById(workspaceId);
  if (!ws) {
    await reply.status(404).send({ error: "Workspace not found" });
    return null;
  }
  if (!ws.spaceId) {
    if (ws.userId !== auth.sub) {
      await reply.status(404).send({ error: "Workspace not found" });
      return null;
    }
    return ws;
  }
  if (ws.orgId) {
    if (await isOrgAdmin(auth.sub, ws.orgId)) {
      return ws;
    }
  }
  const roles = await getEffectiveSpaceRoles(auth.sub);
  const spaceRole = roles.get(ws.spaceId);
  if (!spaceRole) {
    await reply.status(404).send({ error: "Workspace not found" });
    return null;
  }
  const visibility = ws.visibility ?? "public";
  const creator = ws.creatorUserId ?? ws.userId;
  if (visibility === "public") {
    return ws;
  }
  if (visibility === "private") {
    if (creator === auth.sub || spaceRole === "owner") {
      return ws;
    }
    await reply.status(404).send({ error: "Workspace not found" });
    return null;
  }
  // shared
  if (creator === auth.sub || spaceRole === "owner") {
    return ws;
  }
  const share = await findWorkspaceShare(workspaceId, auth.sub);
  if (share) {
    return ws;
  }
  await reply.status(404).send({ error: "Workspace not found" });
  return null;
}

/** Non-reply variant: tests readability without short-circuiting. */
export async function userCanReadWorkspace(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const ws = await findWorkspaceById(workspaceId);
  if (!ws) return false;
  if (!ws.spaceId) return ws.userId === userId;
  if (await isMasterAdmin(userId)) return true;
  if (await isOrgAdmin(userId, ws.orgId)) return true;
  const roles = await getEffectiveSpaceRoles(userId);
  const spaceRole = roles.get(ws.spaceId);
  if (!spaceRole) return false;
  const visibility = ws.visibility ?? "public";
  const creator = ws.creatorUserId ?? ws.userId;
  if (visibility === "public") return true;
  if (visibility === "private") {
    return creator === userId || spaceRole === "owner";
  }
  if (creator === userId || spaceRole === "owner") return true;
  const share = await findWorkspaceShare(workspaceId, userId);
  return share !== null;
}

/** Phase 4/8 — write to workspace. */
export async function assertCanWriteWorkspace(
  reply: FastifyReply,
  auth: JwtPayload,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  const ws = await assertCanReadWorkspace(reply, auth, workspaceId);
  if (!ws) return null;
  if (!ws.spaceId) return ws;
  if (ws.orgId) {
    if (await isOrgAdmin(auth.sub, ws.orgId)) return ws;
  }
  const roles = await getEffectiveSpaceRoles(auth.sub);
  const role = roles.get(ws.spaceId);
  if (role === "owner") return ws;
  const creator = ws.creatorUserId ?? ws.userId;
  if (creator === auth.sub) return ws;
  const share = await findWorkspaceShare(workspaceId, auth.sub);
  if (share?.role === "writer") return ws;
  await reply.status(403).send({ error: "Workspace is read-only for this user" });
  return null;
}

/** Phase 8 — manage rights on a workspace. */
export async function assertCanManageWorkspace(
  reply: FastifyReply,
  auth: JwtPayload,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  const ws = await assertCanReadWorkspace(reply, auth, workspaceId);
  if (!ws) return null;
  if (!ws.spaceId) {
    return ws.userId === auth.sub ? ws : await deny403(reply);
  }
  if (await isMasterAdmin(auth.sub)) return ws;
  if (await isOrgAdmin(auth.sub, ws.orgId)) return ws;
  const roles = await getEffectiveSpaceRoles(auth.sub);
  if (roles.get(ws.spaceId) === "owner") return ws;
  const creator = ws.creatorUserId ?? ws.userId;
  if (creator === auth.sub) return ws;
  return await deny403(reply);
}

async function deny403(reply: FastifyReply): Promise<null> {
  await reply.status(403).send({ error: "Forbidden" });
  return null;
}

/** Phase 8 — read project: workspace gate first, then project visibility. */
export async function assertCanReadProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<{ workspace: WorkspaceRow; project: ProjectRow } | null> {
  const project = await findProjectById(projectId);
  if (!project) {
    await reply.status(404).send({ error: "Project not found" });
    return null;
  }
  const workspace = await assertCanReadWorkspace(reply, auth, project.workspace_id);
  if (!workspace) return null;
  if (workspace.spaceId) {
    if (await isMasterAdmin(auth.sub)) return { workspace, project };
    if (await isOrgAdmin(auth.sub, workspace.orgId)) return { workspace, project };
    const roles = await getEffectiveSpaceRoles(auth.sub);
    if (roles.get(workspace.spaceId) === "owner") return { workspace, project };
  }
  const visibility = project.visibility ?? "public";
  const creator = project.creatorUserId ?? project.userId;
  if (visibility === "public") return { workspace, project };
  if (visibility === "private") {
    if (creator === auth.sub) return { workspace, project };
    await reply.status(404).send({ error: "Project not found" });
    return null;
  }
  if (creator === auth.sub) return { workspace, project };
  const share = await findProjectShare(projectId, auth.sub);
  if (share) return { workspace, project };
  await reply.status(404).send({ error: "Project not found" });
  return null;
}

/** Phase 8 — write project. */
export async function assertCanWriteProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<{ workspace: WorkspaceRow; project: ProjectRow } | null> {
  const project = await findProjectById(projectId);
  if (!project) {
    await reply.status(404).send({ error: "Project not found" });
    return null;
  }
  const workspace = await assertCanWriteWorkspace(reply, auth, project.workspace_id);
  if (!workspace) return null;
  if (workspace.spaceId) {
    if (await isMasterAdmin(auth.sub)) return { workspace, project };
    if (await isOrgAdmin(auth.sub, workspace.orgId)) return { workspace, project };
    const roles = await getEffectiveSpaceRoles(auth.sub);
    if (roles.get(workspace.spaceId) === "owner") return { workspace, project };
  }
  const visibility = project.visibility ?? "public";
  const creator = project.creatorUserId ?? project.userId;
  if (visibility === "public") return { workspace, project };
  if (visibility === "private") {
    if (creator === auth.sub) return { workspace, project };
    await reply.status(403).send({ error: "Project is read-only for this user" });
    return null;
  }
  if (creator === auth.sub) return { workspace, project };
  const share = await findProjectShare(projectId, auth.sub);
  if (share?.role === "writer") return { workspace, project };
  await reply.status(403).send({ error: "Project is read-only for this user" });
  return null;
}

/** Boolean probe used for advisory `canWrite` hints in responses. */
export async function userCanWriteProject(
  auth: JwtPayload,
  projectId: string,
): Promise<boolean> {
  const project = await findProjectById(projectId);
  if (!project) return false;
  const workspace = await findWorkspaceById(project.workspace_id);
  if (!workspace) return false;
  if (!(await userCanReadWorkspace(auth.sub, workspace.id))) return false;

  let wsWrite = false;
  if (!workspace.spaceId) {
    wsWrite = workspace.userId === auth.sub;
  } else {
    if (workspace.orgId && (await isOrgAdmin(auth.sub, workspace.orgId))) wsWrite = true;
    if (!wsWrite) {
      const roles = await getEffectiveSpaceRoles(auth.sub);
      if (roles.get(workspace.spaceId) === "owner") wsWrite = true;
    }
    if (!wsWrite) {
      const wsCreator = workspace.creatorUserId ?? workspace.userId;
      if (wsCreator === auth.sub) wsWrite = true;
    }
    if (!wsWrite) {
      const wsShare = await findWorkspaceShare(workspace.id, auth.sub);
      if (wsShare?.role === "writer") wsWrite = true;
    }
  }
  if (!wsWrite) return false;

  if (workspace.spaceId) {
    if (await isMasterAdmin(auth.sub)) return true;
    if (await isOrgAdmin(auth.sub, workspace.orgId)) return true;
    const roles = await getEffectiveSpaceRoles(auth.sub);
    if (roles.get(workspace.spaceId) === "owner") return true;
  }
  const visibility = project.visibility ?? "public";
  const creator = project.creatorUserId ?? project.userId;
  if (visibility === "public") return true;
  if (visibility === "private") return creator === auth.sub;
  if (creator === auth.sub) return true;
  const share = await findProjectShare(project.id, auth.sub);
  return share?.role === "writer";
}

/** Phase 8 — manage project. */
export async function assertCanManageProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<{ workspace: WorkspaceRow; project: ProjectRow } | null> {
  const readResult = await assertCanReadProject(reply, auth, projectId);
  if (!readResult) return null;
  const { workspace, project } = readResult;
  if (!workspace.spaceId) {
    return workspace.userId === auth.sub ? readResult : await deny403(reply);
  }
  if (await isMasterAdmin(auth.sub)) return readResult;
  if (await isOrgAdmin(auth.sub, workspace.orgId)) return readResult;
  const roles = await getEffectiveSpaceRoles(auth.sub);
  if (roles.get(workspace.spaceId) === "owner") return readResult;
  const projectCreator = project.creatorUserId ?? project.userId;
  if (projectCreator === auth.sub) return readResult;
  const wsCreator = workspace.creatorUserId ?? workspace.userId;
  if (wsCreator === auth.sub) return readResult;
  return await deny403(reply);
}

/** Read access derived from a note id (looks up project then workspace). */
export async function assertCanReadWorkspaceForNote(
  reply: FastifyReply,
  auth: JwtPayload,
  noteId: string,
): Promise<WorkspaceRow | null> {
  const noteRows = await getDb()
    .select({ project_id: wpnNotes.project_id })
    .from(wpnNotes)
    .where(eq(wpnNotes.id, noteId))
    .limit(1);
  const note = noteRows[0];
  if (!note) {
    await reply.status(404).send({ error: "Note not found" });
    return null;
  }
  const result = await assertCanReadProject(reply, auth, note.project_id);
  return result?.workspace ?? null;
}

/** Write access derived from a note id. */
export async function assertCanWriteWorkspaceForNote(
  reply: FastifyReply,
  auth: JwtPayload,
  noteId: string,
): Promise<WorkspaceRow | null> {
  const noteRows = await getDb()
    .select({ project_id: wpnNotes.project_id })
    .from(wpnNotes)
    .where(eq(wpnNotes.id, noteId))
    .limit(1);
  const note = noteRows[0];
  if (!note) {
    await reply.status(404).send({ error: "Note not found" });
    return null;
  }
  const result = await assertCanWriteProject(reply, auth, note.project_id);
  return result?.workspace ?? null;
}

// Suppress unused-import warning for FastifyRequest (kept for future request-scoped cache).
export type _FR = FastifyRequest;
