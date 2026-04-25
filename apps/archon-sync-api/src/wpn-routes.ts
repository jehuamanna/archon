import type { FastifyInstance, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { requireAuth, type JwtPayload } from "./auth.js";
import type { WpnNoteDoc, WpnProjectDoc, WpnWorkspaceDoc } from "./db.js";
import {
  ensureDefaultSpaceForOrg,
  getActiveDb,
  getDefaultSpaceIdForOrg,
  getOrgMembershipsCollection,
  getProjectSharesCollection,
  getSpacesCollection,
  getUsersCollection,
  getWorkspaceSharesCollection,
  getWpnExplorerStateCollection,
  getWpnNotesCollection,
  getWpnProjectsCollection,
  getWpnWorkspacesCollection,
  type UserDoc,
} from "./db.js";
import {
  assertCanReadProject,
  assertCanReadWorkspace,
  assertCanReadWorkspaceForNote,
  effectiveRoleInSpace,
  userCanWriteProject,
} from "./permission-resolver.js";
import { resolveActiveSpaceId } from "./space-auth.js";
import type { SpaceRole } from "./org-schemas.js";
import { buildNoteSearchHints, type NoteSearchHints } from "./note-search-hints.js";
import {
  buildVfsBacklinkTarget,
  contentReferencesTargetViaVfs,
} from "./note-backlinks-vfs.js";

/** Minimal markdown link → note id extraction (mirrors repo `collectReferencedNoteIdsFromMarkdown` for P1 backlinks). */
function collectReferencedNoteIdsFromMarkdown(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const href = (m[2] ?? "").trim();
    const id = parseNoteIdFromInternalMarkdownHref(href);
    if (id) {
      out.add(id);
    }
  }
  return out;
}

function parseNoteIdFromInternalMarkdownHref(href: string): string | null {
  const raw = href.trim();
  if (!raw) {
    return null;
  }
  let path = raw;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) {
    path = path.slice(hashIdx + 1);
  }
  path = path.replace(/^\/+/, "");
  if (!path.startsWith("n/")) {
    return null;
  }
  const rest = path.slice("n/".length);
  const parts = rest
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const noteId = parts[0];
  return noteId ?? null;
}

/** Public row shape (no `settings` — use `/wpn/.../settings` like headless API). */
function workspaceRow(doc: WpnWorkspaceDoc): Omit<WpnWorkspaceDoc, "userId" | "settings"> {
  const { userId: _u, settings: _s, ...rest } = doc;
  return rest;
}

function projectRow(doc: WpnProjectDoc): Omit<WpnProjectDoc, "userId" | "settings"> {
  const { userId: _u, settings: _s, ...rest } = doc;
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
  /**
   * PLAN-06 slice 2: compact metadata slice for client-side search.
   * Present only on image notes that set altText or caption. Absent
   * (not empty object) when no hints apply, to keep list payloads tight.
   */
  search_hints?: NoteSearchHints;
};

