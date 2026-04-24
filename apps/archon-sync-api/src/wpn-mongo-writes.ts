import * as crypto from "node:crypto";
import type { WpnNoteDoc, WpnProjectDoc, WpnWorkspaceDoc } from "./db.js";
import {
  getWpnExplorerStateCollection,
  getWpnNotesCollection,
  getWpnProjectsCollection,
  getWpnWorkspacesCollection,
} from "./db.js";
import {
  type NoteMovePlacement,
  type WpnNoteRowLite,
  wpnComputeChildMapAfterMove,
} from "./wpn-tree.js";

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  return crypto.randomUUID();
}

function normalizeNoteType(t: string): string {
  return String(t || "markdown").trim().toLowerCase() || "markdown";
}

/** Same string returned in JSON `{ error }` for PATCH title conflicts (cloud + local WPN). */
export const WPN_DUPLICATE_NOTE_TITLE_MESSAGE =
  "Note title already exists. Try a different title.";

export class WpnDuplicateSiblingTitleError extends Error {
  constructor() {
    super(WPN_DUPLICATE_NOTE_TITLE_MESSAGE);
    this.name = "WpnDuplicateSiblingTitleError";
  }
}

function childrenMapFromDocs(rows: WpnNoteDoc[]): Map<string | null, WpnNoteDoc[]> {
  const active = rows.filter((r) => r.deleted !== true);
  const m = new Map<string | null, WpnNoteDoc[]>();
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

function toRowLite(rows: WpnNoteDoc[]): WpnNoteRowLite[] {
  return rows
    .filter((r) => r.deleted !== true)
    .map((r) => ({ id: r.id, parent_id: r.parent_id, sibling_index: r.sibling_index }));
}

async function persistChildMap(
  userId: string,
  projectId: string,
  childMap: Map<string | null, string[]>,
): Promise<void> {
  const noteCol = getWpnNotesCollection();
  const t = nowMs();
  const walk = async (parentId: string | null, ids: string[]): Promise<void> => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      await noteCol.updateOne(
        { id, userId, project_id: projectId },
        { $set: { parent_id: parentId, sibling_index: i, updated_at_ms: t } },
      );
      await walk(id, childMap.get(id) ?? []);
    }
  };
  await walk(null, childMap.get(null) ?? []);
}

export async function mongoWpnCreateWorkspace(
  userId: string,
  name: string,
  scope?: { orgId?: string; spaceId?: string; creatorUserId?: string },
): Promise<Omit<WpnWorkspaceDoc, "userId" | "settings">> {
  const col = getWpnWorkspacesCollection();
  const t = nowMs();
  const lastWs = await col.find({ userId }).sort({ sort_index: -1 }).limit(1).toArray();
  const maxSort = lastWs[0]?.sort_index ?? -1;
  const sort_index = maxSort + 1;
  const id = newId();
  const doc: WpnWorkspaceDoc = {
    id,
    userId,
    ...(scope?.orgId ? { orgId: scope.orgId } : {}),
    ...(scope?.spaceId ? { spaceId: scope.spaceId } : {}),
    visibility: "public",
    creatorUserId: scope?.creatorUserId ?? userId,
    name: name.trim() || "Workspace",
    sort_index,
    color_token: null,
    created_at_ms: t,
    updated_at_ms: t,
    settings: {},
  };
  await col.insertOne(doc);
  const { userId: _u, settings: _s, ...pub } = doc;
  return pub;
}

export async function mongoWpnUpdateWorkspace(
  userId: string,
  id: string,
  patch: { name?: string; sort_index?: number; color_token?: string | null },
): Promise<Omit<WpnWorkspaceDoc, "userId" | "settings"> | null> {
  const col = getWpnWorkspacesCollection();
  const cur = await col.findOne({ id, userId });
  if (!cur) {
    return null;
  }
  const name =
    patch.name !== undefined ? patch.name.trim() || cur.name : cur.name;
  const sort_index =
    patch.sort_index !== undefined ? patch.sort_index : cur.sort_index;
  const color_token =
    patch.color_token !== undefined ? patch.color_token : cur.color_token;
  const updated_at_ms = nowMs();
  await col.updateOne(
    { id, userId },
    { $set: { name, sort_index, color_token, updated_at_ms } },
  );
  const next = await col.findOne({ id, userId });
  if (!next) {
    return null;
  }
  const { userId: _u, settings: _s, ...pub } = next;
  return pub;
}

