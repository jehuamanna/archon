/**
 * WPN read routes (post-migration).
 *
 * Renamed conceptually from "workspace/project/note" to "project/note" — the
 * URL prefix `/wpn/` is kept so the frontend doesn't have to change in
 * lock-step. Workspace endpoints are gone; project listing replaces them.
 *
 * Endpoints:
 *   GET  /wpn/projects                          list readable projects
 *   GET  /wpn/full-tree                         projects + notes + explorer state
 *   GET  /wpn/projects/:projectId/notes         tree of notes in a project
 *   GET  /wpn/all-notes-list                    flat preorder of all readable notes
 *   GET  /wpn/notes-with-context                notes + project context (id/name)
 *   GET  /wpn/backlinks/:noteId                 source notes referencing :noteId
 *   GET  /wpn/projects/:projectId/explorer-state per-user expanded ids
 *   GET  /wpn/notes/:id                         note detail
 *   GET  /wpn/notes/:id/scope                   scope (projectId, orgId)
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth, type JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import {
  explorerState,
  notes,
  orgMemberships,
  projects,
  users,
} from "./db/schema.js";
import {
  assertCanReadProject,
  assertCanReadProjectForNote,
  getEffectiveProjectRoles,
  userCanWriteProject,
  type ProjectRow,
} from "./permission-resolver.js";
import {
  buildNoteSearchHints,
  type NoteSearchHints,
} from "./note-search-hints.js";
import {
  buildVfsBacklinkTarget,
  contentReferencesTargetViaVfs,
} from "./note-backlinks-vfs.js";
import { isUuid } from "./db/legacy-id-map.js";

type NoteRow = typeof notes.$inferSelect;
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

/** Public row shape (drops settings; keeps snake_case_id fields the frontend
 * already consumes). */