function listNotesFlatPreorder(rows: WpnNoteDoc[]): WpnNoteListItemOut[] {
  const active = rows.filter((r) => r.deleted !== true);
  const cm = new Map<string | null, WpnNoteDoc[]>();
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
      const hints = buildNoteSearchHints({ type: r.type, metadata: r.metadata });
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
 * header then the JWT `activeSpaceId` claim. Grants access when the caller is:
 *   - a direct or team-granted member of the space, OR
 *   - an `admin` of the space's parent org (org-admin override).
 * Returns `null` otherwise — callers should respond with an empty tree so
 * stale data from another space can't leak.
 */
async function resolveReadScope(
  request: FastifyRequest,
  auth: JwtPayload,
): Promise<{ spaceId: string; role: SpaceRole } | null> {
  let spaceId = resolveActiveSpaceId(request, auth);
  let user: UserDoc | null = null;
  try {
    user = (await getUsersCollection().findOne({
      _id: new ObjectId(auth.sub),
    })) as UserDoc | null;
  } catch {
    user = null;
  }
  // Master admin with no active space in the request falls back to the
  // default space of their default org so their own tree is always reachable.
  if (
    !spaceId &&
    user?.isMasterAdmin === true &&
    typeof user.defaultOrgId === "string" &&
    user.defaultOrgId.length > 0
  ) {
    const { spaceId: fallback } = await ensureDefaultSpaceForOrg(
      getActiveDb(),
      user.defaultOrgId,
      auth.sub,
    );
    spaceId = fallback;
  }
  // Phase 8 safety net: if the caller has an `activeOrgId` claim but no
  // `activeSpaceId` (e.g. a token minted before this fix shipped, or a future
  // flow that forgets to set the claim), fall back to the org's default space
  // as long as the caller is actually a member of that org. Without this the
  // /wpn/* endpoints silently return an empty tree and the user is stuck.
  // Read-only lookup — the access-check below (`effectiveRoleInSpace` / org-
  // admin override) decides whether the caller can actually read that space.
  if (!spaceId && typeof auth.activeOrgId === "string" && auth.activeOrgId.length > 0) {
    const orgMembership = await getOrgMembershipsCollection().findOne({
      orgId: auth.activeOrgId,
      userId: auth.sub,
    });
    if (orgMembership) {
      spaceId = await getDefaultSpaceIdForOrg(auth.activeOrgId);
    }
  }
  if (!spaceId) {
    return null;
  }
  const directRole = await effectiveRoleInSpace(auth.sub, spaceId);
  if (directRole) {
    return { spaceId, role: directRole };
  }
  if (!/^[a-f0-9]{24}$/i.test(spaceId)) {
    return null;
  }
  const space = await getSpacesCollection().findOne({ _id: new ObjectId(spaceId) });
  if (!space) {
    return null;
  }
  // Master admins see every existing space as owner — matches the intent of
  // the Master Console (platform-wide read) without requiring them to be
  // enrolled as a direct member of every space.
  if (user?.isMasterAdmin === true) {
    return { spaceId, role: "owner" };
  }
  const orgMembership = await getOrgMembershipsCollection().findOne({
    orgId: space.orgId,
    userId: auth.sub,
  });
  if (orgMembership?.role === "admin") {
    return { spaceId, role: "owner" };
  }
  return null;
}

/**
 * Workspaces the caller can see in `spaceId`, mirroring the single-id read
 * rules in `assertCanReadWorkspace`:
 *   - owner (userId or creator matches caller): always visible
 *   - public: any space member
 *   - private: creator + space-owners
 *   - shared: creator + space-owners + explicit `workspace_shares` allow-list
 * Sort stays in stored `sort_index` order so co-space-members see a stable
 * shared ordering.
 */
async function visibleWorkspacesInScope(
  userId: string,
  spaceId: string,
  spaceRole: SpaceRole,
): Promise<WpnWorkspaceDoc[]> {
  // The `$or` legacy clause catches workspaces that pre-date the space
  // rollout (no `spaceId` set). They remain visible to their original
  // owner, matching `assertCanReadWorkspace`'s legacy handling.
  const candidates = await getWpnWorkspacesCollection()
    .find({
      $or: [{ spaceId }, { userId, spaceId: { $exists: false } }],
    })
    .sort({ sort_index: 1, name: 1 })
    .toArray();
  const sharedIds = new Set(
    (await getWorkspaceSharesCollection().find({ userId }).toArray()).map(
      (r) => r.workspaceId,
    ),
  );
  return candidates.filter((ws) => {
    const creator = ws.creatorUserId ?? ws.userId;
    if (ws.userId === userId || creator === userId) {
      return true;
    }
    const visibility = ws.visibility ?? "public";
    if (visibility === "public") {
      return true;
    }
    if (spaceRole === "owner") {
      return true;
    }
    if (visibility === "shared" && sharedIds.has(ws.id)) {
      return true;
    }
    return false;
  });
}

/**
 * Phase 8 — filter project docs by the new per-project ACL. Mirrors
 * {@link assertCanReadProject}:
 *   - space-owner (includes master-admin / org-admin override via resolveReadScope) → all
 *   - creator → always visible
 *   - public → visible
 *   - private → hidden (unless creator or override)
 *   - shared → visible iff row in `project_shares`
 */
async function visibleProjectsInWorkspace(
  userId: string,
  spaceId: string,
  spaceRole: SpaceRole,
  wsIds: string[],
): Promise<WpnProjectDoc[]> {
  if (wsIds.length === 0) {
    return [];
  }
  const projCol = getWpnProjectsCollection();
  const candidates = await projCol
    .find({
      workspace_id: { $in: wsIds },
      $or: [{ spaceId }, { userId, spaceId: { $exists: false } }],
    })
    .sort({ sort_index: 1, name: 1 })
    .toArray();
  if (candidates.length === 0) {
    return [];
  }
  const candidateIds = candidates.map((p) => p.id);
  const sharedIds = new Set(
    (
      await getProjectSharesCollection()
        .find({ userId, projectId: { $in: candidateIds } })
        .toArray()
    ).map((r) => r.projectId),
  );
  return candidates.filter((p) => {
    const creator = p.creatorUserId ?? p.userId;
    if (p.userId === userId || creator === userId) {
      return true;
    }
    if (spaceRole === "owner") {
      return true;
    }
    const visibility = p.visibility ?? "public";
    if (visibility === "public") {
      return true;
    }
    if (visibility === "shared" && sharedIds.has(p.id)) {
      return true;
    }
    return false;
  });
}

export function registerWpnReadRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  app.get("/wpn/workspaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const scope = await resolveReadScope(request, auth);
    if (!scope) {
      return reply.send({ workspaces: [] });
    }
    const docs = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    const workspaces = docs.map((d) => workspaceRow(d));
    return reply.send({ workspaces });
  });

  /** Single round-trip: returns full explorer tree — workspaces, projects, all note titles, all explorer states. */
  app.get("/wpn/full-tree", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
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
    const noteCol = getWpnNotesCollection();
    const exCol = getWpnExplorerStateCollection();
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
        ? noteCol
            .find(
              { project_id: { $in: projectIds }, deleted: { $ne: true } },
              { projection: { content: 0, metadata: 0 } },
            )
            .toArray()
        : Promise.resolve([] as WpnNoteDoc[]),
      projectIds.length
        ? exCol.find({ userId, project_id: { $in: projectIds } }).toArray()
        : Promise.resolve([]),
    ]);
    const noteGroups = new Map<string, WpnNoteDoc[]>();
    for (const n of noteDocs) {
      const arr = noteGroups.get(n.project_id) ?? [];
      arr.push(n as WpnNoteDoc);
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

  /** Single round-trip: returns all workspaces and all their projects with 2 parallel DB queries. */
  app.get("/wpn/workspaces-and-projects", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const scope = await resolveReadScope(request, auth);
    if (!scope) {
      return reply.send({ workspaces: [], projects: [] });
    }
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
    if (!auth) {
      return;
    }
    const { workspaceId } = request.params as { workspaceId: string };
    const ws = await assertCanReadWorkspace(reply, auth, workspaceId);
    if (!ws) {
      return;
    }
    // Phase 8: apply per-project ACL. Use the workspace's space + caller's effective role.
    if (!ws.spaceId) {
      const docs = await getWpnProjectsCollection()
        .find({ userId: ws.userId, workspace_id: workspaceId })
        .sort({ sort_index: 1, name: 1 })
        .toArray();
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
    if (!auth) {
      return;
    }
    const { projectId } = request.params as { projectId: string };
    const readResult = await assertCanReadProject(reply, auth, projectId);
    if (!readResult) {
      return;
    }
    const { workspace: ws } = readResult;
    const noteCol = getWpnNotesCollection();
    const rows = await noteCol.find({ userId: ws.userId, project_id: projectId }).toArray();
    const notes = listNotesFlatPreorder(rows);
    return reply.send({ notes });
  });

  /** Single round-trip flat list for all projects (same row shape as `GET /wpn/projects/:id/notes`). */
  app.get("/wpn/all-notes-list", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const scope = await resolveReadScope(request, auth);
    if (!scope) {
      return reply.send({ notes: [] });
    }
    const noteCol = getWpnNotesCollection();
    const workspaces = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    const wsIds = workspaces.map((w) => w.id);
    if (wsIds.length === 0) {
      return reply.send({ notes: [] });
    }
    const projects = await visibleProjectsInWorkspace(
      auth.sub,
      scope.spaceId,
      scope.role,
      wsIds,
    );
    const out: WpnNoteListItemOut[] = [];
    for (const p of projects) {
      const rows = await noteCol.find({ project_id: p.id }).toArray();
      out.push(...listNotesFlatPreorder(rows));
    }
    return reply.send({ notes: out });
  });

  app.get("/wpn/notes-with-context", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const scope = await resolveReadScope(request, auth);
    if (!scope) {
      return reply.send({ notes: [] });
    }
    const noteCol = getWpnNotesCollection();
    const workspaces = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    const wsIds = workspaces.map((w) => w.id);
    if (wsIds.length === 0) {
      return reply.send({ notes: [] });
    }
    const projects = await visibleProjectsInWorkspace(
      auth.sub,
      scope.spaceId,
      scope.role,
      wsIds,
    );
    const projectIds = projects.map((p) => p.id);
    const notes = projectIds.length
      ? await noteCol
          .find({ project_id: { $in: projectIds }, deleted: { $ne: true } })
          .toArray()
      : [];
    const projMap = new Map(projects.map((p) => [p.id, p]));
    const wsMap = new Map(workspaces.map((w) => [w.id, w]));
    const out: {
      id: string;
      title: string;
      type: string;
      project_id: string;
      project_name: string;
      workspace_id: string;
      workspace_name: string;
    }[] = [];
    for (const n of notes) {
      const p = projMap.get(n.project_id);
      if (!p) {
        continue;
      }
      const w = wsMap.get(p.workspace_id);
      if (!w) {
        continue;
      }
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
    if (!auth) {
      return;
    }
    const { noteId } = request.params as { noteId: string };
    const scope = await resolveReadScope(request, auth);
    if (!scope) {
      return reply.send({ sources: [] });
    }
    const noteCol = getWpnNotesCollection();
    const workspaces = await visibleWorkspacesInScope(auth.sub, scope.spaceId, scope.role);
    const wsIds = workspaces.map((w) => w.id);
    if (wsIds.length === 0) {
      return reply.send({ sources: [] });
    }
    const projects = await visibleProjectsInWorkspace(
      auth.sub,
      scope.spaceId,
      scope.role,
      wsIds,
    );
    const projectIds = new Set(projects.map((p) => p.id));
    const candidates = await noteCol
      .find({
        project_id: { $in: [...projectIds] },
        deleted: { $ne: true },
      })
      .toArray();
    const targetNote = candidates.find((n) => n.id === noteId);
    const wsById = new Map(workspaces.map((w) => [w.id, w]));
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
      if (n.id === noteId) {
        continue;
      }
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

  app.get("/wpn/projects/:projectId/explorer-state", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { projectId } = request.params as { projectId: string };
    const readResult = await assertCanReadProject(reply, auth, projectId);
    if (!readResult) {
      return;
    }
    const userId = auth.sub;
    const exCol = getWpnExplorerStateCollection();
    const doc = await exCol.findOne({ userId, project_id: projectId });
    const expanded_ids = Array.isArray(doc?.expanded_ids) ? doc!.expanded_ids : [];
    return reply.send({ expanded_ids });
  });

  app.get("/wpn/notes/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { id } = request.params as { id: string };
    const ws = await assertCanReadWorkspaceForNote(reply, auth, id);
    if (!ws) {
      return;
    }
    const noteCol = getWpnNotesCollection();
    const n = await noteCol.findOne({ id, deleted: { $ne: true } });
    if (!n) {
      return reply.status(404).send({ error: "Note not found" });
    }
    // Phase 6 — resolve display info for created_by / updated_by.
    const ids = new Set<string>();
    if (n.created_by_user_id) ids.add(n.created_by_user_id);
    if (n.updated_by_user_id) ids.add(n.updated_by_user_id);
    let usersById = new Map<string, UserDoc>();
    if (ids.size > 0) {
      const users = (await getUsersCollection()
        .find({
          _id: {
            $in: [...ids].filter((s) => /^[a-f0-9]{24}$/i.test(s)).map((s) => new ObjectId(s)),
          },
        })
        .toArray()) as UserDoc[];
      usersById = new Map(users.map((u) => [u._id.toHexString(), u]));
    }
    const author = (uid: string | undefined) => {
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

  /**
   * Resolve a note's full scope chain — { noteId, projectId, workspaceId, spaceId, orgId }.
   * Used by MCP clients to auto-switch active org/space when a tool is invoked
   * with a noteId that lives outside the currently active scope. Returns 404
   * (via assertCanReadWorkspaceForNote) when the note is missing or unreadable.
   */
  app.get("/wpn/notes/:id/scope", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { id } = request.params as { id: string };
    const ws = await assertCanReadWorkspaceForNote(reply, auth, id);
    if (!ws) {
      return;
    }
    const note = await getWpnNotesCollection().findOne({ id, deleted: { $ne: true } });
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
}