/**
 * Reparent a workspace to a different space by cascading `spaceId` across the
 * workspace doc and every descendant (projects, notes, explorer state). Does
 * not transact — a crash mid-sweep leaves a partial move that re-running this
 * helper (or a subsequent move) converges. Idempotent: re-applying the same
 * target is a no-op. Returns the refreshed workspace public shape or null if
 * the workspace doc was not found.
 */
export async function mongoWpnReassignWorkspaceSpace(
  workspaceId: string,
  targetSpaceId: string,
): Promise<Omit<WpnWorkspaceDoc, "userId" | "settings"> | null> {
  const wsCol = getWpnWorkspacesCollection();
  const projCol = getWpnProjectsCollection();
  const noteCol = getWpnNotesCollection();
  const exCol = getWpnExplorerStateCollection();

  const ws = await wsCol.findOne({ id: workspaceId });
  if (!ws) {
    return null;
  }
  const ts = nowMs();
  await wsCol.updateOne(
    { id: workspaceId },
    { $set: { spaceId: targetSpaceId, updated_at_ms: ts } },
  );
  const projIds = (
    await projCol
      .find({ workspace_id: workspaceId }, { projection: { id: 1 } })
      .toArray()
  ).map((p) => p.id);
  await projCol.updateMany(
    { workspace_id: workspaceId },
    { $set: { spaceId: targetSpaceId, updated_at_ms: ts } },
  );
  if (projIds.length > 0) {
    await noteCol.updateMany(
      { project_id: { $in: projIds } },
      { $set: { spaceId: targetSpaceId } },
    );
    await exCol.updateMany(
      { project_id: { $in: projIds } },
      { $set: { spaceId: targetSpaceId } },
    );
  }
  const next = await wsCol.findOne({ id: workspaceId });
  if (!next) {
    return null;
  }
  const { userId: _u, settings: _s, ...pub } = next;
  return pub;
}

export async function mongoWpnDeleteWorkspace(userId: string, id: string): Promise<boolean> {
  const wsCol = getWpnWorkspacesCollection();
  const owned = await wsCol.findOne({ id, userId });
  if (!owned) {
    return false;
  }
  const projCol = getWpnProjectsCollection();
  const noteCol = getWpnNotesCollection();
  const exCol = getWpnExplorerStateCollection();
  const projects = await projCol.find({ userId, workspace_id: id }).toArray();
  for (const p of projects) {
    await noteCol.deleteMany({ userId, project_id: p.id });
    await exCol.deleteOne({ userId, project_id: p.id });
  }
  await projCol.deleteMany({ userId, workspace_id: id });
  await wsCol.deleteOne({ id, userId });
  return true;
}

/**
 * Bulk delete: removes every workspace in `ids` that `userId` actually owns,
 * along with its projects, notes, and explorer state, in one $in sweep per
 * collection. Callers are expected to have filtered `ids` to those the caller
 * has write permission for (see route handler).
 */
export async function mongoWpnDeleteWorkspaces(
  userId: string,
  ids: string[],
): Promise<{ deletedWorkspaceIds: string[] }> {
  if (ids.length === 0) {
    return { deletedWorkspaceIds: [] };
  }
  const wsCol = getWpnWorkspacesCollection();
  const projCol = getWpnProjectsCollection();
  const noteCol = getWpnNotesCollection();
  const exCol = getWpnExplorerStateCollection();

  const ownedWorkspaces = await wsCol.find({ userId, id: { $in: ids } }).toArray();
  const ownedIds = ownedWorkspaces.map((w) => w.id);
  if (ownedIds.length === 0) {
    return { deletedWorkspaceIds: [] };
  }
  const projects = await projCol
    .find({ userId, workspace_id: { $in: ownedIds } })
    .toArray();
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length > 0) {
    await noteCol.deleteMany({ userId, project_id: { $in: projectIds } });
    await exCol.deleteMany({ userId, project_id: { $in: projectIds } });
  }
  await projCol.deleteMany({ userId, workspace_id: { $in: ownedIds } });
  await wsCol.deleteMany({ userId, id: { $in: ownedIds } });
  return { deletedWorkspaceIds: ownedIds };
}

