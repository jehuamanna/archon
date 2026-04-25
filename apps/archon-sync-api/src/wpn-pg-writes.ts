/**
 * Postgres counterpart of `wpn-mongo-writes.ts`. Mirrors the export surface so
 * route handlers can swap mongo* → pg* with a one-line change. All
 * multi-statement operations run inside a single `withTx` so partial failures
 * don't leave the tree in a corrupt state.
 *
 * Key differences vs the Mongo version:
 *   - All ids are uuid; cycle prevention for tree moves runs as a recursive
 *     CTE inside the same transaction (no app-side guards).
 *   - On every note write (create/update/delete subtree) the helper
 *     reconcileNoteEdges runs: parse markdown content for `#/n/<id>`
 *     references via the shared markdown-internal-note-href module and
 *     delete-then-insert the edges for that source. VFS-path references
 *     (`#/w/...`) are left to the importer's Pass-3 backfill plus a future
 *     resolver — they don't break correctness, only completeness.
 */
import * as crypto from "node:crypto";
import { and, eq, inArray, sql, desc, asc } from "drizzle-orm";
import { getDb, withTx } from "./pg.js";
import {
  wpnWorkspaces,
  wpnProjects,
  wpnNotes,
  wpnExplorerState,
  noteEdges,
} from "./db/schema.js";
import {
  type NoteMovePlacement,
  type WpnNoteRowLite,
  wpnComputeChildMapAfterMove,
} from "./wpn-tree.js";

// ---------- public surface (kept identical to wpn-mongo-writes.ts) ----------

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

interface NoteRow {
  id: string;
  userId: string;
  orgId: string | null;
  spaceId: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  content: string;
  metadata: unknown;
  sibling_index: number;
  created_at_ms: number;
  updated_at_ms: number;
  deleted: boolean | null;
}

function toRowLite(rows: NoteRow[]): WpnNoteRowLite[] {
  return rows
    .filter((r) => r.deleted !== true)
    .map((r) => ({ id: r.id, parent_id: r.parent_id, sibling_index: r.sibling_index }));
}

