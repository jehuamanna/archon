import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { requireAuth, type JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import {
  orgMemberships,
  projectShares,
  spaces,
  users,
  workspaceShares,
  wpnExplorerState,
  wpnNotes,
  wpnProjects,
  wpnWorkspaces,
} from "./db/schema.js";
import {
  assertCanReadProject,
  assertCanReadWorkspace,
  assertCanReadWorkspaceForNote,
  effectiveRoleInSpace,
  userCanWriteProject,
  type WorkspaceRow,
  type ProjectRow,
} from "./permission-resolver.js";
import { resolveActiveSpaceId } from "./space-auth.js";
import {
  ensureDefaultSpaceForOrg,
  getDefaultSpaceIdForOrg,
} from "./org-defaults.js";
import type { SpaceRole } from "./org-schemas.js";
import {
  buildNoteSearchHints,
  type NoteSearchHints,
} from "./note-search-hints.js";
import {
  buildVfsBacklinkTarget,
  contentReferencesTargetViaVfs,
} from "./note-backlinks-vfs.js";
import { isUuid } from "./db/legacy-id-map.js";

type NoteRow = typeof wpnNotes.$inferSelect;
type UserRow = typeof users.$inferSelect;

/** Minimal markdown link → note id extraction for backlink scanning. */
function collectReferencedNoteIdsFromMarkdown(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const href = (m[2] ?? "").trim();
    const id = parseNoteIdFromInternalMarkdownHref(href);
    if (id) out.add(id);
  }
  return out;
}

function parseNoteIdFromInternalMarkdownHref(href: string): string | null {
  const raw = href.trim();
  if (!raw) return null;
  let path = raw;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) path = path.slice(hashIdx + 1);
  path = path.replace(/^\/+/, "");
  if (!path.startsWith("n/")) return null;
  const rest = path.slice("n/".length);
  const parts = rest.split("/").map((p) => p.trim()).filter((p) => p.length > 0);
  return parts[0] ?? null;
}

/** Public row shape (drops userId + settings — same conventions as Mongo path). */
function workspaceRow(d: WorkspaceRow): Omit<WorkspaceRow, "userId" | "settings"> {
  const { userId: _u, settings: _s, ...rest } = d;
  void _u;
  void _s;
  return rest;
}

function projectRow(d: ProjectRow): Omit<ProjectRow, "userId" | "settings"> {
  const { userId: _u, settings: _s, ...rest } = d;
  void _u;
  void _s;
  return rest;
}

type WpnNoteListItemOut = {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  depth: number;
  sibling_index: number;
  search_hints?: NoteSearchHints;
};

function listNotesFlatPreorder(rows: NoteRow[]): WpnNoteListItemOut[] {
  const active = rows.filter((r) => r.deleted !== true);
  const cm = new Map<string | null, NoteRow[]>();
  for (const r of active) {
    const k = r.parent_id;
    const arr = cm.get(k) ?? [];
    arr.push(r);
    cm.set(k, arr);
  }
  for (const arr of cm.values()) {
    arr.sort((a, b) => a.sibling_index - b.sibling_index);
  }
  const out: WpnNoteListItemOut[] = [];
  const visit = (parentId: string | null, depth: number): void => {
    const kids = cm.get(parentId) ?? [];
    for (const r of kids) {
      const row: WpnNoteListItemOut = {
        id: r.id,
        project_id: r.project_id,
        parent_id: r.parent_id,
        type: r.type,
        title: r.title,
        depth,
        sibling_index: r.sibling_index,
      };
      const hints = buildNoteSearchHints({
        type: r.type,
        metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      });
      if (hints) row.search_hints = hints;
      out.push(row);
      visit(r.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/**
 * Resolve the active-space scope for a read request. Honors `X-Archon-Space`
 * header then the JWT `activeSpaceId` claim. Falls back to default-space for
 * master admins or active-org members. Returns null when no readable space.
 */
async function resolveReadScope(
  request: FastifyRequest,
  auth: JwtPayload,
): Promise<{ spaceId: string; role: SpaceRole } | null> {
  const db = getDb();
  let spaceId = resolveActiveSpaceId(request, auth);
  let user: UserRow | null = null;
  if (isUuid(auth.sub)) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    user = rows[0] ?? null;
  }
  if (
    !spaceId &&
    user?.isMasterAdmin === true &&
    typeof user.defaultOrgId === "string" &&
    user.defaultOrgId.length > 0
  ) {
    const fallback = await ensureDefaultSpaceForOrg(user.defaultOrgId, auth.sub);
    spaceId = fallback.spaceId;
  }
  if (
    !spaceId &&
    typeof auth.activeOrgId === "string" &&
    auth.activeOrgId.length > 0
  ) {
    const orgRows = await db
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, auth.activeOrgId),
          eq(orgMemberships.userId, auth.sub),
        ),
      )
      .limit(1);
    if (orgRows.length > 0) {
      spaceId = (await getDefaultSpaceIdForOrg(auth.activeOrgId)) ?? null;
    }
  }
  if (!spaceId) return null;
  const directRole = await effectiveRoleInSpace(auth.sub, spaceId);
  if (directRole) return { spaceId, role: directRole };
  if (!isUuid(spaceId)) return null;
  const spaceRows = await db
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  const space = spaceRows[0];
  if (!space) return null;
  if (user?.isMasterAdmin === true) return { spaceId, role: "owner" };
  const orgMembershipRows = await db
    .select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, space.orgId),
        eq(orgMemberships.userId, auth.sub),
      ),
    )
    .limit(1);
  if (orgMembershipRows[0]?.role === "admin") {
    return { spaceId, role: "owner" };
  }
  return null;
}