export async function mongoWpnCreateProject(
  userId: string,
  workspaceId: string,
  name: string,
  opts?: { creatorUserId?: string },
): Promise<Omit<WpnProjectDoc, "userId" | "settings"> | null> {
  const wsCol = getWpnWorkspacesCollection();
  const ws = await wsCol.findOne({ id: workspaceId, userId });
  if (!ws) {
    return null;
  }
  const col = getWpnProjectsCollection();
  const t = nowMs();
  const lastP = await col
    .find({ userId, workspace_id: workspaceId })
    .sort({ sort_index: -1 })
    .limit(1)
    .toArray();
  const maxSort = lastP[0]?.sort_index ?? -1;
  const sort_index = maxSort + 1;
  const id = newId();
  const doc: WpnProjectDoc = {
    id,
    userId,
    ...(ws.orgId ? { orgId: ws.orgId } : {}),
    ...(ws.spaceId ? { spaceId: ws.spaceId } : {}),
    visibility: "public",
    creatorUserId: opts?.creatorUserId ?? userId,
    workspace_id: workspaceId,
    name: name.trim() || "Project",
    sort_index,
    color_token: null,
    created_at_ms: t,
    updated_at_ms: t,
    settings: {},
  };
  await col.insertOne(doc);
  const { userId: _u, settings: _s, ...pub } = doc;
  return pub;
}

export async function mongoWpnUpdateProject(
  userId: string,
  id: string,
  patch: {
    name?: string;
    sort_index?: number;
    color_token?: string | null;
    workspace_id?: string;
  },
): Promise<Omit<WpnProjectDoc, "userId" | "settings"> | null> {
  const col = getWpnProjectsCollection();
  const cur = await col.findOne({ id, userId });
  if (!cur) {
    return null;
  }
  if (patch.workspace_id !== undefined) {
    const wsCol = getWpnWorkspacesCollection();
    const ws = await wsCol.findOne({ id: patch.workspace_id, userId });
    if (!ws) {
      return null;
    }
  }
  const name = patch.name !== undefined ? patch.name.trim() || cur.name : cur.name;
  const sort_index =
    patch.sort_index !== undefined ? patch.sort_index : cur.sort_index;
  const color_token =
    patch.color_token !== undefined ? patch.color_token : cur.color_token;
  const workspace_id =
    patch.workspace_id !== undefined ? patch.workspace_id : cur.workspace_id;
  const updated_at_ms = nowMs();
  await col.updateOne(
    { id, userId },
    { $set: { name, sort_index, color_token, workspace_id, updated_at_ms } },
  );
  const next = await col.findOne({ id, userId });
  if (!next) {
    return null;
  }
  const { userId: _u, settings: _s, ...pub } = next;
  return pub;
}

/**
 * Bulk delete: removes every project in `ids` that `userId` actually owns,
 * along with its notes and explorer state. Callers must have filtered `ids`
 * to those the caller has write permission for.
 */
export async function mongoWpnDeleteProjects(
  userId: string,
  ids: string[],
): Promise<{ deletedProjectIds: string[] }> {
  if (ids.length === 0) {
    return { deletedProjectIds: [] };
  }
  const projCol = getWpnProjectsCollection();
  const noteCol = getWpnNotesCollection();
  const exCol = getWpnExplorerStateCollection();
  const owned = await projCol.find({ userId, id: { $in: ids } }).toArray();
  const ownedIds = owned.map((p) => p.id);
  if (ownedIds.length === 0) {
    return { deletedProjectIds: [] };
  }
  await noteCol.deleteMany({ userId, project_id: { $in: ownedIds } });
  await exCol.deleteMany({ userId, project_id: { $in: ownedIds } });
  await projCol.deleteMany({ userId, id: { $in: ownedIds } });
  return { deletedProjectIds: ownedIds };
}

export async function mongoWpnDeleteProject(userId: string, id: string): Promise<boolean> {
  const projCol = getWpnProjectsCollection();
  const p = await projCol.findOne({ id, userId });
  if (!p) {
    return false;
  }
  const noteCol = getWpnNotesCollection();
  const exCol = getWpnExplorerStateCollection();
  await noteCol.deleteMany({ userId, project_id: id });
  await exCol.deleteOne({ userId, project_id: id });
  await projCol.deleteOne({ id, userId });
  return true;
}

