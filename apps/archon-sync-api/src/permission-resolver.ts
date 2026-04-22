import type { FastifyReply, FastifyRequest } from "fastify";
import type { JwtPayload } from "./auth.js";
import {
  getOrgMembershipsCollection,
  getProjectSharesCollection,
  getSpaceMembershipsCollection,
  getTeamMembershipsCollection,
  getTeamSpaceGrantsCollection,
  getUsersCollection,
  getWorkspaceSharesCollection,
  getWpnNotesCollection,
  getWpnProjectsCollection,
  getWpnWorkspacesCollection,
  type WpnProjectDoc,
  type WpnWorkspaceDoc,
} from "./db.js";
import type { SpaceRole } from "./org-schemas.js";
import { ObjectId } from "mongodb";

/**
 * Effective per-space role for a user in a single map. Combines:
 *   1. Direct rows in `space_memberships`.
 *   2. Team-mediated rows: every team the user belongs to, every space those
 *      teams have grants on.
 *
 * When two sources both grant access to the same space, **owner wins** over
 * member. This is the single source of truth — every space-scoped check
 * (read, write, member listing) resolves through here.
 */
export async function getEffectiveSpaceRoles(
  userIdHex: string,
): Promise<Map<string, SpaceRole>> {
  const out = new Map<string, SpaceRole>();
  const direct = await getSpaceMembershipsCollection()
    .find({ userId: userIdHex })
    .toArray();
  for (const m of direct) {
    upgradeRole(out, m.spaceId, m.role);
  }
  const teams = await getTeamMembershipsCollection()
    .find({ userId: userIdHex })
    .toArray();
  if (teams.length === 0) {
    return out;
  }
  const grants = await getTeamSpaceGrantsCollection()
    .find({ teamId: { $in: teams.map((t) => t.teamId) } })
    .toArray();
  for (const g of grants) {
    upgradeRole(out, g.spaceId, g.role);
  }
  return out;
}

/** Convenience: just check whether a user has any access to a space. */
export async function userCanReadSpace(
  userIdHex: string,
  spaceIdHex: string,
): Promise<boolean> {
  const roles = await getEffectiveSpaceRoles(userIdHex);
  return roles.has(spaceIdHex);
}

/** Convenience: returns the effective role or null. */
export async function effectiveRoleInSpace(
  userIdHex: string,
  spaceIdHex: string,
): Promise<SpaceRole | null> {
  const roles = await getEffectiveSpaceRoles(userIdHex);
  return roles.get(spaceIdHex) ?? null;
}

/** Priority when combining role sources: higher wins. */
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

async function isMasterAdmin(userIdHex: string): Promise<boolean> {
  try {
    const user = await getUsersCollection().findOne({ _id: new ObjectId(userIdHex) });
    return user?.isMasterAdmin === true;
  } catch {
    return false;
  }
}

async function isOrgAdmin(userIdHex: string, orgId: string | undefined): Promise<boolean> {
  if (!orgId) return false;
  const membership = await getOrgMembershipsCollection().findOne({
    orgId,
    userId: userIdHex,
  });
  return membership?.role === "admin";
}

/**
 * Phase 4 — assert the caller can READ the given workspace, considering:
 *   1. Legacy single-tenant workspaces (no spaceId) still readable only by `userId`.
 *   2. Visibility = public → any space member (direct or team grant).
 *   3. Visibility = private → creator only.
 *   4. Visibility = shared → creator ∪ workspace_shares list (must also be space member).
 *
 * Sends 404 (never 403, to avoid leaking workspace existence) and returns
 * `null` on failure — handlers must early-return.
 */