function childrenMapFromRows(rows: NoteRow[]): Map<string | null, NoteRow[]> {
  const active = rows.filter((r) => r.deleted !== true);
  const m = new Map<string | null, NoteRow[]>();
  for (const r of active) {
    const k = r.parent_id;
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.sibling_index - b.sibling_index);
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

/** Public projection (same shape Mongo writers returned). */
function publicWorkspace(w: typeof wpnWorkspaces.$inferSelect): {
  id: string;
  orgId?: string;
  spaceId?: string;
  visibility?: string | null;
  creatorUserId?: string | null;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
} {
  return {
    id: w.id,
    ...(w.orgId ? { orgId: w.orgId } : {}),
    ...(w.spaceId ? { spaceId: w.spaceId } : {}),
    visibility: w.visibility,
    creatorUserId: w.creatorUserId,
    name: w.name,
    sort_index: w.sort_index,
    color_token: w.color_token,
    created_at_ms: w.created_at_ms,
    updated_at_ms: w.updated_at_ms,
  };
}

function publicProject(p: typeof wpnProjects.$inferSelect): {
  id: string;
  orgId?: string;
  spaceId?: string;
  visibility?: string | null;
  creatorUserId?: string | null;
  workspace_id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
} {
  return {
    id: p.id,
    ...(p.orgId ? { orgId: p.orgId } : {}),
    ...(p.spaceId ? { spaceId: p.spaceId } : {}),
    visibility: p.visibility,
    creatorUserId: p.creatorUserId,
    workspace_id: p.workspace_id,
    name: p.name,
    sort_index: p.sort_index,
    color_token: p.color_token,
    created_at_ms: p.created_at_ms,
    updated_at_ms: p.updated_at_ms,
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
 *
 * Only `#/n/<uuid>` references land as edges right now; vfs-path links
 * (`#/w/<vfsPath>`) need title→id resolution and are deferred to the
 * importer's Pass-3 backfill plus a future resolver. Save-path correctness
 * is preserved; the gap is "not every link makes it into note_edges yet".
 */
async function reconcileNoteEdges(
  tx: ReturnType<typeof getDb>,
  srcNoteId: string,
  content: string,
): Promise<void> {
  const lib = await loadMarkdownLib();
  const ids = lib.collectReferencedNoteIdsFromMarkdown(content);
  // Defensive: drop self-references and non-uuid noise.
  const dstSet = new Set<string>();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of ids) {
    if (id === srcNoteId) continue;
    if (!UUID_RE.test(id)) continue;
    dstSet.add(id);
  }
  await tx.delete(noteEdges).where(eq(noteEdges.src, srcNoteId));
  if (dstSet.size === 0) return;
  await tx.insert(noteEdges).values(
    Array.from(dstSet).map((dst) => ({
      src: srcNoteId,
      dst,
      kind: "link",
      meta: null as unknown,
    })),
  );
}

// ---------- workspaces ----------

export async function pgWpnCreateWorkspace(
  userId: string,
  name: string,
  scope?: { orgId?: string; spaceId?: string; creatorUserId?: string },
): Promise<ReturnType<typeof publicWorkspace>> {
  return withTx(async (tx) => {
    const t = nowMs();
    const last = await tx
      .select({ s: wpnWorkspaces.sort_index })
      .from(wpnWorkspaces)
      .where(eq(wpnWorkspaces.userId, userId))
      .orderBy(desc(wpnWorkspaces.sort_index))
      .limit(1);
    const maxSort = last[0]?.s ?? -1;
    const id = newId();
    const row = {
      id,
      userId,
      orgId: scope?.orgId ?? null,
      spaceId: scope?.spaceId ?? null,
      visibility: "public",
      creatorUserId: scope?.creatorUserId ?? userId,
      name: name.trim() || "Workspace",
      sort_index: maxSort + 1,
      color_token: null,
      created_at_ms: t,
      updated_at_ms: t,
      settings: {} as unknown,
    };
    await tx.insert(wpnWorkspaces).values(row);
    return publicWorkspace(row as typeof wpnWorkspaces.$inferSelect);
  });
}

export async function pgWpnUpdateWorkspace(
  userId: string,
  id: string,
  patch: { name?: string; sort_index?: number; color_token?: string | null },
): Promise<ReturnType<typeof publicWorkspace> | null> {
  return withTx(async (tx) => {
    const cur = await tx
      .select()
      .from(wpnWorkspaces)
      .where(and(eq(wpnWorkspaces.id, id), eq(wpnWorkspaces.userId, userId)))
      .limit(1);
    const w = cur[0];
    if (!w) return null;
    const name = patch.name !== undefined ? patch.name.trim() || w.name : w.name;
    const sort_index = patch.sort_index !== undefined ? patch.sort_index : w.sort_index;
    const color_token = patch.color_token !== undefined ? patch.color_token : w.color_token;
    const updated_at_ms = nowMs();
    await tx
      .update(wpnWorkspaces)
      .set({ name, sort_index, color_token, updated_at_ms })
      .where(and(eq(wpnWorkspaces.id, id), eq(wpnWorkspaces.userId, userId)));
    return publicWorkspace({ ...w, name, sort_index, color_token, updated_at_ms });
  });
}

/** Cascade `space_id` across the workspace and every descendant. */
export async function pgWpnReassignWorkspaceSpace(
  workspace_id: string,
  targetSpaceId: string,
): Promise<ReturnType<typeof publicWorkspace> | null> {
  return withTx(async (tx) => {
    const cur = await tx
      .select()
      .from(wpnWorkspaces)
      .where(eq(wpnWorkspaces.id, workspace_id))
      .limit(1);
    const w = cur[0];
    if (!w) return null;
    const t = nowMs();
    await tx
      .update(wpnWorkspaces)
      .set({ spaceId: targetSpaceId, updated_at_ms: t })
      .where(eq(wpnWorkspaces.id, workspace_id));
    const projects = await tx
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(eq(wpnProjects.workspace_id, workspace_id));
    const project_ids = projects.map((p) => p.id);
    await tx
      .update(wpnProjects)
      .set({ spaceId: targetSpaceId, updated_at_ms: t })
      .where(eq(wpnProjects.workspace_id, workspace_id));
    if (project_ids.length > 0) {
      await tx
        .update(wpnNotes)
        .set({ spaceId: targetSpaceId })
        .where(inArray(wpnNotes.project_id, project_ids));
      await tx
        .update(wpnExplorerState)
        .set({ spaceId: targetSpaceId })
        .where(inArray(wpnExplorerState.project_id, project_ids));
    }
    return publicWorkspace({ ...w, spaceId: targetSpaceId, updated_at_ms: t });
  });
}

export async function pgWpnDeleteWorkspace(userId: string, id: string): Promise<boolean> {
  return withTx(async (tx) => {
    const owned = await tx
      .select({ id: wpnWorkspaces.id })
      .from(wpnWorkspaces)
      .where(and(eq(wpnWorkspaces.id, id), eq(wpnWorkspaces.userId, userId)))
      .limit(1);
    if (owned.length === 0) return false;
    const projects = await tx
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(and(eq(wpnProjects.workspace_id, id), eq(wpnProjects.userId, userId)));
    const project_ids = projects.map((p) => p.id);
    if (project_ids.length > 0) {
      await tx.delete(wpnNotes).where(
        and(eq(wpnNotes.userId, userId), inArray(wpnNotes.project_id, project_ids)),
      );
      await tx.delete(wpnExplorerState).where(
        and(eq(wpnExplorerState.userId, userId), inArray(wpnExplorerState.project_id, project_ids)),
      );
    }
    await tx.delete(wpnProjects).where(
      and(eq(wpnProjects.userId, userId), eq(wpnProjects.workspace_id, id)),
    );
    await tx.delete(wpnWorkspaces).where(
      and(eq(wpnWorkspaces.id, id), eq(wpnWorkspaces.userId, userId)),
    );
    return true;
  });
}

export async function pgWpnDeleteWorkspaces(
  userId: string,
  ids: string[],
): Promise<{ deletedWorkspaceIds: string[] }> {
  if (ids.length === 0) return { deletedWorkspaceIds: [] };
  return withTx(async (tx) => {
    const owned = await tx
      .select({ id: wpnWorkspaces.id })
      .from(wpnWorkspaces)
      .where(and(eq(wpnWorkspaces.userId, userId), inArray(wpnWorkspaces.id, ids)));
    const ownedIds = owned.map((w) => w.id);
    if (ownedIds.length === 0) return { deletedWorkspaceIds: [] };
    const projects = await tx
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(
        and(eq(wpnProjects.userId, userId), inArray(wpnProjects.workspace_id, ownedIds)),
      );
    const project_ids = projects.map((p) => p.id);
    if (project_ids.length > 0) {
      await tx.delete(wpnNotes).where(
        and(eq(wpnNotes.userId, userId), inArray(wpnNotes.project_id, project_ids)),
      );
      await tx.delete(wpnExplorerState).where(
        and(
          eq(wpnExplorerState.userId, userId),
          inArray(wpnExplorerState.project_id, project_ids),
        ),
      );
    }
    await tx.delete(wpnProjects).where(
      and(eq(wpnProjects.userId, userId), inArray(wpnProjects.workspace_id, ownedIds)),
    );
    await tx.delete(wpnWorkspaces).where(
      and(eq(wpnWorkspaces.userId, userId), inArray(wpnWorkspaces.id, ownedIds)),
    );
    return { deletedWorkspaceIds: ownedIds };
  });
}

// ---------- projects ----------

export async function pgWpnCreateProject(
  userId: string,
  workspace_id: string,
  name: string,
  opts?: { creatorUserId?: string },
): Promise<ReturnType<typeof publicProject> | null> {
  return withTx(async (tx) => {
    const wsRows = await tx
      .select()
      .from(wpnWorkspaces)
      .where(and(eq(wpnWorkspaces.id, workspace_id), eq(wpnWorkspaces.userId, userId)))
      .limit(1);
    const ws = wsRows[0];
    if (!ws) return null;
    const t = nowMs();
    const last = await tx
      .select({ s: wpnProjects.sort_index })
      .from(wpnProjects)
      .where(
        and(eq(wpnProjects.userId, userId), eq(wpnProjects.workspace_id, workspace_id)),
      )
      .orderBy(desc(wpnProjects.sort_index))
      .limit(1);
    const maxSort = last[0]?.s ?? -1;
    const id = newId();
    const row = {
      id,
      userId,
      orgId: ws.orgId,
      spaceId: ws.spaceId,
      visibility: "public",
      creatorUserId: opts?.creatorUserId ?? userId,
      workspace_id,
      name: name.trim() || "Project",
      sort_index: maxSort + 1,
      color_token: null,
      created_at_ms: t,
      updated_at_ms: t,
      settings: {} as unknown,
    };
    await tx.insert(wpnProjects).values(row);
    return publicProject(row as typeof wpnProjects.$inferSelect);
  });
}

export async function pgWpnUpdateProject(
  userId: string,
  id: string,
  patch: {
    name?: string;
    sort_index?: number;
    color_token?: string | null;
    workspace_id?: string;
  },
): Promise<ReturnType<typeof publicProject> | null> {
  return withTx(async (tx) => {
    const curRows = await tx
      .select()
      .from(wpnProjects)
      .where(and(eq(wpnProjects.id, id), eq(wpnProjects.userId, userId)))
      .limit(1);
    const cur = curRows[0];
    if (!cur) return null;
    if (patch.workspace_id !== undefined) {
      const ws = await tx
        .select({ id: wpnWorkspaces.id })
        .from(wpnWorkspaces)
        .where(
          and(
            eq(wpnWorkspaces.id, patch.workspace_id),
            eq(wpnWorkspaces.userId, userId),
          ),
        )
        .limit(1);
      if (ws.length === 0) return null;
    }
    const name = patch.name !== undefined ? patch.name.trim() || cur.name : cur.name;
    const sort_index = patch.sort_index !== undefined ? patch.sort_index : cur.sort_index;
    const color_token =
      patch.color_token !== undefined ? patch.color_token : cur.color_token;
    const workspace_id =
      patch.workspace_id !== undefined ? patch.workspace_id : cur.workspace_id;
    const updated_at_ms = nowMs();
    await tx
      .update(wpnProjects)
      .set({ name, sort_index, color_token, workspace_id, updated_at_ms })
      .where(and(eq(wpnProjects.id, id), eq(wpnProjects.userId, userId)));
    return publicProject({ ...cur, name, sort_index, color_token, workspace_id, updated_at_ms });
  });
}

export async function pgWpnDeleteProjects(
  userId: string,
  ids: string[],
): Promise<{ deletedProjectIds: string[] }> {
  if (ids.length === 0) return { deletedProjectIds: [] };
  return withTx(async (tx) => {
    const owned = await tx
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(and(eq(wpnProjects.userId, userId), inArray(wpnProjects.id, ids)));
    const ownedIds = owned.map((p) => p.id);
    if (ownedIds.length === 0) return { deletedProjectIds: [] };
    await tx.delete(wpnNotes).where(
      and(eq(wpnNotes.userId, userId), inArray(wpnNotes.project_id, ownedIds)),
    );
    await tx.delete(wpnExplorerState).where(
      and(
        eq(wpnExplorerState.userId, userId),
        inArray(wpnExplorerState.project_id, ownedIds),
      ),
    );
    await tx.delete(wpnProjects).where(
      and(eq(wpnProjects.userId, userId), inArray(wpnProjects.id, ownedIds)),
    );
    return { deletedProjectIds: ownedIds };
  });
}

export async function pgWpnDeleteProject(userId: string, id: string): Promise<boolean> {
  return withTx(async (tx) => {
    const p = await tx
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(and(eq(wpnProjects.id, id), eq(wpnProjects.userId, userId)))
      .limit(1);
    if (p.length === 0) return false;
    await tx.delete(wpnNotes).where(
      and(eq(wpnNotes.userId, userId), eq(wpnNotes.project_id, id)),
    );
    await tx.delete(wpnExplorerState).where(
      and(eq(wpnExplorerState.userId, userId), eq(wpnExplorerState.project_id, id)),
    );
    await tx.delete(wpnProjects).where(
      and(eq(wpnProjects.id, id), eq(wpnProjects.userId, userId)),
    );
    return true;
  });
}

// ---------- notes ----------

export async function pgWpnCreateNote(
  userId: string,
  project_id: string,
  payload: {
    anchorId?: string;
    relation: "child" | "sibling" | "root";
    type: string;
    content?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  },
  authorship?: { editorUserId?: string },
): Promise<{ id: string }> {
  return withTx(async (tx) => {
    const projRows = await tx
      .select()
      .from(wpnProjects)
      .where(and(eq(wpnProjects.id, project_id), eq(wpnProjects.userId, userId)))
      .limit(1);
    const project = projRows[0];
    if (!project) throw new Error("Project not found");

    const rawRows = (await tx
      .select()
      .from(wpnNotes)
      .where(and(eq(wpnNotes.userId, userId), eq(wpnNotes.project_id, project_id)))) as NoteRow[];
    const id = newId();
    const t = nowMs();
    const title = (payload.title ?? "").trim() || "Untitled";
    const content = payload.content ?? "";
    const metadata =
      payload.metadata && Object.keys(payload.metadata).length > 0 ? payload.metadata : null;
    const type = normalizeNoteType(payload.type);
    const editorId = authorship?.editorUserId ?? userId;
    const baseRow = {
      id,
      userId,
      orgId: project.orgId,
      spaceId: project.spaceId,
      created_by_user_id: editorId,
      updated_by_user_id: editorId,
      project_id,
      type,
      title,
      content,
      metadata: metadata as unknown,
      created_at_ms: t,
      updated_at_ms: t,
      deleted: null as boolean | null,
    };

    if (payload.relation === "root") {
      const roots = rawRows.filter((r) => r.parent_id === null && r.deleted !== true);
      const sibling_index =
        roots.length === 0 ? 0 : Math.max(...roots.map((r) => r.sibling_index)) + 1;
      await tx.insert(wpnNotes).values({ ...baseRow, parent_id: null, sibling_index });
      await reconcileNoteEdges(tx, id, content);
      return { id };
    }

    if (!payload.anchorId) throw new Error("anchorId required for child/sibling");
    const anchor = rawRows.find((r) => r.id === payload.anchorId && r.deleted !== true);
    if (!anchor) throw new Error("Anchor note not found");

    if (payload.relation === "child") {
      const kids = rawRows.filter(
        (r) => r.parent_id === anchor.id && r.deleted !== true,
      );
      const sibling_index =
        kids.length === 0 ? 0 : Math.max(...kids.map((r) => r.sibling_index)) + 1;
      await tx
        .insert(wpnNotes)
        .values({ ...baseRow, parent_id: anchor.id, sibling_index });
      await reconcileNoteEdges(tx, id, content);
      return { id };
    }

    // sibling
    const parent_id = anchor.parent_id;
    const sibs = rawRows
      .filter((r) => r.parent_id === parent_id && r.deleted !== true)
      .sort((a, b) => a.sibling_index - b.sibling_index);
    const ai = sibs.findIndex((x) => x.id === payload.anchorId);
    if (ai < 0) throw new Error("Invalid anchor");
    const orderedIds = [
      ...sibs.slice(0, ai + 1).map((r) => r.id),
      id,
      ...sibs.slice(ai + 1).map((r) => r.id),
    ];
    await tx.insert(wpnNotes).values({ ...baseRow, parent_id, sibling_index: 0 });
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(wpnNotes)
        .set({ sibling_index: i, parent_id, updated_at_ms: t })
        .where(
          and(
            eq(wpnNotes.id, orderedIds[i]!),
            eq(wpnNotes.userId, userId),
            eq(wpnNotes.project_id, project_id),
          ),
        );
    }
    await reconcileNoteEdges(tx, id, content);
    return { id };
  });
}

export async function pgWpnUpdateNote(
  userId: string,
  noteId: string,
  patch: {
    title?: string;
    content?: string;
    metadata?: Record<string, unknown> | null;
    type?: string;
  },
  authorship?: { editorUserId?: string },
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
  return withTx(async (tx) => {
    const nRows = await tx
      .select()
      .from(wpnNotes)
      .where(
        and(
          eq(wpnNotes.id, noteId),
          eq(wpnNotes.userId, userId),
          sql`${wpnNotes.deleted} IS NOT TRUE`,
        ),
      )
      .limit(1);
    const n = nRows[0] as NoteRow | undefined;
    if (!n) return null;
    const pRows = await tx
      .select()
      .from(wpnProjects)
      .where(and(eq(wpnProjects.id, n.project_id), eq(wpnProjects.userId, userId)))
      .limit(1);
    const p = pRows[0];
    if (!p) return null;
    const wsRows = await tx
      .select({ id: wpnWorkspaces.id })
      .from(wpnWorkspaces)
      .where(and(eq(wpnWorkspaces.id, p.workspace_id), eq(wpnWorkspaces.userId, userId)))
      .limit(1);
    if (wsRows.length === 0) return null;

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
        .select({ id: wpnNotes.id })
        .from(wpnNotes)
        .where(
          and(
            eq(wpnNotes.userId, userId),
            eq(wpnNotes.project_id, n.project_id),
            n.parent_id === null
              ? sql`${wpnNotes.parent_id} IS NULL`
              : eq(wpnNotes.parent_id, n.parent_id),
            eq(wpnNotes.title, title),
            sql`${wpnNotes.id} <> ${noteId}`,
            sql`${wpnNotes.deleted} IS NOT TRUE`,
          ),
        )
        .limit(1);
      if (clash.length > 0) throw new WpnDuplicateSiblingTitleError();
    }
    const updated_at_ms = nowMs();
    const setFields: Record<string, unknown> = {
      title,
      content,
      type,
      metadata,
      updated_at_ms,
    };
    if (authorship?.editorUserId) setFields.updated_by_user_id = authorship.editorUserId;
    await tx
      .update(wpnNotes)
      .set(setFields)
      .where(and(eq(wpnNotes.id, noteId), eq(wpnNotes.userId, userId)));

    if (patch.content !== undefined) {
      await reconcileNoteEdges(tx, noteId, content);
    }

    return {
      id: n.id,
      project_id: n.project_id,
      parent_id: n.parent_id,
      type,
      title,
      content,
      metadata: metadata ?? undefined,
      sibling_index: n.sibling_index,
      created_at_ms: n.created_at_ms,
      updated_at_ms: updated_at_ms,
    };
  });
}

