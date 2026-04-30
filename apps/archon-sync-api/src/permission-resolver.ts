/**
 * Permission resolution against Postgres (post-migration model).
 *
 * Access flows: `note → project → team_projects → team_memberships → user`.
 *
 * The single round-trip in `getEffectiveProjectRoles` joins `team_projects`
 * with `team_memberships` for the caller and folds the resulting per-team
 * roles per-project, taking the maximum (`owner > contributor > viewer`).
 * Org admins and master admins bypass project-level checks via separate
 * predicates so the common path stays a single query.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import type { JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import {
  notes,
  orgMemberships,
  projects,
  teamMemberships,
  teamProjects,
  users,
} from "./db/schema.js";

/** Per-project role granted via a team. */
export type ProjectRole = "owner" | "contributor" | "viewer";

/** Drizzle row shape for a project. */
export type ProjectRow = typeof projects.$inferSelect;
/** Drizzle row shape for a note. */
export type NoteRow = typeof notes.$inferSelect;

const ROLE_RANK: Record<ProjectRole, number> = {
  owner: 3,
  contributor: 2,
  viewer: 1,
};

function upgradeRole(
  out: Map<string, ProjectRole>,
  projectId: string,
  next: ProjectRole,
): void {
  const cur = out.get(projectId);
  if (cur === undefined || ROLE_RANK[next] > ROLE_RANK[cur]) {
    out.set(projectId, next);
  }
}

/**
 * Build the user's effective per-project role map in one round-trip.
 *
 * Joins `team_projects` to `team_memberships` filtered by `user_id`. Folding
 * happens in JS because two teams can grant a user different roles on the
 * same project; we keep the strongest. Org / master-admin overrides are
 * applied by callers so this stays a single targeted query.
 */
export async function getEffectiveProjectRoles(
  userId: string,
): Promise<Map<string, ProjectRole>> {
  const out = new Map<string, ProjectRole>();
  const rows = await getDb().execute<{ project_id: string; role: ProjectRole }>(sql`
    SELECT tp.project_id, tp.role
    FROM ${teamProjects} tp
    JOIN ${teamMemberships} tm ON tm.team_id = tp.team_id
    WHERE tm.user_id = ${userId}
  `);
  // node-postgres surfaces rows on `.rows`; drizzle's typed exec returns the
  // array directly in some configurations.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (rows as any).rows ?? rows;
  for (const r of list as { project_id: string; role: ProjectRole }[]) {
    upgradeRole(out, r.project_id, r.role);
  }
  return out;
}

export async function effectiveRoleInProject(
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const roles = await getEffectiveProjectRoles(userId);
  return roles.get(projectId) ?? null;
}

/**
 * Like {@link effectiveRoleInProject} but also honours the master-admin and
 * org-admin bypasses that REST handlers apply via `userCanReadProject` /
 * `assertCanWriteProject`. Returns "owner" for either bypass so callers can
 * treat the result as a real `ProjectRole` without branching.
 *
 * Use this for surfaces (e.g. Yjs WS auth, periodic revoke-reverify) where
 * the only access check is the role lookup. Without the bypass, a master /
 * org admin who has no `team_projects` grant gets rejected — the symptom
 * looks like `permission-denied` on the WS even though every REST endpoint
 * accepts the same principal. Any place that mirrors REST authorisation
 * should call this, not the raw team-grant variant.
 */
export async function effectiveAccessRoleInProject(
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  if (await isMasterAdmin(userId)) return "owner";
  const project = await findProjectById(projectId);
  if (!project) return null;
  if (await isOrgAdmin(userId, project.orgId)) return "owner";
  return effectiveRoleInProject(userId, projectId);
}

