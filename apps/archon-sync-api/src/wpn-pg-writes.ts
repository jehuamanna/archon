/**
 * Postgres write helpers for projects + notes (post-migration).
 *
 * Multi-statement operations run inside a single `withTx` so partial
 * failures don't leave the tree in a corrupt state. All ids are uuid;
 * cycle prevention for tree moves runs as a recursive CTE inside the
 * same transaction (no app-side guards beyond the helpers in
 * `wpn-tree.ts`).
 *
 * On every note write (create/update/delete-subtree/duplicate-subtree)
 * `reconcileNoteEdges` runs: parse markdown content for `#/n/<id>`
 * references via the shared markdown-internal-note-href module and
 * delete-then-insert the edges for that source. VFS-path references
 * (`#/w/...`) are deferred to a future resolver — they don't break
 * correctness, only completeness.
 *
 * Realtime fanout: events go to a per-org channel via `notifyRealtime`
 * with the project's `org_id` as the key. The per-event ACL filter in
 * `realtime/filter.ts` does the project-level read check before delivery.
 */
import * as crypto from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, withTx } from "./pg.js";
import {
  explorerState,
  noteEdges,
  notes,
  projects,
  teamProjects,
} from "./db/schema.js";
import {
  type NoteMovePlacement,
  type WpnNoteRowLite,
  wpnComputeChildMapAfterMove,
} from "./wpn-tree.js";
import { notifyRealtime } from "./realtime/notify.js";

// ---------- public surface ----------

export const WPN_DUPLICATE_NOTE_TITLE_MESSAGE =
  "Note title already exists. Try a different title.";

export class WpnDuplicateSiblingTitleError extends Error {
  constructor() {
    super(WPN_DUPLICATE_NOTE_TITLE_MESSAGE);
    this.name = "WpnDuplicateSiblingTitleError";
  }
}

// ---------- helpers ----------

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  return crypto.randomUUID();
}

function normalizeNoteType(t: string): string {
  return String(t || "markdown").trim().toLowerCase() || "markdown";
}

type NoteRow = typeof notes.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

function toRowLite(rows: NoteRow[]): WpnNoteRowLite[] {
  return rows
    .filter((r) => r.deleted !== true)
    .map((r) => ({
      id: r.id,
      parent_id: r.parentId,
      sibling_index: r.siblingIndex,
    }));
}

function childrenMapFromRows(rows: NoteRow[]): Map<string | null, NoteRow[]> {
  const active = rows.filter((r) => r.deleted !== true);
  const m = new Map<string | null, NoteRow[]>();
  for (const r of active) {
    const k = r.parentId;
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.siblingIndex - b.siblingIndex);
  }
  return m;
}

function collectSubtreePreorder(rows: NoteRow[], rootId: string): string[] {
  const cm = childrenMapFromRows(rows);
  const out: string[] = [];
  const visit = (id: string): void => {
    out.push(id);
    for (const k of cm.get(id) ?? []) {
      visit(k.id);
    }
  };
  visit(rootId);
  return out;
}

/** Public projection for projects (drops settings; keeps API-shape names). */
function publicProject(p: ProjectRow): {
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

// ---------- note_edges reconciliation ----------

let _markdownLib: { collectReferencedNoteIdsFromMarkdown: (s: string) => Set<string> } | null = null;

async function loadMarkdownLib(): Promise<NonNullable<typeof _markdownLib>> {
  if (_markdownLib) return _markdownLib;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = await import("../../../src/shared/markdown-internal-note-href.js" as any);
  _markdownLib = {
    collectReferencedNoteIdsFromMarkdown: m.collectReferencedNoteIdsFromMarkdown,
  };
  return _markdownLib;
}

/**
 * Replace every `note_edges` row whose `src = srcNoteId` with the deduped set
 * of `(srcNoteId, dst, kind='link')` edges parsed from `content` markdown.
 * Runs inside the caller's transaction.
 */
async function reconcileNoteEdges(
  tx: ReturnType<typeof getDb>,
  srcNoteId: string,
  content: string,
): Promise<{ added: string[]; removed: string[] }> {
  const lib = await loadMarkdownLib();
  const ids = lib.collectReferencedNoteIdsFromMarkdown(content);
  const dstSet = new Set<string>();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of ids) {
    if (id === srcNoteId) continue;
    if (!UUID_RE.test(id)) continue;
    dstSet.add(id);
  }
  const existing = await tx
    .select({ dst: noteEdges.dst })
    .from(noteEdges)
    .where(eq(noteEdges.src, srcNoteId));
  const before = new Set(existing.map((r) => r.dst));
  await tx.delete(noteEdges).where(eq(noteEdges.src, srcNoteId));
  if (dstSet.size > 0) {
    await tx.insert(noteEdges).values(
      Array.from(dstSet).map((dst) => ({
        src: srcNoteId,
        dst,
        kind: "link",
        meta: null as unknown,
      })),
    );
  }
  const added: string[] = [];
  const removed: string[] = [];
  for (const dst of dstSet) if (!before.has(dst)) added.push(dst);
  for (const dst of before) if (!dstSet.has(dst)) removed.push(dst);
  return { added, removed };
}