export async function pgWpnDeleteNotes(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  await withTx(async (tx) => {
    // FK ON DELETE CASCADE on note_edges handles edge cleanup automatically.
    await tx.delete(wpnNotes).where(
      and(eq(wpnNotes.userId, userId), inArray(wpnNotes.id, unique)),
    );
  });
}

export async function pgWpnMoveNote(
  userId: string,
  project_id: string,
  draggedId: string,
  targetId: string,
  placement: NoteMovePlacement,
): Promise<void> {
  await withTx(async (tx) => {
    const projRows = await tx
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(and(eq(wpnProjects.id, project_id), eq(wpnProjects.userId, userId)))
      .limit(1);
    if (projRows.length === 0) throw new Error("Project not found");
    const rawRows = (await tx
      .select()
      .from(wpnNotes)
      .where(
        and(eq(wpnNotes.userId, userId), eq(wpnNotes.project_id, project_id)),
      )) as NoteRow[];
    const lites = toRowLite(rawRows.filter((r) => r.deleted !== true));
    const childMap = wpnComputeChildMapAfterMove(lites, draggedId, targetId, placement);
    const t = nowMs();
    const walk = async (parent_id: string | null, ids: string[]): Promise<void> => {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        await tx
          .update(wpnNotes)
          .set({ parent_id, sibling_index: i, updated_at_ms: t })
          .where(
            and(
              eq(wpnNotes.id, id),
              eq(wpnNotes.userId, userId),
              eq(wpnNotes.project_id, project_id),
            ),
          );
        await walk(id, childMap.get(id) ?? []);
      }
    };
    await walk(null, childMap.get(null) ?? []);
  });
}