export async function mongoWpnCreateNote(
  userId: string,
  projectId: string,
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
  const projCol = getWpnProjectsCollection();
  const project = await projCol.findOne({ id: projectId, userId });
  if (!project) {
    throw new Error("Project not found");
  }
  const noteCol = getWpnNotesCollection();
  const rawRows = await noteCol.find({ userId, project_id: projectId }).toArray();
  const cm = childrenMapFromDocs(rawRows);
  const id = newId();
  const t = nowMs();
  const title = (payload.title ?? "").trim() || "Untitled";
  const content = payload.content ?? "";
  const metadata =
    payload.metadata && Object.keys(payload.metadata).length > 0 ? payload.metadata : null;
  const type = normalizeNoteType(payload.type);
  const scopeFields: {
    orgId?: string;
    spaceId?: string;
    created_by_user_id?: string;
    updated_by_user_id?: string;
  } = {};
  if (project.orgId) {
    scopeFields.orgId = project.orgId;
  }
  if (project.spaceId) {
    scopeFields.spaceId = project.spaceId;
  }
  const editorId = authorship?.editorUserId ?? userId;
  scopeFields.created_by_user_id = editorId;
  scopeFields.updated_by_user_id = editorId;

  let parent_id: string | null = null;
  let sibling_index = 0;

  if (payload.relation === "root") {
    const roots = cm.get(null) ?? [];
    sibling_index =
      roots.length === 0 ? 0 : Math.max(...roots.map((r) => r.sibling_index)) + 1;
    await noteCol.insertOne({
      id,
      userId,
      ...scopeFields,
      project_id: projectId,
      parent_id,
      type,
      title,
      content,
      metadata,
      sibling_index,
      created_at_ms: t,
      updated_at_ms: t,
    });
    return { id };
  }

  if (!payload.anchorId) {
    throw new Error("anchorId required for child/sibling");
  }
  const anchor = rawRows.find((r) => r.id === payload.anchorId && r.deleted !== true);
  if (!anchor) {
    throw new Error("Anchor note not found");
  }

  if (payload.relation === "child") {
    parent_id = anchor.id;
    const kids = rawRows.filter((r) => r.parent_id === anchor.id && r.deleted !== true);
    sibling_index =
      kids.length === 0 ? 0 : Math.max(...kids.map((r) => r.sibling_index)) + 1;
    await noteCol.insertOne({
      id,
      userId,
      ...scopeFields,
      project_id: projectId,
      parent_id,
      type,
      title,
      content,
      metadata,
      sibling_index,
      created_at_ms: t,
      updated_at_ms: t,
    });
    return { id };
  }

  parent_id = anchor.parent_id;
  const sibs = rawRows
    .filter((r) => r.parent_id === parent_id && r.deleted !== true)
    .sort((a, b) => a.sibling_index - b.sibling_index);
  const ai = sibs.findIndex((x) => x.id === payload.anchorId);
  if (ai < 0) {
    throw new Error("Invalid anchor");
  }
  const orderedIds = [
    ...sibs.slice(0, ai + 1).map((r) => r.id),
    id,
    ...sibs.slice(ai + 1).map((r) => r.id),
  ];
  await noteCol.insertOne({
    id,
    userId,
    ...scopeFields,
    project_id: projectId,
    parent_id,
    type,
    title,
    content,
    metadata,
    sibling_index: 0,
    created_at_ms: t,
    updated_at_ms: t,
  });
  for (let i = 0; i < orderedIds.length; i++) {
    await noteCol.updateOne(
      { id: orderedIds[i], userId, project_id: projectId },
      { $set: { sibling_index: i, parent_id, updated_at_ms: t } },
    );
  }
  return { id };
}