/** Best-effort emission of edge.added/edge.removed events. */
async function emitEdgeDiff(
  channelKey: string | null,
  srcNoteId: string,
  byUserId: string,
  diff: { added: string[]; removed: string[] },
): Promise<void> {
  if (!channelKey) return;
  if (diff.added.length === 0 && diff.removed.length === 0) return;
  const stamp = new Date().toISOString();
  for (const dst of diff.added) {
    try {
      await notifyRealtime(channelKey, {
        type: "edge.added",
        src: srcNoteId,
        dst,
        kind: "link",
        byUserId,
        emittedAt: stamp,
      });
    } catch {
      /* swallow */
    }
  }
  for (const dst of diff.removed) {
    try {
      await notifyRealtime(channelKey, {
        type: "edge.removed",
        src: srcNoteId,
        dst,
        kind: "link",
        byUserId,
        emittedAt: stamp,
      });
    } catch {
      /* swallow */
    }
  }
}

// ---------- projects ----------

export async function pgWpnCreateProject(
  orgId: string,
  name: string,
  opts?: { creatorUserId: string; teamId?: string; teamRole?: "owner" | "contributor" | "viewer" },
): Promise<ReturnType<typeof publicProject>> {
  const creator = opts?.creatorUserId;
  if (!creator) throw new Error("creatorUserId required");
  return withTx(async (tx) => {
    const t = nowMs();
    const last = await tx
      .select({ s: projects.sortIndex })
      .from(projects)
      .where(eq(projects.orgId, orgId))
      .orderBy(desc(projects.sortIndex))
      .limit(1);
    const maxSort = last[0]?.s ?? -1;
    const id = newId();
    const row: ProjectRow = {
      id,
      orgId,
      creatorUserId: creator,
      name: name.trim() || "Project",
      sortIndex: maxSort + 1,
      colorToken: null,
      createdAtMs: t,
      updatedAtMs: t,
      settings: {} as unknown,
    };
    await tx.insert(projects).values(row);
    if (opts?.teamId) {
      await tx
        .insert(teamProjects)
        .values({
          teamId: opts.teamId,
          projectId: id,
          role: opts.teamRole ?? "owner",
          grantedByUserId: creator,
          grantedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [teamProjects.teamId, teamProjects.projectId],
        });
    }
    return publicProject(row);
  });
}

export async function pgWpnUpdateProject(
  id: string,
  patch: { name?: string; sortIndex?: number; colorToken?: string | null },
): Promise<ReturnType<typeof publicProject> | null> {
  return withTx(async (tx) => {
    const cur = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
    const p = cur[0];
    if (!p) return null;
    const name = patch.name !== undefined ? patch.name.trim() || p.name : p.name;
    const sortIndex = patch.sortIndex !== undefined ? patch.sortIndex : p.sortIndex;
    const colorToken =
      patch.colorToken !== undefined ? patch.colorToken : p.colorToken;
    const updatedAtMs = nowMs();
    await tx
      .update(projects)
      .set({ name, sortIndex, colorToken, updatedAtMs })
      .where(eq(projects.id, id));
    return publicProject({ ...p, name, sortIndex, colorToken, updatedAtMs });
  });
}