export async function pgWpnMoveNoteToProject(
  userId: string,
  sourceNoteId: string,
  targetProjectId: string,
  targetParentId: string | null,
): Promise<void> {
  await withTx(async (tx) => {
    const srcRows = await tx
      .select()
      .from(wpnNotes)
      .where(and(eq(wpnNotes.id, sourceNoteId), eq(wpnNotes.userId, userId)))
      .limit(1);
    const source = srcRows[0] as NoteRow | undefined;
    if (!source || source.deleted === true) throw new Error("Note not found");
    const sourceProjectId = source.project_id;
    if (
      sourceProjectId === targetProjectId &&
      (source.parent_id ?? null) === (targetParentId ?? null)
    ) {
      return; // no-op
    }
    const targetProjRows = await tx
      .select()
      .from(wpnProjects)
      .where(and(eq(wpnProjects.id, targetProjectId), eq(wpnProjects.userId, userId)))
      .limit(1);
    const targetProject = targetProjRows[0];
    if (!targetProject) throw new Error("Target project not found");
    if (targetParentId) {
      const parentRows = await tx
        .select({ id: wpnNotes.id, deleted: wpnNotes.deleted })
        .from(wpnNotes)
        .where(
          and(
            eq(wpnNotes.id, targetParentId),
            eq(wpnNotes.userId, userId),
            eq(wpnNotes.project_id, targetProjectId),
          ),
        )
        .limit(1);
      const parent = parentRows[0];
      if (!parent || parent.deleted === true) {
        throw new Error("Target parent note not found in target project");
      }
    }

    const sourceRows = (await tx
      .select()
      .from(wpnNotes)
      .where(
        and(eq(wpnNotes.userId, userId), eq(wpnNotes.project_id, sourceProjectId)),
      )) as NoteRow[];
    const subtreeIds = collectSubtreePreorder(
      sourceRows.filter((r) => r.deleted !== true),
      sourceNoteId,
    );

    if (
      sourceProjectId === targetProjectId &&
      targetParentId &&
      subtreeIds.includes(targetParentId)
    ) {
      throw new Error("Cannot move a note into its own descendant");
    }

    const targetSiblings = await tx
      .select({ sibling_index: wpnNotes.sibling_index })
      .from(wpnNotes)
      .where(
        and(
          eq(wpnNotes.userId, userId),
          eq(wpnNotes.project_id, targetProjectId),
          targetParentId === null
            ? sql`${wpnNotes.parent_id} IS NULL`
            : eq(wpnNotes.parent_id, targetParentId),
          sql`${wpnNotes.deleted} IS NOT TRUE`,
        ),
      );
    const maxIdx = targetSiblings.reduce(
      (m, r) => (r.sibling_index > m ? r.sibling_index : m),
      -1,
    );
    const newRootIdx = maxIdx + 1;
    const t = nowMs();

    await tx
      .update(wpnNotes)
      .set({
        project_id: targetProjectId,
        orgId: targetProject.orgId,
        spaceId: targetProject.spaceId,
        updated_at_ms: t,
      })
      .where(and(eq(wpnNotes.userId, userId), inArray(wpnNotes.id, subtreeIds)));

    await tx
      .update(wpnNotes)
      .set({ parent_id: targetParentId, sibling_index: newRootIdx, updated_at_ms: t })
      .where(and(eq(wpnNotes.userId, userId), eq(wpnNotes.id, sourceNoteId)));

    // Reindex source-side siblings (root has been moved out).
    const sourceParent = source.parent_id;
    const sourceSiblings = await tx
      .select({ id: wpnNotes.id, sibling_index: wpnNotes.sibling_index })
      .from(wpnNotes)
      .where(
        and(
          eq(wpnNotes.userId, userId),
          eq(wpnNotes.project_id, sourceProjectId),
          sourceParent === null
            ? sql`${wpnNotes.parent_id} IS NULL`
            : eq(wpnNotes.parent_id, sourceParent),
          sql`${wpnNotes.deleted} IS NOT TRUE`,
        ),
      )
      .orderBy(asc(wpnNotes.sibling_index));
    for (let i = 0; i < sourceSiblings.length; i++) {
      const s = sourceSiblings[i]!;
      if (s.sibling_index !== i) {
        await tx
          .update(wpnNotes)
          .set({ sibling_index: i, updated_at_ms: t })
          .where(and(eq(wpnNotes.id, s.id), eq(wpnNotes.userId, userId)));
      }
    }
  });
}