export async function mongoWpnUpdateNote(
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
  const noteCol = getWpnNotesCollection();
  const n = await noteCol.findOne({ id: noteId, userId, deleted: { $ne: true } });
  if (!n) {
    return null;
  }
  const projCol = getWpnProjectsCollection();
  const p = await projCol.findOne({ id: n.project_id, userId });
  if (!p) {
    return null;
  }
  const wsCol = getWpnWorkspacesCollection();
  if (!(await wsCol.findOne({ id: p.workspace_id, userId }))) {
    return null;
  }

  const title =
    patch.title !== undefined ? patch.title.trim() || n.title : n.title;
  const content = patch.content !== undefined ? patch.content : n.content;
  const type =
    patch.type !== undefined ? normalizeNoteType(patch.type) : n.type;
  let metadata: Record<string, unknown> | null = n.metadata;
  if (patch.metadata !== undefined) {
    metadata =
      patch.metadata && Object.keys(patch.metadata).length > 0
        ? patch.metadata
        : null;
  }
  if (patch.title !== undefined && title !== n.title) {
    const clash = await noteCol.findOne({
      userId,
      project_id: n.project_id,
      parent_id: n.parent_id,
      title,
      id: { $ne: noteId },
      deleted: { $ne: true },
    });
    if (clash) {
      throw new WpnDuplicateSiblingTitleError();
    }
  }
  const updated_at_ms = nowMs();
  const setFields: Record<string, unknown> = {
    title,
    content,
    type,
    metadata,
    updated_at_ms,
  };
  if (authorship?.editorUserId) {
    setFields.updated_by_user_id = authorship.editorUserId;
  }
  await noteCol.updateOne({ id: noteId, userId }, { $set: setFields });
  const cur = await noteCol.findOne({ id: noteId, userId });
  if (!cur) {
    return null;
  }
  return {
    id: cur.id,
    project_id: cur.project_id,
    parent_id: cur.parent_id,
    type: cur.type,
    title: cur.title,
    content: cur.content,
    metadata: cur.metadata ?? undefined,
    sibling_index: cur.sibling_index,
    created_at_ms: cur.created_at_ms,
    updated_at_ms: cur.updated_at_ms,
  };
}

export async function mongoWpnDeleteNotes(userId: string, ids: string[]): Promise<void> {
  const noteCol = getWpnNotesCollection();
  const unique = [...new Set(ids)];
  for (const noteId of unique) {
    await noteCol.deleteOne({ id: noteId, userId });
  }
}

export async function mongoWpnMoveNote(
  userId: string,
  projectId: string,
  draggedId: string,
  targetId: string,
  placement: NoteMovePlacement,
): Promise<void> {
  const projCol = getWpnProjectsCollection();
  if (!(await projCol.findOne({ id: projectId, userId }))) {
    throw new Error("Project not found");
  }
  const noteCol = getWpnNotesCollection();
  const rawRows = await noteCol.find({ userId, project_id: projectId }).toArray();
  const active = rawRows.filter((r) => r.deleted !== true);
  const lites = toRowLite(active);
  const childMap = wpnComputeChildMapAfterMove(lites, draggedId, targetId, placement);
  await persistChildMap(userId, projectId, childMap);
}

/**
 * Cross-project move: relocate a note subtree to a different project, optionally
 * nesting under `targetParentId` (or root-level when null). Updates `project_id`,
 * `orgId`, `spaceId` for every node in the subtree so scope filters continue to
 * match, reindexes siblings on the source side, and appends the moved root as
 * the last child of `targetParentId` on the destination side.
 */