/**
 * Delete a project. FK CASCADE handles notes / explorer_state /
 * team_projects / mdx_state_* / yjs_state cleanup.
 */
export async function pgWpnDeleteProject(id: string): Promise<boolean> {
  return withTx(async (tx) => {
    const result = await tx
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id });
    return result.length > 0;
  });
}

export async function pgWpnDeleteProjects(
  ids: string[],
): Promise<{ deletedProjectIds: string[] }> {
  if (ids.length === 0) return { deletedProjectIds: [] };
  return withTx(async (tx) => {
    const deleted = await tx
      .delete(projects)
      .where(inArray(projects.id, ids))
      .returning({ id: projects.id });
    return { deletedProjectIds: deleted.map((r) => r.id) };
  });
}

export async function pgWpnGetProjectSettings(
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await getDb()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  const s = rows[0]?.settings;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  return s as Record<string, unknown>;
}

export async function pgWpnPatchProjectSettings(
  id: string,
  settings: Record<string, unknown>,
): Promise<boolean> {
  const result = await getDb()
    .update(projects)
    .set({ settings, updatedAtMs: nowMs() })
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  return result.length > 0;
}

// ---------- notes ----------

export async function pgWpnCreateNote(
  projectId: string,
  payload: {
    anchorId?: string;
    relation: "child" | "sibling" | "root";
    type: string;
    content?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  },
  authorship: { editorUserId: string },
): Promise<{ id: string }> {
  const editorId = authorship.editorUserId;
  const result = await withTx(async (tx) => {
    const projRows = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const project = projRows[0];
    if (!project) throw new Error("Project not found");

    const rawRows = (await tx
      .select()
      .from(notes)
      .where(eq(notes.projectId, projectId))) as NoteRow[];
    const id = newId();
    const t = nowMs();
    const title = (payload.title ?? "").trim() || "Untitled";
    const content = payload.content ?? "";
    const metadata =
      payload.metadata && Object.keys(payload.metadata).length > 0
        ? payload.metadata
        : null;
    const type = normalizeNoteType(payload.type);
    const baseRow: Omit<NoteRow, "parentId" | "siblingIndex"> = {
      id,
      orgId: project.orgId,
      projectId,
      createdByUserId: editorId,
      updatedByUserId: editorId,
      type,
      title,
      content,
      metadata: metadata as unknown,
      createdAtMs: t,
      updatedAtMs: t,
      deleted: null,
    };

    if (payload.relation === "root") {
      const roots = rawRows.filter((r) => r.parentId === null && r.deleted !== true);
      const siblingIndex =
        roots.length === 0 ? 0 : Math.max(...roots.map((r) => r.siblingIndex)) + 1;
      await tx.insert(notes).values({ ...baseRow, parentId: null, siblingIndex });
      await reconcileNoteEdges(tx, id, content);
      return { id, orgId: project.orgId };
    }

    if (!payload.anchorId) throw new Error("anchorId required for child/sibling");
    const anchor = rawRows.find((r) => r.id === payload.anchorId && r.deleted !== true);
    if (!anchor) throw new Error("Anchor note not found");

    if (payload.relation === "child") {
      const kids = rawRows.filter(
        (r) => r.parentId === anchor.id && r.deleted !== true,
      );
      const siblingIndex =
        kids.length === 0 ? 0 : Math.max(...kids.map((r) => r.siblingIndex)) + 1;
      await tx
        .insert(notes)
        .values({ ...baseRow, parentId: anchor.id, siblingIndex });
      await reconcileNoteEdges(tx, id, content);
      return { id, orgId: project.orgId };
    }

    // sibling: insert after anchor among its parent's children, renumber.
    const parentId = anchor.parentId;
    const sibs = rawRows
      .filter((r) => r.parentId === parentId && r.deleted !== true)
      .sort((a, b) => a.siblingIndex - b.siblingIndex);
    const ai = sibs.findIndex((x) => x.id === payload.anchorId);
    if (ai < 0) throw new Error("Invalid anchor");
    const orderedIds = [
      ...sibs.slice(0, ai + 1).map((r) => r.id),
      id,
      ...sibs.slice(ai + 1).map((r) => r.id),
    ];
    await tx.insert(notes).values({ ...baseRow, parentId, siblingIndex: 0 });
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(notes)
        .set({ siblingIndex: i, parentId, updatedAtMs: t })
        .where(and(eq(notes.id, orderedIds[i]!), eq(notes.projectId, projectId)));
    }
    await reconcileNoteEdges(tx, id, content);
    return { id, orgId: project.orgId };
  });
  // Best-effort fanout — failures are swallowed.
  try {
    const after = await getDb()
      .select({
        id: notes.id,
        parentId: notes.parentId,
        title: notes.title,
        type: notes.type,
        siblingIndex: notes.siblingIndex,
        createdByUserId: notes.createdByUserId,
        projectId: notes.projectId,
      })
      .from(notes)
      .where(eq(notes.id, result.id))
      .limit(1);
    const row = after[0];
    if (row) {
      await notifyRealtime(result.orgId, {
        type: "note.created",
        noteId: row.id,
        projectId: row.projectId,
        parentId: row.parentId,
        title: row.title,
        noteType: row.type,
        siblingIndex: row.siblingIndex,
        createdByUserId: row.createdByUserId ?? editorId,
        emittedAt: new Date().toISOString(),
      });
    }
  } catch {
    /* fanout failures must not surface to the writer */
  }
  return { id: result.id };
}