export async function pgWpnDuplicateSubtree(
  userId: string,
  project_id: string,
  rootNoteId: string,
): Promise<{ newRootId: string }> {
  return withTx(async (tx) => {
    const projRows = await tx
      .select()
      .from(wpnProjects)
      .where(and(eq(wpnProjects.id, project_id), eq(wpnProjects.userId, userId)))
      .limit(1);
    const project = projRows[0];
    if (!project) throw new Error("Project not found");
    const dupOrgId = project.orgId;
    const dupSpaceId = project.spaceId;
    const rawRows = (await tx
      .select()
      .from(wpnNotes)
      .where(and(eq(wpnNotes.userId, userId), eq(wpnNotes.project_id, project_id)))) as NoteRow[];
    const active = rawRows.filter((r) => r.deleted !== true);
    const rowMap = new Map(active.map((r) => [r.id, r]));
    const rootRow = rowMap.get(rootNoteId);
    if (!rootRow) throw new Error("Note not found");
    const ordered = collectSubtreePreorder(active, rootNoteId);
    const subtreeIds = new Set(ordered);
    const idMap = new Map<string, string>();
    for (const oid of ordered) idMap.set(oid, newId());
    const newRootId = idMap.get(rootNoteId)!;
    const P = rootRow.parent_id;
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
        r.parent_id === null
          ? null
          : subtreeIds.has(r.parent_id)
            ? idMap.get(r.parent_id)!
            : r.parent_id;
      await tx.insert(wpnNotes).values({
        id: nid,
        userId,
        orgId: dupOrgId,
        spaceId: dupSpaceId,
        created_by_user_id: r.created_by_user_id,
        updated_by_user_id: r.updated_by_user_id,
        project_id,
        parent_id: newParent,
        type: r.type,
        title: r.title,
        content: r.content,
        metadata: r.metadata,
        sibling_index: 0,
        created_at_ms: t,
        updated_at_ms: t,
        deleted: null,
      });
      await reconcileNoteEdges(tx, nid, r.content);
    }

    for (let i = 0; i < newOrderAtP.length; i++) {
      const nid = newOrderAtP[i]!;
      await tx
        .update(wpnNotes)
        .set({ parent_id: P, sibling_index: i, updated_at_ms: t })
        .where(
          and(
            eq(wpnNotes.id, nid),
            eq(wpnNotes.userId, userId),
            eq(wpnNotes.project_id, project_id),
          ),
        );
    }

    for (const oid of ordered) {
      const childDocs = (cmBefore.get(oid) ?? []).filter((doc) => subtreeIds.has(doc.id));
      if (childDocs.length === 0) continue;
      const newPid = idMap.get(oid)!;
      const newKidOrder = childDocs.map((doc) => idMap.get(doc.id)!);
      for (let i = 0; i < newKidOrder.length; i++) {
        const nid = newKidOrder[i]!;
        await tx
          .update(wpnNotes)
          .set({ parent_id: newPid, sibling_index: i, updated_at_ms: t })
          .where(
            and(
              eq(wpnNotes.id, nid),
              eq(wpnNotes.userId, userId),
              eq(wpnNotes.project_id, project_id),
            ),
          );
      }
    }

    return { newRootId };
  });
}