export async function assertCanReadWorkspace(
  reply: FastifyReply,
  auth: JwtPayload,
  workspaceId: string,
): Promise<WpnWorkspaceDoc | null> {
  const ws = await getWpnWorkspacesCollection().findOne({ id: workspaceId });
  if (!ws) {
    await reply.status(404).send({ error: "Workspace not found" });
    return null;
  }
  // Legacy single-tenant workspaces are owner-only.
  if (!ws.spaceId) {
    if (ws.userId !== auth.sub) {
      await reply.status(404).send({ error: "Workspace not found" });
      return null;
    }
    return ws;
  }
  // Org admin of the workspace's org can always read, even without direct space membership.
  if (ws.orgId) {
    const orgMembership = await getOrgMembershipsCollection().findOne({
      orgId: ws.orgId,
      userId: auth.sub,
    });
    if (orgMembership?.role === "admin") {
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
  const share = await getWorkspaceSharesCollection().findOne({
    workspaceId,
    userId: auth.sub,
  });
  if (share) {
    return ws;
  }
  await reply.status(404).send({ error: "Workspace not found" });
  return null;
}

/**
 * Non-reply-writing variant of {@link assertCanReadWorkspace}. Used when we
 * need to test readability of a target user's access *without* short-circuiting
 * the request — e.g. validating that a share-grant target already has parent
 * workspace access.
 */
export async function userCanReadWorkspace(
  userIdHex: string,
  workspaceId: string,
): Promise<boolean> {
  const ws = await getWpnWorkspacesCollection().findOne({ id: workspaceId });
  if (!ws) return false;
  if (!ws.spaceId) return ws.userId === userIdHex;
  if (await isMasterAdmin(userIdHex)) return true;
  if (await isOrgAdmin(userIdHex, ws.orgId)) return true;
  const roles = await getEffectiveSpaceRoles(userIdHex);
  const spaceRole = roles.get(ws.spaceId);
  if (!spaceRole) return false;
  const visibility = ws.visibility ?? "public";
  const creator = ws.creatorUserId ?? ws.userId;
  if (visibility === "public") return true;
  if (visibility === "private") {
    return creator === userIdHex || spaceRole === "owner";
  }
  // shared
  if (creator === userIdHex || spaceRole === "owner") return true;
  const share = await getWorkspaceSharesCollection().findOne({
    workspaceId,
    userId: userIdHex,
  });
  return share !== null;
}

/**
 * Phase 4/8 — assert the caller can WRITE to the given workspace.
 * Order of checks:
 *   1. Org admin of the workspace's org — always writes (admin override).
 *   2. Space `owner` — always writes.
 *   3. Workspace creator — writes their own.
 *   4. Writer share (Phase 8) — upgrades a space-viewer to write on this workspace.
 *   5. Space `viewer` without writer share — 403.
 * Legacy `userId`-owned workspaces (no `spaceId`): only the legacy owner.
 */
export async function assertCanWriteWorkspace(
  reply: FastifyReply,
  auth: JwtPayload,
  workspaceId: string,
): Promise<WpnWorkspaceDoc | null> {
  const ws = await assertCanReadWorkspace(reply, auth, workspaceId);
  if (!ws) {
    return null;
  }
  if (!ws.spaceId) {
    return ws;
  }
  if (ws.orgId) {
    const orgMembership = await getOrgMembershipsCollection().findOne({
      orgId: ws.orgId,
      userId: auth.sub,
    });
    if (orgMembership?.role === "admin") {
      return ws;
    }
  }
  const roles = await getEffectiveSpaceRoles(auth.sub);
  const role = roles.get(ws.spaceId);
  if (role === "owner") {
    return ws;
  }
  const creator = ws.creatorUserId ?? ws.userId;
  if (creator === auth.sub) {
    return ws;
  }
  // Phase 8: writer share upgrades to write (can upgrade a viewer).
  const share = await getWorkspaceSharesCollection().findOne({
    workspaceId,
    userId: auth.sub,
  });
  if (share?.role === "writer") {
    return ws;
  }
  await reply.status(403).send({ error: "Workspace is read-only for this user" });
  return null;
}

/**
 * Phase 8 — assert the caller has manage rights on a workspace (change
 * visibility, mutate shares). Allow: master admin, org admin, space owner,
 * workspace creator. Writers cannot manage.
 */
export async function assertCanManageWorkspace(
  reply: FastifyReply,
  auth: JwtPayload,
  workspaceId: string,
): Promise<WpnWorkspaceDoc | null> {
  const ws = await assertCanReadWorkspace(reply, auth, workspaceId);
  if (!ws) {
    return null;
  }
  if (!ws.spaceId) {
    // Legacy single-tenant: only the owner manages.
    return ws.userId === auth.sub ? ws : (await deny403(reply));
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

/**
 * Phase 8 — assert the caller can READ the given project. Workspace read is a
 * strict prerequisite: if workspace access fails, the call returns `null`
 * (404 already written). After the workspace gate, project visibility applies.
 */
export async function assertCanReadProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<{ workspace: WpnWorkspaceDoc; project: WpnProjectDoc } | null> {
  const project = await getWpnProjectsCollection().findOne({ id: projectId });
  if (!project) {
    await reply.status(404).send({ error: "Project not found" });
    return null;
  }
  const workspace = await assertCanReadWorkspace(reply, auth, project.workspace_id);
  if (!workspace) {
    return null;
  }
  // Override set: master admin / org admin / space owner always see projects.
  if (workspace.spaceId) {
    if (await isMasterAdmin(auth.sub)) return { workspace, project };
    if (await isOrgAdmin(auth.sub, workspace.orgId)) return { workspace, project };
    const roles = await getEffectiveSpaceRoles(auth.sub);
    if (roles.get(workspace.spaceId) === "owner") return { workspace, project };
  }
  const visibility = project.visibility ?? "public";
  const creator = project.creatorUserId ?? project.userId;
  if (visibility === "public") {
    return { workspace, project };
  }
  if (visibility === "private") {
    if (creator === auth.sub) return { workspace, project };
    await reply.status(404).send({ error: "Project not found" });
    return null;
  }
  // shared: creator ∪ project_shares list.
  if (creator === auth.sub) return { workspace, project };
  const share = await getProjectSharesCollection().findOne({
    projectId,
    userId: auth.sub,
  });
  if (share) {
    return { workspace, project };
  }
  await reply.status(404).send({ error: "Project not found" });
  return null;
}

/**
 * Phase 8 — assert the caller can WRITE to the given project. Requires
 * workspace-write first, then project visibility check. A reader-share on a
 * shared project denies write even if workspace-write passed.
 */
export async function assertCanWriteProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<{ workspace: WpnWorkspaceDoc; project: WpnProjectDoc } | null> {
  const project = await getWpnProjectsCollection().findOne({ id: projectId });
  if (!project) {
    await reply.status(404).send({ error: "Project not found" });
    return null;
  }
  const workspace = await assertCanWriteWorkspace(reply, auth, project.workspace_id);
  if (!workspace) {
    return null;
  }
  // Override set bypasses project visibility.
  if (workspace.spaceId) {
    if (await isMasterAdmin(auth.sub)) return { workspace, project };
    if (await isOrgAdmin(auth.sub, workspace.orgId)) return { workspace, project };
    const roles = await getEffectiveSpaceRoles(auth.sub);
    if (roles.get(workspace.spaceId) === "owner") return { workspace, project };
  }
  const visibility = project.visibility ?? "public";
  const creator = project.creatorUserId ?? project.userId;
  if (visibility === "public") {
    return { workspace, project };
  }
  if (visibility === "private") {
    if (creator === auth.sub) return { workspace, project };
    await reply.status(403).send({ error: "Project is read-only for this user" });
    return null;
  }
  // shared
  if (creator === auth.sub) return { workspace, project };
  const share = await getProjectSharesCollection().findOne({
    projectId,
    userId: auth.sub,
  });
  if (share?.role === "writer") {
    return { workspace, project };
  }
  await reply.status(403).send({ error: "Project is read-only for this user" });
  return null;
}

/**
 * Non-throwing write-permission probe for a project. Mirrors the branch
 * structure of {@link assertCanWriteProject} but returns a boolean without
 * touching the reply — used by responses that want to include an advisory
 * `canWrite` hint (e.g. `GET /wpn/notes/:id`) so the client can disable
 * edit UI before the user tries to save.
 */
export async function userCanWriteProject(
  auth: JwtPayload,
  projectId: string,
): Promise<boolean> {
  const project = await getWpnProjectsCollection().findOne({ id: projectId });
  if (!project) return false;
  const workspace = await getWpnWorkspacesCollection().findOne({
    id: project.workspace_id,
  });
  if (!workspace) return false;
  // Workspace read prerequisite (same gate used by `assertCanReadWorkspace`).
  if (!(await userCanReadWorkspace(auth.sub, workspace.id))) return false;

  // Workspace write (mirrors `assertCanWriteWorkspace`).
  let wsWrite = false;
  if (!workspace.spaceId) {
    // Legacy single-tenant: only the legacy owner writes.
    wsWrite = workspace.userId === auth.sub;
  } else {
    if (workspace.orgId) {
      const orgMembership = await getOrgMembershipsCollection().findOne({
        orgId: workspace.orgId,
        userId: auth.sub,
      });
      if (orgMembership?.role === "admin") wsWrite = true;
    }
    if (!wsWrite) {
      const roles = await getEffectiveSpaceRoles(auth.sub);
      if (roles.get(workspace.spaceId) === "owner") wsWrite = true;
    }
    if (!wsWrite) {
      const wsCreator = workspace.creatorUserId ?? workspace.userId;
      if (wsCreator === auth.sub) wsWrite = true;
    }
    if (!wsWrite) {
      const wsShare = await getWorkspaceSharesCollection().findOne({
        workspaceId: workspace.id,
        userId: auth.sub,
      });
      if (wsShare?.role === "writer") wsWrite = true;
    }
  }
  if (!wsWrite) return false;

  // Project write (mirrors `assertCanWriteProject` overrides + visibility).
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
  // shared
  if (creator === auth.sub) return true;
  const share = await getProjectSharesCollection().findOne({
    projectId: project.id,
    userId: auth.sub,
  });
  return share?.role === "writer";
}

/**
 * Phase 8 — assert manage rights on a project (change visibility, mutate
 * shares). Allow: master admin, org admin, space owner, project creator,
 * workspace creator. Writers explicitly cannot manage.
 */
export async function assertCanManageProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<{ workspace: WpnWorkspaceDoc; project: WpnProjectDoc } | null> {
  const readResult = await assertCanReadProject(reply, auth, projectId);
  if (!readResult) return null;
  const { workspace, project } = readResult;
  if (!workspace.spaceId) {
    return workspace.userId === auth.sub ? readResult : (await deny403(reply));
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

/** Read access derived from a note ID (looks up project then workspace). */
export async function assertCanReadWorkspaceForNote(
  reply: FastifyReply,
  auth: JwtPayload,
  noteId: string,
): Promise<WpnWorkspaceDoc | null> {
  const note = await getWpnNotesCollection().findOne({ id: noteId });
  if (!note) {
    await reply.status(404).send({ error: "Note not found" });
    return null;
  }
  const result = await assertCanReadProject(reply, auth, note.project_id);
  return result?.workspace ?? null;
}

/** Write access derived from a note ID. */
export async function assertCanWriteWorkspaceForNote(
  reply: FastifyReply,
  auth: JwtPayload,
  noteId: string,
): Promise<WpnWorkspaceDoc | null> {
  const note = await getWpnNotesCollection().findOne({ id: noteId });
  if (!note) {
    await reply.status(404).send({ error: "Note not found" });
    return null;
  }
  const result = await assertCanWriteProject(reply, auth, note.project_id);
  return result?.workspace ?? null;
}

// Suppress unused-import warning for FastifyRequest (kept for future request-scoped cache).
export type _FR = FastifyRequest;