export async function mongoWpnMoveNoteToProject(
  userId: string,
  sourceNoteId: string,
  targetProjectId: string,
  targetParentId: string | null,
): Promise<void> {
  const noteCol = getWpnNotesCollection();
  const projCol = getWpnProjectsCollection();
  const source = await noteCol.findOne({ id: sourceNoteId, userId });
  if (!source || source.deleted === true) {
    throw new Error("Note not found");
  }
  const sourceProjectId = source.project_id;
  if (sourceProjectId === targetProjectId && (source.parent_id ?? null) === (targetParentId ?? null)) {
    return; // no-op
  }
  const targetProject = await projCol.findOne({ id: targetProjectId, userId });
  if (!targetProject) {
    throw new Error("Target project not found");
  }
  if (targetParentId) {
    const parent = await noteCol.findOne({
      id: targetParentId,
      userId,
      project_id: targetProjectId,
    });
    if (!parent || parent.deleted === true) {
      throw new Error("Target parent note not found in target project");
    }
  }

  // Subtree collection (in source project).
  const sourceRows = await noteCol
    .find({ userId, project_id: sourceProjectId })
    .toArray();
  const subtreeIds = collectSubtreePreorder(
    sourceRows.filter((r) => r.deleted !== true),
    sourceNoteId,
  );

  // Guard against moving a subtree into its own descendant (only possible when
  // source == target project; cross-project always safe).
  if (sourceProjectId === targetProjectId && targetParentId && subtreeIds.includes(targetParentId)) {
    throw new Error("Cannot move a note into its own descendant");
  }

  // New root position: last child of target parent.
  const targetSiblings = await noteCol
    .find({
      userId,
      project_id: targetProjectId,
      parent_id: targetParentId,
      deleted: { $ne: true },
    })
    .toArray();
  const maxIdx = targetSiblings.reduce(
    (m, r) => (r.sibling_index > m ? r.sibling_index : m),
    -1,
  );
  const newRootIdx = maxIdx + 1;

  const t = nowMs();

  const setScope: { project_id: string; orgId?: string; spaceId?: string; updated_at_ms: number } = {
    project_id: targetProjectId,
    updated_at_ms: t,
  };
  if (targetProject.orgId) {
    setScope.orgId = targetProject.orgId;
  }
  if (targetProject.spaceId) {
    setScope.spaceId = targetProject.spaceId;
  }
  await noteCol.updateMany(
    { userId, id: { $in: subtreeIds } },
    { $set: setScope },
  );

  await noteCol.updateOne(
    { userId, id: sourceNoteId },
    {
      $set: {
        parent_id: targetParentId,
        sibling_index: newRootIdx,
        updated_at_ms: t,
      },
    },
  );

  // Reindex source-side siblings (root has been moved out).
  const sourceParent = source.parent_id ?? null;
  const sourceSiblings = await noteCol
    .find({
      userId,
      project_id: sourceProjectId,
      parent_id: sourceParent,
      deleted: { $ne: true },
    })
    .sort({ sibling_index: 1 })
    .toArray();
  for (let i = 0; i < sourceSiblings.length; i++) {
    const s = sourceSiblings[i]!;
    if (s.sibling_index !== i) {
      await noteCol.updateOne(
        { _id: s._id },
        { $set: { sibling_index: i, updated_at_ms: t } },
      );
    }
  }
}

function collectSubtreePreorder(rows: WpnNoteDoc[], rootId: string): string[] {
  const cm = childrenMapFromDocs(rows);
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

export async function mongoWpnDuplicateSubtree(
  userId: string,
  projectId: string,
  rootNoteId: string,
): Promise<{ newRootId: string }> {
  const projCol = getWpnProjectsCollection();
  const project = await projCol.findOne({ id: projectId, userId });
  if (!project) {
    throw new Error("Project not found");
  }
  const dupScopeFields: { orgId?: string; spaceId?: string } = {};
  if (project.orgId) {
    dupScopeFields.orgId = project.orgId;
  }
  if (project.spaceId) {
    dupScopeFields.spaceId = project.spaceId;
  }
  const noteCol = getWpnNotesCollection();
  const rawRows = await noteCol.find({ userId, project_id: projectId }).toArray();
  const active = rawRows.filter((r) => r.deleted !== true);
  const rowMap = new Map(active.map((r) => [r.id, r]));
  const rootRow = rowMap.get(rootNoteId);
  if (!rootRow) {
    throw new Error("Note not found");
  }
  const ordered = collectSubtreePreorder(active, rootNoteId);
  const subtreeIds = new Set(ordered);
  const idMap = new Map<string, string>();
  for (const oid of ordered) {
    idMap.set(oid, newId());
  }
  const newRootId = idMap.get(rootNoteId)!;
  const P = rootRow.parent_id;
  const cmBefore = childrenMapFromDocs(active);
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
    await noteCol.insertOne({
      id: nid,
      userId,
      ...dupScopeFields,
      project_id: projectId,
      parent_id: newParent,
      type: r.type,
      title: r.title,
      content: r.content,
      metadata: r.metadata,
      sibling_index: 0,
      created_at_ms: t,
      updated_at_ms: t,
    });
  }

  for (let i = 0; i < newOrderAtP.length; i++) {
    const nid = newOrderAtP[i]!;
    await noteCol.updateOne(
      { id: nid, userId, project_id: projectId },
      { $set: { parent_id: P, sibling_index: i, updated_at_ms: t } },
    );
  }

  for (const oid of ordered) {
    const childDocs = (cmBefore.get(oid) ?? []).filter((doc) =>
      subtreeIds.has(doc.id),
    );
    if (childDocs.length === 0) {
      continue;
    }
    const newPid = idMap.get(oid)!;
    const newKidOrder = childDocs.map((doc) => idMap.get(doc.id)!);
    for (let i = 0; i < newKidOrder.length; i++) {
      const nid = newKidOrder[i]!;
      await noteCol.updateOne(
        { id: nid, userId, project_id: projectId },
        { $set: { parent_id: newPid, sibling_index: i, updated_at_ms: t } },
      );
    }
  }

  return { newRootId };
}