export async function pgWpnDuplicateProject(
  userId: string,
  sourceProjectId: string,
  opts: {
    targetWorkspaceId: string;
    newName?: string;
    creatorUserId: string;
  },
): Promise<{ project_id: string; name: string }> {
  return withTx(async (tx) => {
    const srcRows = await tx
      .select()
      .from(wpnProjects)
      .where(
        and(eq(wpnProjects.id, sourceProjectId), eq(wpnProjects.userId, userId)),
      )
      .limit(1);
    const srcProject = srcRows[0];
    if (!srcProject) throw new Error("Project not found");
    const targetWsRows = await tx
      .select()
      .from(wpnWorkspaces)
      .where(
        and(
          eq(wpnWorkspaces.id, opts.targetWorkspaceId),
          eq(wpnWorkspaces.userId, userId),
        ),
      )
      .limit(1);
    const targetWs = targetWsRows[0];
    if (!targetWs) throw new Error("Target workspace not found");
    const baseName = (opts.newName ?? "").trim() || srcProject.name;
    const t = nowMs();
    const lastP = await tx
      .select({ s: wpnProjects.sort_index })
      .from(wpnProjects)
      .where(
        and(
          eq(wpnProjects.userId, userId),
          eq(wpnProjects.workspace_id, opts.targetWorkspaceId),
        ),
      )
      .orderBy(desc(wpnProjects.sort_index))
      .limit(1);
    const maxSort = lastP[0]?.s ?? -1;
    const newProjectId = newId();
    const newProj = {
      id: newProjectId,
      userId,
      orgId: targetWs.orgId,
      spaceId: targetWs.spaceId,
      visibility: srcProject.visibility ?? "public",
      creatorUserId: opts.creatorUserId,
      workspace_id: opts.targetWorkspaceId,
      name: baseName,
      sort_index: maxSort + 1,
      color_token: srcProject.color_token ?? null,
      created_at_ms: t,
      updated_at_ms: t,
      settings:
        srcProject.settings && typeof srcProject.settings === "object"
          ? { ...(srcProject.settings as Record<string, unknown>) }
          : ({} as Record<string, unknown>),
    };
    await tx.insert(wpnProjects).values(newProj);

    const srcNotes = (await tx
      .select()
      .from(wpnNotes)
      .where(
        and(eq(wpnNotes.userId, userId), eq(wpnNotes.project_id, sourceProjectId)),
      )) as NoteRow[];
    const active = srcNotes.filter((r) => r.deleted !== true);
    if (active.length === 0) return { project_id: newProjectId, name: baseName };
    const idMap = new Map<string, string>();
    for (const n of active) idMap.set(n.id, newId());
    const editor = opts.creatorUserId;
    for (const n of active) {
      const newNoteId = idMap.get(n.id)!;
      const newParent = n.parent_id === null ? null : idMap.get(n.parent_id) ?? null;
      await tx.insert(wpnNotes).values({
        id: newNoteId,
        userId,
        orgId: targetWs.orgId,
        spaceId: targetWs.spaceId,
        created_by_user_id: editor,
        updated_by_user_id: editor,
        project_id: newProjectId,
        parent_id: newParent,
        type: n.type,
        title: n.title,
        content: n.content,
        metadata: n.metadata,
        sibling_index: n.sibling_index,
        created_at_ms: t,
        updated_at_ms: t,
        deleted: null,
      });
      await reconcileNoteEdges(tx, newNoteId, n.content);
    }

    return { project_id: newProjectId, name: baseName };
  });
}