export async function pgWpnUpdateNote(
  noteId: string,
  patch: {
    title?: string;
    content?: string;
    metadata?: Record<string, unknown> | null;
    type?: string;
  },
  authorship: { editorUserId: string },
): Promise<{
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  sibling_index: number;
  created_at_ms: number;
  updated_at_ms: number;
} | null> {
  const editorId = authorship.editorUserId;
  let renamed: { orgId: string; oldTitle: string; newTitle: string; projectId: string } | null = null;
  let edgeDiff: { orgId: string; diff: { added: string[]; removed: string[] } } | null = null;
  const result = await withTx(async (tx) => {
    const nRows = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), sql`${notes.deleted} IS NOT TRUE`))
      .limit(1);
    const n = nRows[0] as NoteRow | undefined;
    if (!n) return null;

    const title = patch.title !== undefined ? patch.title.trim() || n.title : n.title;
    const content = patch.content !== undefined ? patch.content : n.content;
    const type = patch.type !== undefined ? normalizeNoteType(patch.type) : n.type;
    let metadata: Record<string, unknown> | null = (n.metadata as Record<string, unknown>) ?? null;
    if (patch.metadata !== undefined) {
      metadata =
        patch.metadata && Object.keys(patch.metadata).length > 0 ? patch.metadata : null;
    }
    if (patch.title !== undefined && title !== n.title) {
      const clash = await tx
        .select({ id: notes.id })
        .from(notes)
        .where(
          and(
            eq(notes.projectId, n.projectId),
            n.parentId === null
              ? sql`${notes.parentId} IS NULL`
              : eq(notes.parentId, n.parentId),
            eq(notes.title, title),
            sql`${notes.id} <> ${noteId}`,
            sql`${notes.deleted} IS NOT TRUE`,
          ),
        )
        .limit(1);
      if (clash.length > 0) throw new WpnDuplicateSiblingTitleError();
    }
    const updatedAtMs = nowMs();
    await tx
      .update(notes)
      .set({
        title,
        content,
        type,
        metadata,
        updatedAtMs,
        updatedByUserId: editorId,
      })
      .where(eq(notes.id, noteId));

    if (patch.content !== undefined) {
      const diff = await reconcileNoteEdges(tx, noteId, content);
      edgeDiff = { orgId: n.orgId, diff };
    }
    if (patch.title !== undefined && title !== n.title) {
      renamed = {
        orgId: n.orgId,
        oldTitle: n.title,
        newTitle: title,
        projectId: n.projectId,
      };
    }

    return {
      id: n.id,
      project_id: n.projectId,
      parent_id: n.parentId,
      type,
      title,
      content,
      metadata: metadata ?? undefined,
      sibling_index: n.siblingIndex,
      created_at_ms: n.createdAtMs,
      updated_at_ms: updatedAtMs,
    };
  });
  if (renamed) {
    const r = renamed as { orgId: string; oldTitle: string; newTitle: string; projectId: string };
    try {
      await notifyRealtime(r.orgId, {
        type: "note.renamed",
        noteId,
        projectId: r.projectId,
        oldTitle: r.oldTitle,
        newTitle: r.newTitle,
        byUserId: editorId,
        emittedAt: new Date().toISOString(),
      });
    } catch {
      /* swallow */
    }
  }
  if (edgeDiff) {
    const e = edgeDiff as { orgId: string; diff: { added: string[]; removed: string[] } };
    await emitEdgeDiff(e.orgId, noteId, editorId, e.diff);
  }
  return result;
}