export async function userCanReadProject(
  userId: string,
  projectId: string,
): Promise<boolean> {
  if (await isMasterAdmin(userId)) return true;
  const project = await findProjectById(projectId);
  if (!project) return false;
  if (await isOrgAdmin(userId, project.orgId)) return true;
  const role = await effectiveRoleInProject(userId, projectId);
  return role !== null;
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

async function findProjectById(projectId: string): Promise<ProjectRow | null> {
  const rows = await getDb()
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function deny403(reply: FastifyReply): Promise<null> {
  await reply.status(403).send({ error: "Forbidden" });
  return null;
}

/**
 * 404 (not 403) on read failures so we don't leak project existence to
 * users who shouldn't see it. Org / master admins bypass project-level
 * grants. Otherwise the user must hold any role on the project via a team.
 */
export async function assertCanReadProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<ProjectRow | null> {
  const project = await findProjectById(projectId);
  if (!project) {
    await reply.status(404).send({ error: "Project not found" });
    return null;
  }
  if (await isMasterAdmin(auth.sub)) return project;
  if (await isOrgAdmin(auth.sub, project.orgId)) return project;
  const role = await effectiveRoleInProject(auth.sub, projectId);
  if (!role) {
    await reply.status(404).send({ error: "Project not found" });
    return null;
  }
  return project;
}

/**
 * Write requires `contributor` or `owner` via team grant, OR org admin / master
 * admin. 403 (not 404) on failure because the read gate has already passed —
 * the user knows the project exists.
 */
export async function assertCanWriteProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<ProjectRow | null> {
  const project = await assertCanReadProject(reply, auth, projectId);
  if (!project) return null;
  if (await isMasterAdmin(auth.sub)) return project;
  if (await isOrgAdmin(auth.sub, project.orgId)) return project;
  const role = await effectiveRoleInProject(auth.sub, projectId);
  if (role === "owner" || role === "contributor") return project;
  await reply.status(403).send({ error: "Project is read-only for this user" });
  return null;
}

/**
 * Manage = grant/revoke teams, change project metadata. Requires `owner`
 * via team grant, OR org admin / master admin.
 */
export async function assertCanManageProject(
  reply: FastifyReply,
  auth: JwtPayload,
  projectId: string,
): Promise<ProjectRow | null> {
  const project = await assertCanReadProject(reply, auth, projectId);
  if (!project) return null;
  if (await isMasterAdmin(auth.sub)) return project;
  if (await isOrgAdmin(auth.sub, project.orgId)) return project;
  const role = await effectiveRoleInProject(auth.sub, projectId);
  if (role === "owner") return project;
  return await deny403(reply);
}

/** Boolean probe used for advisory `canWrite` hints in responses. */
export async function userCanWriteProject(
  auth: JwtPayload,
  projectId: string,
): Promise<boolean> {
  if (await isMasterAdmin(auth.sub)) return true;
  const project = await findProjectById(projectId);
  if (!project) return false;
  if (await isOrgAdmin(auth.sub, project.orgId)) return true;
  const role = await effectiveRoleInProject(auth.sub, projectId);
  return role === "owner" || role === "contributor";
}

/**
 * Note-scoped read gate: looks up the note's project and applies the
 * project read check. Returns the project row so handlers that need to
 * cross-check `project.orgId` (e.g. for audit) don't need a second query.
 */
export async function assertCanReadProjectForNote(
  reply: FastifyReply,
  auth: JwtPayload,
  noteId: string,
): Promise<ProjectRow | null> {
  const noteRows = await getDb()
    .select({ projectId: notes.projectId })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  const note = noteRows[0];
  if (!note) {
    await reply.status(404).send({ error: "Note not found" });
    return null;
  }
  return assertCanReadProject(reply, auth, note.projectId);
}

/** Note-scoped write gate. */
export async function assertCanWriteProjectForNote(
  reply: FastifyReply,
  auth: JwtPayload,
  noteId: string,
): Promise<ProjectRow | null> {
  const noteRows = await getDb()
    .select({ projectId: notes.projectId })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  const note = noteRows[0];
  if (!note) {
    await reply.status(404).send({ error: "Note not found" });
    return null;
  }
  return assertCanWriteProject(reply, auth, note.projectId);
}

// Suppress unused-import warning for FastifyRequest (kept for future request-scoped cache).
export type _FR = FastifyRequest;