export async function pgWpnDuplicateWorkspace(
  userId: string,
  sourceWorkspaceId: string,
  opts: {
    targetSpaceId?: string;
    newName?: string;
    creatorUserId: string;
  },
): Promise<{
  workspace_id: string;
  name: string;
  projects: { project_id: string; name: string; sourceProjectId: string }[];
}> {
  // Outer tx — duplicateProject is invoked sequentially under the same
  // connection. Drizzle does not support nested transactions out of the box,
  // so we open one tx and reuse it via savepoints. For simplicity we run the
  // duplicate-workspace as a single tx that calls into helpers using
  // withTx-equivalent inline blocks.
  return withTx(async (tx) => {
    const srcRows = await tx
      .select()
      .from(wpnWorkspaces)
      .where(
        and(
          eq(wpnWorkspaces.id, sourceWorkspaceId),
          eq(wpnWorkspaces.userId, userId),
        ),
      )
      .limit(1);
    const srcWs = srcRows[0];
    if (!srcWs) throw new Error("Workspace not found");
    const targetSpaceId = opts.targetSpaceId ?? srcWs.spaceId;
    const t = nowMs();
    const lastWs = await tx
      .select({ s: wpnWorkspaces.sort_index })
      .from(wpnWorkspaces)
      .where(eq(wpnWorkspaces.userId, userId))
      .orderBy(desc(wpnWorkspaces.sort_index))
      .limit(1);
    const maxSort = lastWs[0]?.s ?? -1;
    const newWsId = newId();
    const baseName = (opts.newName ?? "").trim() || srcWs.name;
    await tx.insert(wpnWorkspaces).values({
      id: newWsId,
      userId,
      orgId: srcWs.orgId,
      spaceId: targetSpaceId,
      visibility: srcWs.visibility ?? "public",
      creatorUserId: opts.creatorUserId,
      name: baseName,
      sort_index: maxSort + 1,
      color_token: srcWs.color_token ?? null,
      created_at_ms: t,
      updated_at_ms: t,
      settings:
        srcWs.settings && typeof srcWs.settings === "object"
          ? { ...(srcWs.settings as Record<string, unknown>) }
          : ({} as Record<string, unknown>),
    });

    const srcProjects = await tx
      .select()
      .from(wpnProjects)
      .where(
        and(eq(wpnProjects.userId, userId), eq(wpnProjects.workspace_id, sourceWorkspaceId)),
      )
      .orderBy(asc(wpnProjects.sort_index));
    const projectMap: { project_id: string; name: string; sourceProjectId: string }[] = [];
    for (const p of srcProjects) {
      // Inline duplicate-project with the new workspace id, reusing tx.
      const tInner = nowMs();
      const lastP = await tx
        .select({ s: wpnProjects.sort_index })
        .from(wpnProjects)
        .where(
          and(eq(wpnProjects.userId, userId), eq(wpnProjects.workspace_id, newWsId)),
        )
        .orderBy(desc(wpnProjects.sort_index))
        .limit(1);
      const maxProjSort = lastP[0]?.s ?? -1;
      const newProjId = newId();
      await tx.insert(wpnProjects).values({
        id: newProjId,
        userId,
        orgId: srcWs.orgId,
        spaceId: targetSpaceId,
        visibility: p.visibility ?? "public",
        creatorUserId: opts.creatorUserId,
        workspace_id: newWsId,
        name: p.name,
        sort_index: maxProjSort + 1,
        color_token: p.color_token ?? null,
        created_at_ms: tInner,
        updated_at_ms: tInner,
        settings:
          p.settings && typeof p.settings === "object"
            ? { ...(p.settings as Record<string, unknown>) }
            : ({} as Record<string, unknown>),
      });
      const srcNotes = (await tx
        .select()
        .from(wpnNotes)
        .where(and(eq(wpnNotes.userId, userId), eq(wpnNotes.project_id, p.id)))) as NoteRow[];
      const active = srcNotes.filter((r) => r.deleted !== true);
      if (active.length > 0) {
        const idMap = new Map<string, string>();
        for (const n of active) idMap.set(n.id, newId());
        for (const n of active) {
          const newNoteId = idMap.get(n.id)!;
          const newParent = n.parent_id === null ? null : idMap.get(n.parent_id) ?? null;
          await tx.insert(wpnNotes).values({
            id: newNoteId,
            userId,
            orgId: srcWs.orgId,
            spaceId: targetSpaceId,
            created_by_user_id: opts.creatorUserId,
            updated_by_user_id: opts.creatorUserId,
            project_id: newProjId,
            parent_id: newParent,
            type: n.type,
            title: n.title,
            content: n.content,
            metadata: n.metadata,
            sibling_index: n.sibling_index,
            created_at_ms: tInner,
            updated_at_ms: tInner,
            deleted: null,
          });
          await reconcileNoteEdges(tx, newNoteId, n.content);
        }
      }
      projectMap.push({ project_id: newProjId, name: p.name, sourceProjectId: p.id });
    }
    return { workspace_id: newWsId, name: baseName, projects: projectMap };
  });
}