/** Workspace ACL filter — same rules as assertCanReadWorkspace. */
async function visibleWorkspacesInScope(
  userId: string,
  spaceId: string,
  spaceRole: SpaceRole,
): Promise<WorkspaceRow[]> {
  const db = getDb();
  const candidates = await db
    .select()
    .from(wpnWorkspaces)
    .where(
      or(
        eq(wpnWorkspaces.spaceId, spaceId),
        and(eq(wpnWorkspaces.userId, userId), isNull(wpnWorkspaces.spaceId)),
      ),
    )
    .orderBy(asc(wpnWorkspaces.sort_index), asc(wpnWorkspaces.name));
  const sharedRows = await db
    .select({ workspaceId: workspaceShares.workspaceId })
    .from(workspaceShares)
    .where(eq(workspaceShares.userId, userId));
  const sharedIds = new Set(sharedRows.map((r) => r.workspaceId));
  return candidates.filter((ws) => {
    const creator = ws.creatorUserId ?? ws.userId;
    if (ws.userId === userId || creator === userId) return true;
    const visibility = ws.visibility ?? "public";
    if (visibility === "public") return true;
    if (spaceRole === "owner") return true;
    if (visibility === "shared" && sharedIds.has(ws.id)) return true;
    return false;
  });
}

async function visibleProjectsInWorkspace(
  userId: string,
  spaceId: string,
  spaceRole: SpaceRole,
  wsIds: string[],
): Promise<ProjectRow[]> {
  if (wsIds.length === 0) return [];
  const db = getDb();
  const candidates = await db
    .select()
    .from(wpnProjects)
    .where(
      and(
        inArray(wpnProjects.workspace_id, wsIds),
        or(
          eq(wpnProjects.spaceId, spaceId),
          and(eq(wpnProjects.userId, userId), isNull(wpnProjects.spaceId)),
        ),
      ),
    )
    .orderBy(asc(wpnProjects.sort_index), asc(wpnProjects.name));
  if (candidates.length === 0) return [];
  const candidateIds = candidates.map((p) => p.id);
  const sharedRows = await db
    .select({ projectId: projectShares.projectId })
    .from(projectShares)
    .where(
      and(
        eq(projectShares.userId, userId),
        inArray(projectShares.projectId, candidateIds),
      ),
    );
  const sharedIds = new Set(sharedRows.map((r) => r.projectId));
  return candidates.filter((p) => {
    const creator = p.creatorUserId ?? p.userId;
    if (p.userId === userId || creator === userId) return true;
    if (spaceRole === "owner") return true;
    const visibility = p.visibility ?? "public";
    if (visibility === "public") return true;
    if (visibility === "shared" && sharedIds.has(p.id)) return true;
    return false;
  });
}