/**
 * Deep-copy a project into `targetWorkspaceId` (may be the same workspace) by
 * creating a fresh project row and fresh note rows that preserve the parent/
 * sibling structure of the source. Every note gets a new uuid; metadata,
 * content, type, and visibility are preserved as-is. The `creatorUserId` on
 * the new project is the caller (not the original creator).
 *
 * The caller is responsible for permission checks and for asserting the
 * target workspace is in the same space/org (see the route).
 *
 * Returns `{ projectId, name }` for the new project.
 */
export async function mongoWpnDuplicateProject(
  userId: string,
  sourceProjectId: string,
  opts: {
    targetWorkspaceId: string;
    newName?: string;
    creatorUserId: string;
  },
): Promise<{ projectId: string; name: string }> {
  const projCol = getWpnProjectsCollection();
  const wsCol = getWpnWorkspacesCollection();
  const noteCol = getWpnNotesCollection();

  const srcProject = await projCol.findOne({ id: sourceProjectId, userId });
  if (!srcProject) {
    throw new Error("Project not found");
  }
  const targetWs = await wsCol.findOne({
    id: opts.targetWorkspaceId,
    userId,
  });
  if (!targetWs) {
    throw new Error("Target workspace not found");
  }

  const baseName = (opts.newName ?? "").trim() || srcProject.name;
  const t = nowMs();
  const lastP = await projCol
    .find({ userId, workspace_id: opts.targetWorkspaceId })
    .sort({ sort_index: -1 })
    .limit(1)
    .toArray();
  const maxSort = lastP[0]?.sort_index ?? -1;
  const sort_index = maxSort + 1;
  const newProjectId = newId();
  const dupScopeFields: { orgId?: string; spaceId?: string } = {};
  if (targetWs.orgId) {
    dupScopeFields.orgId = targetWs.orgId;
  }
  if (targetWs.spaceId) {
    dupScopeFields.spaceId = targetWs.spaceId;
  }

  const newProject: WpnProjectDoc = {
    id: newProjectId,
    userId,
    ...dupScopeFields,
    visibility: srcProject.visibility ?? "public",
    creatorUserId: opts.creatorUserId,
    workspace_id: opts.targetWorkspaceId,
    name: baseName,
    sort_index,
    color_token: srcProject.color_token ?? null,
    created_at_ms: t,
    updated_at_ms: t,
    settings:
      srcProject.settings && typeof srcProject.settings === "object"
        ? { ...srcProject.settings }
        : {},
  };
  await projCol.insertOne(newProject);

  const srcNotes = await noteCol
    .find({ userId, project_id: sourceProjectId })
    .toArray();
  const active = srcNotes.filter((r) => r.deleted !== true);
  if (active.length === 0) {
    return { projectId: newProjectId, name: baseName };
  }
  const idMap = new Map<string, string>();
  for (const n of active) {
    idMap.set(n.id, newId());
  }
  const noteEditor = opts.creatorUserId;
  for (const n of active) {
    const newNoteId = idMap.get(n.id)!;
    const newParent =
      n.parent_id === null
        ? null
        : idMap.get(n.parent_id) ?? null;
    await noteCol.insertOne({
      id: newNoteId,
      userId,
      ...dupScopeFields,
      created_by_user_id: noteEditor,
      updated_by_user_id: noteEditor,
      project_id: newProjectId,
      parent_id: newParent,
      type: n.type,
      title: n.title,
      content: n.content,
      metadata: n.metadata,
      sibling_index: n.sibling_index,
      created_at_ms: t,
      updated_at_ms: t,
    });
  }

  return { projectId: newProjectId, name: baseName };
}

/**
 * Deep-copy a workspace (including every project and every note in each
 * project) into `targetSpaceId` when given, else into the source workspace's
 * space. The caller must have manage rights on the source and (when
 * cross-space) manage on the target space.
 *
 * Returns `{ workspaceId, name, projects: [{ projectId, name }] }` where the
 * projects array maps source projects to their duplicates.
 */