function projectOut(p: ProjectRow): {
  id: string;
  org_id: string;
  creator_user_id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
} {
  return {
    id: p.id,
    org_id: p.orgId,
    creator_user_id: p.creatorUserId,
    name: p.name,
    sort_index: p.sortIndex,
    color_token: p.colorToken,
    created_at_ms: p.createdAtMs,
    updated_at_ms: p.updatedAtMs,
  };
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
    const k = r.parentId;
    const arr = cm.get(k) ?? [];
    arr.push(r);
    cm.set(k, arr);
  }
  for (const arr of cm.values()) {
    arr.sort((a, b) => a.siblingIndex - b.siblingIndex);
  }
  const out: WpnNoteListItemOut[] = [];
  const visit = (parentId: string | null, depth: number): void => {
    const kids = cm.get(parentId) ?? [];
    for (const r of kids) {
      const row: WpnNoteListItemOut = {
        id: r.id,
        project_id: r.projectId,
        parent_id: r.parentId,
        type: r.type,
        title: r.title,
        depth,
        sibling_index: r.siblingIndex,
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
 * Build the set of project ids the caller can read, optionally restricted to
 * an active org. Master admins and org admins see every project in their
 * org(s); team members see only projects granted via team_projects.
 *
 * Returns null when the caller has no readable scope (no orgs, no team
 * grants, no admin override).
 */
async function listReadableProjects(auth: JwtPayload): Promise<ProjectRow[]> {
  const db = getDb();
  let isMasterAdmin = false;
  if (isUuid(auth.sub)) {
    const userRows = await db
      .select({ flag: users.isMasterAdmin })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    isMasterAdmin = userRows[0]?.flag === true;
  }
  // Org admins / master admins: every project in the active org (if set) or
  // every project across orgs they admin.
  if (isMasterAdmin) {
    if (typeof auth.activeOrgId === "string" && auth.activeOrgId.length > 0) {
      return db
        .select()
        .from(projects)
        .where(eq(projects.orgId, auth.activeOrgId))
        .orderBy(asc(projects.sortIndex), asc(projects.name));
    }
    return db
      .select()
      .from(projects)
      .orderBy(asc(projects.sortIndex), asc(projects.name));
  }
  const adminOrgRows = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(
      and(eq(orgMemberships.userId, auth.sub), eq(orgMemberships.role, "admin")),
    );
  const adminOrgIds = new Set(adminOrgRows.map((r) => r.orgId));
  const projectRoles = await getEffectiveProjectRoles(auth.sub);
  const grantedProjectIds = new Set(projectRoles.keys());
  // Active-org filter narrows everything when set; the explorer only renders
  // one org at a time anyway.
  const activeOrgId =
    typeof auth.activeOrgId === "string" && auth.activeOrgId.length > 0
      ? auth.activeOrgId
      : null;
  // Pull every project the user could possibly see in one query, then filter
  // in JS on whether they have a grant or org-admin status.
  const orgScopeIds = activeOrgId ? [activeOrgId] : [...adminOrgIds];
  const candidates: ProjectRow[] = [];
  if (grantedProjectIds.size > 0) {
    const rows = await db
      .select()
      .from(projects)
      .where(inArray(projects.id, [...grantedProjectIds]));
    for (const p of rows) {
      if (!activeOrgId || p.orgId === activeOrgId) candidates.push(p);
    }
  }
  if (orgScopeIds.length > 0) {
    const rows = await db
      .select()
      .from(projects)
      .where(inArray(projects.orgId, orgScopeIds));
    for (const p of rows) {
      if (adminOrgIds.has(p.orgId) && !candidates.some((c) => c.id === p.id)) {
        candidates.push(p);
      }
    }
  }
  candidates.sort((a, b) => {
    if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
    return a.name.localeCompare(b.name);
  });
  return candidates;
}

export function registerWpnReadRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  /** List projects the caller can read (active-org-scoped). */
  app.get("/wpn/projects", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const docs = await listReadableProjects(auth);
    return reply.send({ projects: docs.map(projectOut) });
  });

  /** Single round-trip explorer tree: projects + notes + explorer state. */
  app.get("/wpn/full-tree", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const userId = auth.sub;
    const projDocs = await listReadableProjects(auth);
    const projectIds = projDocs.map((p) => p.id);
    const [noteDocs, exDocs] = await Promise.all([
      projectIds.length
        ? db()
            .select()
            .from(notes)
            .where(
              and(
                inArray(notes.projectId, projectIds),
                sql`${notes.deleted} IS NOT TRUE`,
              ),
            )
        : Promise.resolve([] as NoteRow[]),
      projectIds.length
        ? db()
            .select()
            .from(explorerState)
            .where(
              and(
                eq(explorerState.userId, userId),
                inArray(explorerState.projectId, projectIds),
              ),
            )
        : Promise.resolve([] as (typeof explorerState.$inferSelect)[]),
    ]);
    const noteGroups = new Map<string, NoteRow[]>();
    for (const n of noteDocs) {
      const arr = noteGroups.get(n.projectId) ?? [];
      arr.push(n);
      noteGroups.set(n.projectId, arr);
    }
    const notesByProjectId: Record<string, WpnNoteListItemOut[]> = {};
    for (const [pid, rows] of noteGroups) {
      notesByProjectId[pid] = listNotesFlatPreorder(rows);
    }
    const explorerStateByProjectId: Record<string, { expanded_ids: string[] }> = {};
    for (const ex of exDocs) {
      explorerStateByProjectId[ex.projectId] = {
        expanded_ids: Array.isArray(ex.expandedIds) ? ex.expandedIds : [],
      };
    }
    return reply.send({
      projects: projDocs.map(projectOut),
      notesByProjectId,
      explorerStateByProjectId,
    });
  });

  app.get("/wpn/projects/:projectId/notes", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { projectId } = request.params as { projectId: string };
    const project = await assertCanReadProject(reply, auth, projectId);
    if (!project) return;
    const rows = await db()
      .select()
      .from(notes)
      .where(eq(notes.projectId, projectId));
    return reply.send({ notes: listNotesFlatPreorder(rows) });
  });

  app.get("/wpn/all-notes-list", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const projDocs = await listReadableProjects(auth);
    const projectIds = projDocs.map((p) => p.id);
    if (projectIds.length === 0) return reply.send({ notes: [] });
    const rows = await db()
      .select()
      .from(notes)
      .where(
        and(
          inArray(notes.projectId, projectIds),
          sql`${notes.deleted} IS NOT TRUE`,
        ),
      );
    return reply.send({ notes: listNotesFlatPreorder(rows) });
  });

  app.get("/wpn/notes-with-context", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const projDocs = await listReadableProjects(auth);
    const projectIds = projDocs.map((p) => p.id);
    if (projectIds.length === 0) return reply.send({ notes: [] });
    const noteRows = await db()
      .select()
      .from(notes)
      .where(
        and(
          inArray(notes.projectId, projectIds),
          sql`${notes.deleted} IS NOT TRUE`,
        ),
      );
    const projMap = new Map(projDocs.map((p) => [p.id, p]));
    const out: {
      id: string;
      title: string;
      type: string;
      project_id: string;
      project_name: string;
    }[] = [];
    for (const n of noteRows) {
      const p = projMap.get(n.projectId);
      if (!p) continue;
      out.push({
        id: n.id,
        type: n.type,
        title: n.title,
        project_id: n.projectId,
        project_name: p.name,
      });
    }
    return reply.send({ notes: out });
  });

  app.get("/wpn/backlinks/:noteId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { noteId } = request.params as { noteId: string };
    const projDocs = await listReadableProjects(auth);
    const projectIds = projDocs.map((p) => p.id);
    if (projectIds.length === 0) return reply.send({ sources: [] });
    const candidates = await db()
      .select()
      .from(notes)
      .where(
        and(
          inArray(notes.projectId, projectIds),
          sql`${notes.deleted} IS NOT TRUE`,
        ),
      );
    const targetNote = candidates.find((n) => n.id === noteId);
    const projById = new Map(projDocs.map((p) => [p.id, p]));
    const vfsTarget = (() => {
      if (!targetNote) return null;
      const proj = projById.get(targetNote.projectId);
      if (!proj) return null;
      // Post-migration VFS path: <ProjectName>/<NoteTitle…>. The 5-segment
      // org/dept/team/project/title scheme isn't necessary here because
      // backlink scanning is project-scoped — a note's reachable peers
      // already share the project root.
      return buildVfsBacklinkTarget({
        projectId: targetNote.projectId,
        workspaceName: proj.name,
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
        contentReferencesTargetViaVfs(content, { projectId: n.projectId }, vfsTarget);
      if (!hitDirect && !hitVfs) continue;
      sources.push({ id: n.id, title: n.title, project_id: n.projectId });
    }
    return reply.send({ sources });
  });

  app.get(
    "/wpn/projects/:projectId/explorer-state",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId } = request.params as { projectId: string };
      const project = await assertCanReadProject(reply, auth, projectId);
      if (!project) return;
      const userId = auth.sub;
      const rows = await db()
        .select({ expandedIds: explorerState.expandedIds })
        .from(explorerState)
        .where(
          and(
            eq(explorerState.userId, userId),
            eq(explorerState.projectId, projectId),
          ),
        )
        .limit(1);
      const expanded_ids = Array.isArray(rows[0]?.expandedIds)
        ? rows[0]!.expandedIds
        : [];
      return reply.send({ expanded_ids });
    },
  );

  app.get("/wpn/notes/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const project = await assertCanReadProjectForNote(reply, auth, id);
    if (!project) return;
    const noteRows = await db()
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), sql`${notes.deleted} IS NOT TRUE`))
      .limit(1);
    const n = noteRows[0];
    if (!n) {
      return reply.status(404).send({ error: "Note not found" });
    }
    const ids = new Set<string>();
    if (n.createdByUserId) ids.add(n.createdByUserId);
    if (n.updatedByUserId) ids.add(n.updatedByUserId);
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
    const canWrite = await userCanWriteProject(auth, n.projectId);
    const note = {
      id: n.id,
      project_id: n.projectId,
      parent_id: n.parentId,
      type: n.type,
      title: n.title,
      content: n.content,
      metadata:
        n.metadata && typeof n.metadata === "object" && !Array.isArray(n.metadata)
          ? n.metadata
          : undefined,
      sibling_index: n.siblingIndex,
      created_at_ms: n.createdAtMs,
      updated_at_ms: n.updatedAtMs,
      created_by: author(n.createdByUserId),
      updated_by: author(n.updatedByUserId),
      canWrite,
    };
    return reply.send({ note });
  });

  app.get("/wpn/notes/:id/scope", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const project = await assertCanReadProjectForNote(reply, auth, id);
    if (!project) return;
    const noteRows = await db()
      .select({ projectId: notes.projectId, orgId: notes.orgId })
      .from(notes)
      .where(and(eq(notes.id, id), sql`${notes.deleted} IS NOT TRUE`))
      .limit(1);
    const note = noteRows[0];
    if (!note) {
      return reply.status(404).send({ error: "Note not found" });
    }
    return reply.send({
      noteId: id,
      projectId: note.projectId,
      orgId: note.orgId,
    });
  });
}