export async function pgWpnDeleteNotes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  // Capture pre-delete metadata for the fanout — once the rows are gone we
  // can't reconstruct projectId/orgId.
  const preDelete = await getDb()
    .select({
      id: notes.id,
      orgId: notes.orgId,
      projectId: notes.projectId,
      updatedByUserId: notes.updatedByUserId,
    })
    .from(notes)
    .where(inArray(notes.id, unique));
  await withTx(async (tx) => {
    // FK ON DELETE CASCADE on note_edges + yjs_state handles cleanup.
    await tx.delete(notes).where(inArray(notes.id, unique));
  });
  for (const row of preDelete) {
    try {
      await notifyRealtime(row.orgId, {
        type: "note.deleted",
        noteId: row.id,
        projectId: row.projectId,
        byUserId: row.updatedByUserId ?? "",
        emittedAt: new Date().toISOString(),
      });
    } catch {
      /* swallow */
    }
  }
}

export async function pgWpnMoveNote(
  projectId: string,
  draggedId: string,
  targetId: string,
  placement: NoteMovePlacement,
  authorship: { editorUserId: string },
): Promise<void> {
  const editorId = authorship.editorUserId;
  let beforeState: { fromParentId: string | null; fromSiblingIndex: number } | null = null;
  await withTx(async (tx) => {
    const beforeRows = await tx
      .select({ pid: notes.parentId, si: notes.siblingIndex })
      .from(notes)
      .where(eq(notes.id, draggedId))
      .limit(1);
    if (beforeRows[0]) {
      beforeState = {
        fromParentId: beforeRows[0].pid,
        fromSiblingIndex: beforeRows[0].si,
      };
    }
    const projRows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (projRows.length === 0) throw new Error("Project not found");
    const rawRows = (await tx
      .select()
      .from(notes)
      .where(eq(notes.projectId, projectId))) as NoteRow[];
    const lites = toRowLite(rawRows.filter((r) => r.deleted !== true));
    const childMap = wpnComputeChildMapAfterMove(lites, draggedId, targetId, placement);
    const t = nowMs();
    const walk = async (parentId: string | null, ids: string[]): Promise<void> => {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        await tx
          .update(notes)
          .set({ parentId, siblingIndex: i, updatedAtMs: t })
          .where(and(eq(notes.id, id), eq(notes.projectId, projectId)));
        await walk(id, childMap.get(id) ?? []);
      }
    };
    await walk(null, childMap.get(null) ?? []);
  });
  if (beforeState) {
    const b = beforeState as { fromParentId: string | null; fromSiblingIndex: number };
    try {
      const after = await getDb()
        .select({
          pid: notes.parentId,
          si: notes.siblingIndex,
          orgId: notes.orgId,
        })
        .from(notes)
        .where(eq(notes.id, draggedId))
        .limit(1);
      const a = after[0];
      if (a) {
        await notifyRealtime(a.orgId, {
          type: "note.moved",
          noteId: draggedId,
          projectId,
          fromParentId: b.fromParentId,
          toParentId: a.pid,
          fromSiblingIndex: b.fromSiblingIndex,
          toSiblingIndex: a.si,
          byUserId: editorId,
          emittedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* swallow */
    }
  }
}

export async function pgWpnDuplicateSubtree(
  projectId: string,
  rootNoteId: string,
  authorship: { editorUserId: string },
): Promise<{ newRootId: string }> {
  const editorId = authorship.editorUserId;
  return withTx(async (tx) => {
    const projRows = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const project = projRows[0];
    if (!project) throw new Error("Project not found");
    const dupOrgId = project.orgId;
    const rawRows = (await tx
      .select()
      .from(notes)
      .where(eq(notes.projectId, projectId))) as NoteRow[];
    const active = rawRows.filter((r) => r.deleted !== true);
    const rowMap = new Map(active.map((r) => [r.id, r]));
    const rootRow = rowMap.get(rootNoteId);
    if (!rootRow) throw new Error("Note not found");
    const ordered = collectSubtreePreorder(active, rootNoteId);
    const subtreeIds = new Set(ordered);
    const idMap = new Map<string, string>();
    for (const oid of ordered) idMap.set(oid, newId());
    const newRootId = idMap.get(rootNoteId)!;
    const P = rootRow.parentId;
    const cmBefore = childrenMapFromRows(active);
    const siblingsAtP = (cmBefore.get(P) ?? []).map((r) => r.id);
    const idxAtP = siblingsAtP.indexOf(rootNoteId);
    const newOrderAtP =
      idxAtP >= 0
        ? [...siblingsAtP.slice(0, idxAtP + 1), newRootId, ...siblingsAtP.slice(idxAtP + 1)]
        : [...siblingsAtP, newRootId];

    const t = nowMs();
    for (const oid of ordered) {
      const r = rowMap.get(oid)!;
      const nid = idMap.get(oid)!;
      const newParent =
        r.parentId === null
          ? null
          : subtreeIds.has(r.parentId)
            ? idMap.get(r.parentId)!
            : r.parentId;
      await tx.insert(notes).values({
        id: nid,
        orgId: dupOrgId,
        projectId,
        parentId: newParent,
        createdByUserId: editorId,
        updatedByUserId: editorId,
        type: r.type,
        title: r.title,
        content: r.content,
        metadata: r.metadata,
        siblingIndex: 0,
        createdAtMs: t,
        updatedAtMs: t,
        deleted: null,
      });
      await reconcileNoteEdges(tx, nid, r.content);
    }

    for (let i = 0; i < newOrderAtP.length; i++) {
      const nid = newOrderAtP[i]!;
      await tx
        .update(notes)
        .set({ parentId: P, siblingIndex: i, updatedAtMs: t })
        .where(and(eq(notes.id, nid), eq(notes.projectId, projectId)));
    }

    for (const oid of ordered) {
      const childDocs = (cmBefore.get(oid) ?? []).filter((doc) => subtreeIds.has(doc.id));
      if (childDocs.length === 0) continue;
      const newPid = idMap.get(oid)!;
      const newKidOrder = childDocs.map((doc) => idMap.get(doc.id)!);
      for (let i = 0; i < newKidOrder.length; i++) {
        const nid = newKidOrder[i]!;
        await tx
          .update(notes)
          .set({ parentId: newPid, siblingIndex: i, updatedAtMs: t })
          .where(and(eq(notes.id, nid), eq(notes.projectId, projectId)));
      }
    }

    return { newRootId };
  });
}

export async function pgWpnDuplicateProject(
  sourceProjectId: string,
  opts: { newName?: string; creatorUserId: string; teamId?: string },
): Promise<{ project_id: string; name: string }> {
  return withTx(async (tx) => {
    const srcRows = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, sourceProjectId))
      .limit(1);
    const srcProject = srcRows[0];
    if (!srcProject) throw new Error("Project not found");
    const baseName = (opts.newName ?? "").trim() || srcProject.name;
    const t = nowMs();
    const lastP = await tx
      .select({ s: projects.sortIndex })
      .from(projects)
      .where(eq(projects.orgId, srcProject.orgId))
      .orderBy(desc(projects.sortIndex))
      .limit(1);
    const maxSort = lastP[0]?.s ?? -1;
    const newProjectId = newId();
    const newProj: ProjectRow = {
      id: newProjectId,
      orgId: srcProject.orgId,
      creatorUserId: opts.creatorUserId,
      name: baseName,
      sortIndex: maxSort + 1,
      colorToken: srcProject.colorToken ?? null,
      createdAtMs: t,
      updatedAtMs: t,
      settings:
        srcProject.settings && typeof srcProject.settings === "object"
          ? { ...(srcProject.settings as Record<string, unknown>) }
          : ({} as Record<string, unknown>),
    };
    await tx.insert(projects).values(newProj);

    if (opts.teamId) {
      await tx
        .insert(teamProjects)
        .values({
          teamId: opts.teamId,
          projectId: newProjectId,
          role: "owner",
          grantedByUserId: opts.creatorUserId,
          grantedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [teamProjects.teamId, teamProjects.projectId],
        });
    }

    const srcNotes = (await tx
      .select()
      .from(notes)
      .where(eq(notes.projectId, sourceProjectId))) as NoteRow[];
    const active = srcNotes.filter((r) => r.deleted !== true);
    if (active.length === 0) return { project_id: newProjectId, name: baseName };
    const idMap = new Map<string, string>();
    for (const n of active) idMap.set(n.id, newId());
    const editor = opts.creatorUserId;
    for (const n of active) {
      const newNoteId = idMap.get(n.id)!;
      const newParent = n.parentId === null ? null : idMap.get(n.parentId) ?? null;
      await tx.insert(notes).values({
        id: newNoteId,
        orgId: srcProject.orgId,
        projectId: newProjectId,
        parentId: newParent,
        createdByUserId: editor,
        updatedByUserId: editor,
        type: n.type,
        title: n.title,
        content: n.content,
        metadata: n.metadata,
        siblingIndex: n.siblingIndex,
        createdAtMs: t,
        updatedAtMs: t,
        deleted: null,
      });
      await reconcileNoteEdges(tx, newNoteId, n.content);
    }

    return { project_id: newProjectId, name: baseName };
  });
}