export async function mongoWpnDuplicateWorkspace(
  userId: string,
  sourceWorkspaceId: string,
  opts: {
    targetSpaceId?: string;
    newName?: string;
    creatorUserId: string;
  },
): Promise<{
  workspaceId: string;
  name: string;
  projects: { projectId: string; name: string; sourceProjectId: string }[];
}> {
  const wsCol = getWpnWorkspacesCollection();
  const projCol = getWpnProjectsCollection();

  const srcWs = await wsCol.findOne({ id: sourceWorkspaceId, userId });
  if (!srcWs) {
    throw new Error("Workspace not found");
  }
  const targetSpaceId = opts.targetSpaceId ?? srcWs.spaceId;
  const t = nowMs();
  const lastWs = await wsCol
    .find({ userId })
    .sort({ sort_index: -1 })
    .limit(1)
    .toArray();
  const maxSort = lastWs[0]?.sort_index ?? -1;
  const sort_index = maxSort + 1;
  const newWsId = newId();
  const baseName = (opts.newName ?? "").trim() || srcWs.name;
  const newWs: WpnWorkspaceDoc = {
    id: newWsId,
    userId,
    ...(srcWs.orgId ? { orgId: srcWs.orgId } : {}),
    ...(targetSpaceId ? { spaceId: targetSpaceId } : {}),
    visibility: srcWs.visibility ?? "public",
    creatorUserId: opts.creatorUserId,
    name: baseName,
    sort_index,
    color_token: srcWs.color_token ?? null,
    created_at_ms: t,
    updated_at_ms: t,
    settings:
      srcWs.settings && typeof srcWs.settings === "object"
        ? { ...srcWs.settings }
        : {},
  };
  await wsCol.insertOne(newWs);

  const srcProjects = await projCol
    .find({ userId, workspace_id: sourceWorkspaceId })
    .sort({ sort_index: 1 })
    .toArray();
  const projectMap: {
    projectId: string;
    name: string;
    sourceProjectId: string;
  }[] = [];
  for (const p of srcProjects) {
    const dup = await mongoWpnDuplicateProject(userId, p.id, {
      targetWorkspaceId: newWsId,
      creatorUserId: opts.creatorUserId,
    });
    projectMap.push({
      projectId: dup.projectId,
      name: dup.name,
      sourceProjectId: p.id,
    });
  }
  return { workspaceId: newWsId, name: baseName, projects: projectMap };
}

/**
 * Upsert the caller's explorer-expansion set for a project. Access control
 * lives in the route (see `assertCanReadProject`): explorer state is per-user
 * and scoped by `{ userId, project_id }`, so creator-ownership is not required.
 */
export async function mongoWpnSetExplorerExpanded(
  userId: string,
  projectId: string,
  expandedIds: string[],
): Promise<void> {
  const exCol = getWpnExplorerStateCollection();
  const expanded_ids = [...new Set(expandedIds)];
  await exCol.replaceOne(
    { userId, project_id: projectId },
    { userId, project_id: projectId, expanded_ids },
    { upsert: true },
  );
}

export async function mongoWpnGetWorkspaceSettings(
  userId: string,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const col = getWpnWorkspacesCollection();
  const w = await col.findOne({ id: workspaceId, userId });
  if (!w) {
    return {};
  }
  const s = w.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? { ...s } : {};
}

export async function mongoWpnPatchWorkspaceSettings(
  userId: string,
  workspaceId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const col = getWpnWorkspacesCollection();
  const w = await col.findOne({ id: workspaceId, userId });
  if (!w) {
    throw new Error("Workspace not found");
  }
  const cur = await mongoWpnGetWorkspaceSettings(userId, workspaceId);
  const next = { ...cur, ...patch };
  await col.updateOne({ id: workspaceId, userId }, { $set: { settings: next, updated_at_ms: nowMs() } });
  return next;
}

export async function mongoWpnGetProjectSettings(
  userId: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const col = getWpnProjectsCollection();
  const p = await col.findOne({ id: projectId, userId });
  if (!p) {
    return {};
  }
  const s = p.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? { ...s } : {};
}

export async function mongoWpnPatchProjectSettings(
  userId: string,
  projectId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const col = getWpnProjectsCollection();
  const p = await col.findOne({ id: projectId, userId });
  if (!p) {
    throw new Error("Project not found");
  }
  const cur = await mongoWpnGetProjectSettings(userId, projectId);
  const next = { ...cur, ...patch };
  await col.updateOne({ id: projectId, userId }, { $set: { settings: next, updated_at_ms: nowMs() } });
  return next;
}