// ---------- explorer state + settings ----------

export async function pgWpnSetExplorerExpanded(
  userId: string,
  project_id: string,
  expanded_idsRaw: string[],
): Promise<void> {
  const expanded = [...new Set(expanded_idsRaw)];
  await getDb()
    .insert(wpnExplorerState)
    .values({ userId, project_id, expanded_ids: expanded })
    .onConflictDoUpdate({
      target: [wpnExplorerState.userId, wpnExplorerState.project_id],
      set: { expanded_ids: expanded },
    });
}

export async function pgWpnGetWorkspaceSettings(
  userId: string,
  workspace_id: string,
): Promise<Record<string, unknown>> {
  const rows = await getDb()
    .select({ settings: wpnWorkspaces.settings })
    .from(wpnWorkspaces)
    .where(and(eq(wpnWorkspaces.id, workspace_id), eq(wpnWorkspaces.userId, userId)))
    .limit(1);
  const s = rows[0]?.settings;
  return s && typeof s === "object" && !Array.isArray(s)
    ? { ...(s as Record<string, unknown>) }
    : {};
}

export async function pgWpnPatchWorkspaceSettings(
  userId: string,
  workspace_id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withTx(async (tx) => {
    const wsRows = await tx
      .select()
      .from(wpnWorkspaces)
      .where(
        and(eq(wpnWorkspaces.id, workspace_id), eq(wpnWorkspaces.userId, userId)),
      )
      .limit(1);
    if (wsRows.length === 0) throw new Error("Workspace not found");
    const cur = wsRows[0]!.settings;
    const curObj =
      cur && typeof cur === "object" && !Array.isArray(cur)
        ? (cur as Record<string, unknown>)
        : {};
    const next = { ...curObj, ...patch };
    await tx
      .update(wpnWorkspaces)
      .set({ settings: next, updated_at_ms: nowMs() })
      .where(and(eq(wpnWorkspaces.id, workspace_id), eq(wpnWorkspaces.userId, userId)));
    return next;
  });
}

export async function pgWpnGetProjectSettings(
  userId: string,
  project_id: string,
): Promise<Record<string, unknown>> {
  const rows = await getDb()
    .select({ settings: wpnProjects.settings })
    .from(wpnProjects)
    .where(and(eq(wpnProjects.id, project_id), eq(wpnProjects.userId, userId)))
    .limit(1);
  const s = rows[0]?.settings;
  return s && typeof s === "object" && !Array.isArray(s)
    ? { ...(s as Record<string, unknown>) }
    : {};
}

export async function pgWpnPatchProjectSettings(
  userId: string,
  project_id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withTx(async (tx) => {
    const pRows = await tx
      .select()
      .from(wpnProjects)
      .where(and(eq(wpnProjects.id, project_id), eq(wpnProjects.userId, userId)))
      .limit(1);
    if (pRows.length === 0) throw new Error("Project not found");
    const cur = pRows[0]!.settings;
    const curObj =
      cur && typeof cur === "object" && !Array.isArray(cur)
        ? (cur as Record<string, unknown>)
        : {};
    const next = { ...curObj, ...patch };
    await tx
      .update(wpnProjects)
      .set({ settings: next, updated_at_ms: nowMs() })
      .where(and(eq(wpnProjects.id, project_id), eq(wpnProjects.userId, userId)));
    return next;
  });
}