export function registerWpnReadRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  app.get("/wpn/workspaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const scope = await resolveReadScope(request, auth);
    if (!scope) return reply.send({ workspaces: [] });
    const docs = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    return reply.send({ workspaces: docs.map((d) => workspaceRow(d)) });
  });

  /** Single round-trip explorer tree. */
  app.get("/wpn/full-tree", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const scope = await resolveReadScope(request, auth);
    if (!scope) {
      return reply.send({
        workspaces: [],
        projects: [],
        notesByProjectId: {},
        explorerStateByProjectId: {},
      });
    }
    const userId = auth.sub;
    const wsDocs = await visibleWorkspacesInScope(userId, scope.spaceId, scope.role);
    const wsIds = wsDocs.map((w) => w.id);
    const projDocs = await visibleProjectsInWorkspace(
      userId,
      scope.spaceId,
      scope.role,
      wsIds,
    );
    const projectIds = projDocs.map((p) => p.id);
    const [noteDocs, exDocs] = await Promise.all([
      projectIds.length
        ? db()
            .select()
            .from(wpnNotes)
            .where(
              and(
                inArray(wpnNotes.project_id, projectIds),
                sql`${wpnNotes.deleted} IS NOT TRUE`,
              ),
            )
        : Promise.resolve([] as NoteRow[]),
      projectIds.length
        ? db()
            .select()
            .from(wpnExplorerState)
            .where(
              and(
                eq(wpnExplorerState.userId, userId),
                inArray(wpnExplorerState.project_id, projectIds),
              ),
            )
        : Promise.resolve([] as (typeof wpnExplorerState.$inferSelect)[]),
    ]);
    const noteGroups = new Map<string, NoteRow[]>();
    for (const n of noteDocs) {
      const arr = noteGroups.get(n.project_id) ?? [];
      arr.push(n);
      noteGroups.set(n.project_id, arr);
    }
    const notesByProjectId: Record<string, WpnNoteListItemOut[]> = {};
    for (const [pid, rows] of noteGroups) {
      notesByProjectId[pid] = listNotesFlatPreorder(rows);
    }
    const explorerStateByProjectId: Record<string, { expanded_ids: string[] }> = {};
    for (const ex of exDocs) {
      explorerStateByProjectId[ex.project_id] = {
        expanded_ids: Array.isArray(ex.expanded_ids) ? ex.expanded_ids : [],
      };
    }
    return reply.send({
      workspaces: wsDocs.map((d) => workspaceRow(d)),
      projects: projDocs.map((d) => projectRow(d)),
      notesByProjectId,
      explorerStateByProjectId,
    });
  });

  app.get("/wpn/workspaces-and-projects", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const scope = await resolveReadScope(request, auth);
    if (!scope) return reply.send({ workspaces: [], projects: [] });
    const wsDocs = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    const wsIds = wsDocs.map((w) => w.id);
    const projDocs = await visibleProjectsInWorkspace(
      auth.sub,
      scope.spaceId,
      scope.role,
      wsIds,
    );
    return reply.send({
      workspaces: wsDocs.map((d) => workspaceRow(d)),
      projects: projDocs.map((d) => projectRow(d)),
    });
  });

  app.get("/wpn/workspaces/:workspaceId/projects", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { workspaceId } = request.params as { workspaceId: string };
    const ws = await assertCanReadWorkspace(reply, auth, workspaceId);
    if (!ws) return;
    if (!ws.spaceId) {
      const docs = await db()
        .select()
        .from(wpnProjects)
        .where(
          and(
            eq(wpnProjects.userId, ws.userId),
            eq(wpnProjects.workspace_id, workspaceId),
          ),
        )
        .orderBy(asc(wpnProjects.sort_index), asc(wpnProjects.name));
      return reply.send({ projects: docs.map((d) => projectRow(d)) });
    }
    const role = (await effectiveRoleInSpace(auth.sub, ws.spaceId)) ?? "owner";
    const docs = await visibleProjectsInWorkspace(
      auth.sub,
      ws.spaceId,
      role,
      [workspaceId],
    );
    return reply.send({ projects: docs.map((d) => projectRow(d)) });
  });

  app.get("/wpn/projects/:projectId/notes", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { projectId } = request.params as { projectId: string };
    const readResult = await assertCanReadProject(reply, auth, projectId);
    if (!readResult) return;
    const { workspace: ws } = readResult;
    const rows = await db()
      .select()
      .from(wpnNotes)
      .where(
        and(eq(wpnNotes.userId, ws.userId), eq(wpnNotes.project_id, projectId)),
      );
    return reply.send({ notes: listNotesFlatPreorder(rows) });
  });

  app.get("/wpn/all-notes-list", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const scope = await resolveReadScope(request, auth);
    if (!scope) return reply.send({ notes: [] });
    const wsDocs = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    const wsIds = wsDocs.map((w) => w.id);
    if (wsIds.length === 0) return reply.send({ notes: [] });
    const projects = await visibleProjectsInWorkspace(
      auth.sub,
      scope.spaceId,
      scope.role,
      wsIds,
    );
    const out: WpnNoteListItemOut[] = [];
    for (const p of projects) {
      const rows = await db()
        .select()
        .from(wpnNotes)
        .where(eq(wpnNotes.project_id, p.id));
      out.push(...listNotesFlatPreorder(rows));
    }
    return reply.send({ notes: out });
  });

  app.get("/wpn/notes-with-context", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const scope = await resolveReadScope(request, auth);
    if (!scope) return reply.send({ notes: [] });
    const wsDocs = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    const wsIds = wsDocs.map((w) => w.id);
    if (wsIds.length === 0) return reply.send({ notes: [] });
    const projects = await visibleProjectsInWorkspace(
      auth.sub,
      scope.spaceId,
      scope.role,
      wsIds,
    );
    const projectIds = projects.map((p) => p.id);
    const noteRows = projectIds.length
      ? await db()
          .select()
          .from(wpnNotes)
          .where(
            and(
              inArray(wpnNotes.project_id, projectIds),
              sql`${wpnNotes.deleted} IS NOT TRUE`,
            ),
          )
      : [];
    const projMap = new Map(projects.map((p) => [p.id, p]));
    const wsMap = new Map(wsDocs.map((w) => [w.id, w]));
    const out: {
      id: string;
      title: string;
      type: string;
      project_id: string;
      project_name: string;
      workspace_id: string;
      workspace_name: string;
    }[] = [];
    for (const n of noteRows) {
      const p = projMap.get(n.project_id);
      if (!p) continue;
      const w = wsMap.get(p.workspace_id);
      if (!w) continue;
      out.push({
        id: n.id,
        type: n.type,
        title: n.title,
        project_id: n.project_id,
        project_name: p.name,
        workspace_id: p.workspace_id,
        workspace_name: w.name,
      });
    }
    return reply.send({ notes: out });
  });

  app.get("/wpn/backlinks/:noteId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { noteId } = request.params as { noteId: string };
    const scope = await resolveReadScope(request, auth);
    if (!scope) return reply.send({ sources: [] });
    const wsDocs = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    const wsIds = wsDocs.map((w) => w.id);
    if (wsIds.length === 0) return reply.send({ sources: [] });
    const projects = await visibleProjectsInWorkspace(
      auth.sub,
      scope.spaceId,
      scope.role,
      wsIds,
    );
    const projectIds = projects.map((p) => p.id);
    if (projectIds.length === 0) return reply.send({ sources: [] });
    const candidates = await db()
      .select()
      .from(wpnNotes)
      .where(
        and(
          inArray(wpnNotes.project_id, projectIds),
          sql`${wpnNotes.deleted} IS NOT TRUE`,
        ),
      );
    const targetNote = candidates.find((n) => n.id === noteId);
    const wsById = new Map(wsDocs.map((w) => [w.id, w]));
    const projById = new Map(projects.map((p) => [p.id, p]));
    const vfsTarget = (() => {
      if (!targetNote) return null;
      const proj = projById.get(targetNote.project_id);
      if (!proj) return null;
      const ws = wsById.get(proj.workspace_id);
      if (!ws) return null;
      return buildVfsBacklinkTarget({
        projectId: targetNote.project_id,
        workspaceName: ws.name,
        projectName: proj.name,
        title: targetNote.title,
      });
    })();
    const sources: { id: string; title: string; project_id: string }[] = [];
    for (const n of candidates) {
      if (n.id === noteId) continue;
      const content = n.content ?? "";
      const directRefs = collectReferencedNoteIdsFromMarkdown(content);
      const hitDirect = directRefs.has(noteId);
      const hitVfs =
        !hitDirect &&
        vfsTarget !== null &&
        contentReferencesTargetViaVfs(content, { projectId: n.project_id }, vfsTarget);
      if (!hitDirect && !hitVfs) continue;
      sources.push({ id: n.id, title: n.title, project_id: n.project_id });
    }
    return reply.send({ sources });
  });

  app.get(
    "/wpn/projects/:projectId/explorer-state",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId } = request.params as { projectId: string };
      const readResult = await assertCanReadProject(reply, auth, projectId);
      if (!readResult) return;
      const userId = auth.sub;
      const rows = await db()
        .select({ expanded_ids: wpnExplorerState.expanded_ids })
        .from(wpnExplorerState)
        .where(
          and(
            eq(wpnExplorerState.userId, userId),
            eq(wpnExplorerState.project_id, projectId),
          ),
        )
        .limit(1);
      const expanded_ids = Array.isArray(rows[0]?.expanded_ids)
        ? rows[0]!.expanded_ids
        : [];
      return reply.send({ expanded_ids });
    },
  );

  app.get("/wpn/notes/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanReadWorkspaceForNote(reply, auth, id);
    if (!ws) return;
    const noteRows = await db()
      .select()
      .from(wpnNotes)
      .where(and(eq(wpnNotes.id, id), sql`${wpnNotes.deleted} IS NOT TRUE`))
      .limit(1);
    const n = noteRows[0];
    if (!n) {
      return reply.status(404).send({ error: "Note not found" });
    }
    const ids = new Set<string>();
    if (n.created_by_user_id) ids.add(n.created_by_user_id);
    if (n.updated_by_user_id) ids.add(n.updated_by_user_id);
    const usersById = new Map<string, UserRow>();
    if (ids.size > 0) {
      const userIds = [...ids].filter(isUuid);
      if (userIds.length > 0) {
        const userDocs = await db()
          .select()
          .from(users)
          .where(inArray(users.id, userIds));
        for (const u of userDocs) {
          usersById.set(u.id, u);
        }
      }
    }
    const author = (uid: string | null | undefined) => {
      if (!uid) return null;
      const u = usersById.get(uid);
      if (!u) return null;
      return {
        userId: uid,
        email: u.email,
        displayName: u.displayName ?? null,
      };
    };
    const canWrite = await userCanWriteProject(auth, n.project_id);
    const note = {
      id: n.id,
      project_id: n.project_id,
      parent_id: n.parent_id,
      type: n.type,
      title: n.title,
      content: n.content,
      metadata:
        n.metadata && typeof n.metadata === "object" && !Array.isArray(n.metadata)
          ? n.metadata
          : undefined,
      sibling_index: n.sibling_index,
      created_at_ms: n.created_at_ms,
      updated_at_ms: n.updated_at_ms,
      created_by: author(n.created_by_user_id),
      updated_by: author(n.updated_by_user_id),
      canWrite,
    };
    return reply.send({ note });
  });

  app.get("/wpn/notes/:id/scope", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanReadWorkspaceForNote(reply, auth, id);
    if (!ws) return;
    const noteRows = await db()
      .select({ project_id: wpnNotes.project_id })
      .from(wpnNotes)
      .where(and(eq(wpnNotes.id, id), sql`${wpnNotes.deleted} IS NOT TRUE`))
      .limit(1);
    const note = noteRows[0];
    if (!note) {
      return reply.status(404).send({ error: "Note not found" });
    }
    return reply.send({
      noteId: id,
      projectId: note.project_id,
      workspaceId: ws.id,
      spaceId: ws.spaceId ?? null,
      orgId: ws.orgId ?? null,
    });
  });

  void sql;
}