/**
 * Cross-project move. Reassigns the note (and its subtree) into a target
 * project, attached as a child of `targetParentId` (or as a root when
 * `targetParentId` is null). Renumbers siblings on both sides.
 */
export async function pgWpnMoveNoteToProject(
  sourceNoteId: string,
  targetProjectId: string,
  targetParentId: string | null,
  authorship: { editorUserId: string },
): Promise<void> {
  const editorId = authorship.editorUserId;
  let moveBefore: {
    fromParentId: string | null;
    fromSiblingIndex: number;
    fromProjectId: string;
    fromOrgId: string;
  } | null = null;
  let moveAfter: { toOrgId: string; toSiblingIndex: number } | null = null;
  await withTx(async (tx) => {
    const srcRows = await tx
      .select()
      .from(notes)
      .where(eq(notes.id, sourceNoteId))
      .limit(1);
    const source = srcRows[0] as NoteRow | undefined;
    if (!source || source.deleted === true) throw new Error("Note not found");
    const sourceProjectId = source.projectId;
    moveBefore = {
      fromParentId: source.parentId,
      fromSiblingIndex: source.siblingIndex,
      fromProjectId: sourceProjectId,
      fromOrgId: source.orgId,
    };
    if (
      sourceProjectId === targetProjectId &&
      (source.parentId ?? null) === (targetParentId ?? null)
    ) {
      return;
    }
    const targetProjRows = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, targetProjectId))
      .limit(1);
    const targetProject = targetProjRows[0];
    if (!targetProject) throw new Error("Target project not found");
    if (targetParentId) {
      const parentRows = await tx
        .select({ id: notes.id, deleted: notes.deleted })
        .from(notes)
        .where(
          and(
            eq(notes.id, targetParentId),
            eq(notes.projectId, targetProjectId),
          ),
        )
        .limit(1);
      const parent = parentRows[0];
      if (!parent || parent.deleted === true) {
        throw new Error("Target parent note not found in target project");
      }
    }
    // Collect the subtree under sourceNoteId.
    const sourceRows = (await tx
      .select()
      .from(notes)
      .where(eq(notes.projectId, sourceProjectId))) as NoteRow[];
    const subtreeIds = collectSubtreePreorder(
      sourceRows.filter((r) => r.deleted !== true),
      sourceNoteId,
    );
    const t = nowMs();
    // Compute target sibling index (append at end of targetParent's kids).
    const targetSiblings = await tx
      .select({ s: notes.siblingIndex })
      .from(notes)
      .where(
        and(
          eq(notes.projectId, targetProjectId),
          targetParentId === null
            ? sql`${notes.parentId} IS NULL`
            : eq(notes.parentId, targetParentId),
          sql`${notes.deleted} IS NOT TRUE`,
        ),
      )
      .orderBy(desc(notes.siblingIndex))
      .limit(1);
    const newSiblingIndex = (targetSiblings[0]?.s ?? -1) + 1;
    // Reassign every subtree note to the target project + new orgId.
    if (subtreeIds.length > 0) {
      await tx
        .update(notes)
        .set({
          projectId: targetProjectId,
          orgId: targetProject.orgId,
          updatedAtMs: t,
          updatedByUserId: editorId,
        })
        .where(inArray(notes.id, subtreeIds));
    }
    // Reparent the dragged root onto targetParentId at newSiblingIndex.
    await tx
      .update(notes)
      .set({ parentId: targetParentId, siblingIndex: newSiblingIndex })
      .where(eq(notes.id, sourceNoteId));
    moveAfter = { toOrgId: targetProject.orgId, toSiblingIndex: newSiblingIndex };
    // Renumber siblings on the source side (the note left a gap).
    if (sourceProjectId !== targetProjectId || (source.parentId ?? null) !== (targetParentId ?? null)) {
      const remaining = await tx
        .select({ id: notes.id })
        .from(notes)
        .where(
          and(
            eq(notes.projectId, sourceProjectId),
            source.parentId === null
              ? sql`${notes.parentId} IS NULL`
              : eq(notes.parentId, source.parentId),
            sql`${notes.deleted} IS NOT TRUE`,
            sql`${notes.id} <> ${sourceNoteId}`,
          ),
        )
        .orderBy(asc(notes.siblingIndex));
      for (let i = 0; i < remaining.length; i++) {
        await tx
          .update(notes)
          .set({ siblingIndex: i, updatedAtMs: t })
          .where(eq(notes.id, remaining[i]!.id));
      }
    }
  });
  // Fanout — emit two events: one on the source channel (with from-coords)
  // and one on the target channel (with to-coords). Subscribers on either
  // side stay in sync.
  if (moveBefore && moveAfter) {
    const mb = moveBefore as {
      fromParentId: string | null;
      fromSiblingIndex: number;
      fromProjectId: string;
      fromOrgId: string;
    };
    const ma = moveAfter as { toOrgId: string; toSiblingIndex: number };
    const stamp = new Date().toISOString();
    try {
      await notifyRealtime(mb.fromOrgId, {
        type: "note.moved",
        noteId: sourceNoteId,
        projectId: mb.fromProjectId,
        fromParentId: mb.fromParentId,
        toParentId: targetParentId,
        fromSiblingIndex: mb.fromSiblingIndex,
        toSiblingIndex: ma.toSiblingIndex,
        byUserId: editorId,
        emittedAt: stamp,
      });
    } catch {
      /* swallow */
    }
    if (ma.toOrgId !== mb.fromOrgId) {
      try {
        await notifyRealtime(ma.toOrgId, {
          type: "note.moved",
          noteId: sourceNoteId,
          projectId: targetProjectId,
          fromParentId: mb.fromParentId,
          toParentId: targetParentId,
          fromSiblingIndex: mb.fromSiblingIndex,
          toSiblingIndex: ma.toSiblingIndex,
          byUserId: editorId,
          emittedAt: stamp,
        });
      } catch {
        /* swallow */
      }
    }
  }
}

// ---------- explorer state ----------

export async function pgWpnSetExplorerExpanded(
  userId: string,
  projectId: string,
  expandedIds: string[],
): Promise<void> {
  await getDb()
    .insert(explorerState)
    .values({ userId, projectId, expandedIds })
    .onConflictDoUpdate({
      target: [explorerState.userId, explorerState.projectId],
      set: { expandedIds },
    });
}

// Suppress unused-import warning for asc (kept for sort hints in future ports).
void asc;
