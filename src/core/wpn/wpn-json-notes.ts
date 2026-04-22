import * as crypto from "crypto";
import { normalizeLegacyNoteType } from "../../shared/note-type-legacy";
import type { NoteListItem, NoteMovePlacement } from "../../shared/archon-renderer-api";
import { isWorkspaceMountNoteId } from "../../shared/note-workspace";
import {
  collectReferencedNoteIdsFromMarkdown,
  collectReferencedVfsPathsFromMarkdown,
} from "../../shared/markdown-internal-note-href";
import {
  isSameProjectRelativeVfsPath,
  isTreeRelativeVfsPath,
  resolveSameProjectRelativeVfsToCanonical,
  resolveTreeRelativeVfsPath,
  resolveNoteIdByCanonicalVfsPath,
} from "../../shared/note-vfs-path";
import type {
  WpnBacklinkSourceItem,
  WpnNoteDetail,
  WpnNoteListItem,
  WpnNoteWithContextListItem,
} from "../../shared/wpn-v2-types";
import type { WorkspacePersistedSlot, WorkspaceStore } from "../workspace-store";
import { wpnComputeChildMapAfterMove } from "./wpn-note-move";
import { wpnJsonProjectOwnedBy } from "./wpn-json-service";
import type { WpnNoteRow } from "./wpn-types";

function persist(store: WorkspaceStore): void {
  store.persistDebounced();
}

/** Same `error` string as cloud `PATCH /wpn/notes/:id` on duplicate sibling title. */
export const WPN_LOCAL_DUPLICATE_NOTE_TITLE_MESSAGE =
  "Note title already exists. Try a different title.";

export class WpnJsonDuplicateTitleError extends Error {
  constructor() {
    super(WPN_LOCAL_DUPLICATE_NOTE_TITLE_MESSAGE);
    this.name = "WpnJsonDuplicateTitleError";
  }
}

function findSlotForProject(
  store: WorkspaceStore,
  projectId: string,
): WorkspacePersistedSlot | null {
  for (const slot of store.slots) {
    if (slot.projects.some((p) => p.id === projectId)) {
      return slot;
    }
  }
  return null;
}

function applySiblingOrderJson(
  slot: WorkspacePersistedSlot,
  projectId: string,
  orderedIds: string[],
): void {
  const t = nowMs();
  orderedIds.forEach((nid, i) => {
    const n = slot.notes.find((x) => x.id === nid && x.project_id === projectId);
    if (n) {
      n.sibling_index = i;
      n.updated_at_ms = t;
    }
  });
}

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  return crypto.randomUUID();
}

function parseMetadata(json: string | null): Record<string, unknown> | undefined {
  if (json == null || json === "") {
    return undefined;
  }
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function loadRows(slot: WorkspacePersistedSlot, projectId: string): WpnNoteRow[] {
  return slot.notes
    .filter((r) => r.project_id === projectId)
    .map((r) => ({ ...r, type: normalizeLegacyNoteType(r.type) }));
}

function childrenMapFromRows(rows: WpnNoteRow[]): Map<string | null, WpnNoteRow[]> {
  const m = new Map<string | null, WpnNoteRow[]>();
  for (const r of rows) {
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

function requireWpnJsonProject(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
): WorkspacePersistedSlot {
  if (!wpnJsonProjectOwnedBy(store, ownerId, projectId)) {
    throw new Error("Project not found");
  }
  const slot = findSlotForProject(store, projectId);
  if (!slot) {
    throw new Error("Project not found");
  }
  return slot;
}

export function wpnJsonListNotesFlat(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
): WpnNoteListItem[] {
  const slot = requireWpnJsonProject(store, ownerId, projectId);
  const rows = loadRows(slot, projectId);
  const cm = childrenMapFromRows(rows);
  const out: WpnNoteListItem[] = [];
  const visit = (parentId: string | null, depth: number): void => {
    const kids = cm.get(parentId) ?? [];
    for (const r of kids) {
      out.push({
        id: r.id,
        project_id: r.project_id,
        parent_id: r.parent_id,
        type: r.type,
        title: r.title,
        depth,
        sibling_index: r.sibling_index,
      });
      visit(r.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

export function wpnJsonGetNoteById(
  store: WorkspaceStore,
  ownerId: string,
  noteId: string,
): WpnNoteDetail | null {
  for (const slot of store.slots) {
    const n = slot.notes.find((x) => x.id === noteId);
    if (!n) {
      continue;
    }
    const p = slot.projects.find((x) => x.id === n.project_id);
    if (!p) {
      continue;
    }
    const w = slot.workspaces.find((x) => x.id === p.workspace_id);
    if (!w || w.owner_id !== ownerId) {
      continue;
    }
    return {
      id: n.id,
      project_id: n.project_id,
      parent_id: n.parent_id,
      type: normalizeLegacyNoteType(n.type),
      title: n.title,
      content: n.content,
      metadata: parseMetadata(n.metadata_json),
      sibling_index: n.sibling_index,
      created_at_ms: n.created_at_ms,
      updated_at_ms: n.updated_at_ms,
    };
  }
  return null;
}

export function wpnJsonCreateNote(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
  payload: {
    anchorId?: string;
    relation: "child" | "sibling" | "root";
    type: string;
    content?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  },
): { id: string } {
  const slot = requireWpnJsonProject(store, ownerId, projectId);
  const noteType = normalizeLegacyNoteType(payload.type);
  const rows = loadRows(slot, projectId);
  const cm = childrenMapFromRows(rows);
  const id = newId();
  const t = nowMs();
  const title = (payload.title ?? "").trim() || "Untitled";
  const content = payload.content ?? "";
  const metadata_json =
    payload.metadata && Object.keys(payload.metadata).length > 0
      ? JSON.stringify(payload.metadata)
      : null;

  let parent_id: string | null = null;
  let sibling_index = 0;

  if (payload.relation === "root") {
    const roots = cm.get(null) ?? [];
    sibling_index =
      roots.length === 0 ? 0 : Math.max(...roots.map((r) => r.sibling_index)) + 1;
    parent_id = null;
  } else if (!payload.anchorId) {
    throw new Error("anchorId required for child/sibling");
  } else {
    const anchor = rows.find((r) => r.id === payload.anchorId);
    if (!anchor) {
      throw new Error("Anchor note not found");
    }
    if (payload.relation === "child") {
      parent_id = anchor.id;
      const kids = cm.get(anchor.id) ?? [];
      sibling_index =
        kids.length === 0 ? 0 : Math.max(...kids.map((r) => r.sibling_index)) + 1;
    } else {
      parent_id = anchor.parent_id;
      const sibs = (cm.get(parent_id) ?? [])
        .slice()
        .sort((a, b) => a.sibling_index - b.sibling_index);
      const ai = sibs.findIndex((x) => x.id === anchor.id);
      if (ai < 0) {
        throw new Error("Invalid anchor");
      }
      const orderedIds = [
        ...sibs.slice(0, ai + 1).map((r) => r.id),
        id,
        ...sibs.slice(ai + 1).map((r) => r.id),
      ];
      slot.notes.push({
        id,
        project_id: projectId,
        parent_id,
        type: noteType,
        title,
        content,
        metadata_json,
        sibling_index: 0,
        created_at_ms: t,
        updated_at_ms: t,
      });
      applySiblingOrderJson(slot, projectId, orderedIds);
      persist(store);
      return { id };
    }
  }

  slot.notes.push({
    id,
    project_id: projectId,
    parent_id,
    type: noteType,
    title,
    content,
    metadata_json,
    sibling_index,
    created_at_ms: t,
    updated_at_ms: t,
  });
  persist(store);
  return { id };
}

export function wpnJsonUpdateNote(
  store: WorkspaceStore,
  ownerId: string,
  noteId: string,
  patch: {
    title?: string;
    content?: string;
    metadata?: Record<string, unknown> | null;
    type?: string;
  },
): WpnNoteDetail | null {
  const cur = wpnJsonGetNoteById(store, ownerId, noteId);
  if (!cur) {
    return null;
  }
  const slot = findSlotForProject(store, cur.project_id);
  if (!slot) {
    return null;
  }
  const n = slot.notes.find((x) => x.id === noteId);
  if (!n) {
    return null;
  }
  const title = patch.title !== undefined ? patch.title.trim() || cur.title : cur.title;
  if (patch.title !== undefined && title !== cur.title) {
    const hasDup = slot.notes.some(
      (x) =>
        x.project_id === cur.project_id &&
        x.parent_id === cur.parent_id &&
        x.id !== noteId &&
        x.title === title,
    );
    if (hasDup) {
      throw new WpnJsonDuplicateTitleError();
    }
  }
  const content = patch.content !== undefined ? patch.content : cur.content;
  const type = normalizeLegacyNoteType(
    patch.type !== undefined ? patch.type : cur.type,
  );
  let metadata_json: string | null =
    cur.metadata && Object.keys(cur.metadata).length > 0
      ? JSON.stringify(cur.metadata)
      : null;
  if (patch.metadata !== undefined) {
    metadata_json =
      patch.metadata && Object.keys(patch.metadata).length > 0
        ? JSON.stringify(patch.metadata)
        : null;
  }
  n.title = title;
  n.content = content;
  n.metadata_json = metadata_json;
  n.type = type;
  n.updated_at_ms = nowMs();
  persist(store);
  return wpnJsonGetNoteById(store, ownerId, noteId);
}

export function wpnJsonDeleteNotes(
  store: WorkspaceStore,
  ownerId: string,
  ids: string[],
): void {
  const seeds = [...new Set(ids)].filter((id) =>
    wpnJsonGetNoteById(store, ownerId, id),
  );
  if (seeds.length === 0) {
    persist(store);
    return;
  }

  const toDelete = new Set<string>();
  for (const slot of store.slots) {
    const childMap = new Map<string | null, string[]>();
    for (const n of slot.notes) {
      const arr = childMap.get(n.parent_id) ?? [];
      arr.push(n.id);
      childMap.set(n.parent_id, arr);
    }
    const stack = seeds.filter((id) => slot.notes.some((n) => n.id === id));
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (toDelete.has(id)) continue;
      toDelete.add(id);
      for (const childId of childMap.get(id) ?? []) {
        stack.push(childId);
      }
    }
    if (toDelete.size > 0) {
      slot.notes = slot.notes.filter((x) => !toDelete.has(x.id));
    }
  }
  persist(store);
}

function persistTreeJson(
  slot: WorkspacePersistedSlot,
  projectId: string,
  childMap: Map<string | null, string[]>,
): void {
  const t = nowMs();
  const walk = (parentId: string | null, ids: string[]): void => {
    ids.forEach((id, i) => {
      const n = slot.notes.find((x) => x.id === id && x.project_id === projectId);
      if (n) {
        n.parent_id = parentId;
        n.sibling_index = i;
        n.updated_at_ms = t;
      }
      walk(id, childMap.get(id) ?? []);
    });
  };
  walk(null, childMap.get(null) ?? []);
}

export function wpnJsonMoveNote(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
  draggedId: string,
  targetId: string,
  placement: NoteMovePlacement,
): void {
  if (draggedId === targetId) {
    return;
  }
  const slot = requireWpnJsonProject(store, ownerId, projectId);
  const rows = loadRows(slot, projectId);
  const childMap = wpnComputeChildMapAfterMove(rows, draggedId, targetId, placement);
  persistTreeJson(slot, projectId, childMap);
  persist(store);
}

/**
 * Move a note (and its subtree) from one project to another.
 * The note becomes a root-level note in the target project (or a child of `targetParentId`).
 */
export function wpnJsonMoveNoteCrossProject(
  store: WorkspaceStore,
  ownerId: string,
  noteId: string,
  targetProjectId: string,
  targetParentId?: string | null,
): void {
  const note = wpnJsonGetNoteById(store, ownerId, noteId);
  if (!note) {
    throw new Error("Note not found");
  }
  if (note.project_id === targetProjectId) {
    throw new Error("Note is already in the target project; use within-project move instead");
  }
  if (!wpnJsonProjectOwnedBy(store, ownerId, targetProjectId)) {
    throw new Error("Target project not found");
  }
  const sourceSlot = findSlotForProject(store, note.project_id);
  if (!sourceSlot) {
    throw new Error("Source project not found");
  }
  const targetSlot = findSlotForProject(store, targetProjectId);
  if (!targetSlot) {
    throw new Error("Target project not found");
  }

  // Collect the full subtree (note + all descendants)
  const subtreeIds = new Set<string>();
  const stack = [noteId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (subtreeIds.has(id)) continue;
    subtreeIds.add(id);
    for (const n of sourceSlot.notes) {
      if (n.parent_id === id && n.project_id === note.project_id) {
        stack.push(n.id);
      }
    }
  }

  // Validate targetParentId is in the target project (if provided)
  if (targetParentId) {
    const parentNote = targetSlot.notes.find(
      (n) => n.id === targetParentId && n.project_id === targetProjectId,
    );
    if (!parentNote) {
      throw new Error("Target parent note not found in target project");
    }
  }

  // Compute the sibling_index for the moved note in the target project
  const newParentId = targetParentId ?? null;
  const targetSiblings = targetSlot.notes.filter(
    (n) => n.project_id === targetProjectId && n.parent_id === newParentId,
  );
  const maxSibIdx = targetSiblings.reduce((m, n) => Math.max(m, n.sibling_index), -1);

  const t = nowMs();

  // Update all notes in the subtree: change project_id, and for the root note, update parent_id
  for (const n of sourceSlot.notes) {
    if (!subtreeIds.has(n.id)) continue;
    n.project_id = targetProjectId;
    n.updated_at_ms = t;
    if (n.id === noteId) {
      n.parent_id = newParentId;
      n.sibling_index = maxSibIdx + 1;
    }
  }

  // If source and target are in different slots, physically move the note rows
  if (sourceSlot !== targetSlot) {
    const movedNotes = sourceSlot.notes.filter((n) => subtreeIds.has(n.id));
    sourceSlot.notes = sourceSlot.notes.filter((n) => !subtreeIds.has(n.id));
    targetSlot.notes.push(...movedNotes);
  }

  persist(store);
}

function wpnIsDescendantOf(
  store: WorkspaceStore,
  ownerId: string,
  ancestorId: string,
  nodeId: string,
): boolean {
  let cur: string | null =
    wpnJsonGetNoteById(store, ownerId, nodeId)?.parent_id ?? null;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestorId) {
      return true;
    }
    if (seen.has(cur)) {
      break;
    }
    seen.add(cur);
    cur = wpnJsonGetNoteById(store, ownerId, cur)?.parent_id ?? null;
  }
  return false;
}

/**
 * Same-project bulk move (mirrors flat `moveNotesBulk` ordering and guards).
 * Persists once per inner `wpnJsonMoveNote` (acceptable for typical selection sizes).
 */
export function wpnJsonMoveNotesBulk(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
  noteIds: string[],
  targetId: string,
  placement: NoteMovePlacement,
): void {
  const filtered = noteIds.filter((id) => !isWorkspaceMountNoteId(id));
  const idSet = new Set(filtered);
  const minimal: string[] = [];
  for (const id of filtered) {
    const d = wpnJsonGetNoteById(store, ownerId, id);
    if (!d) {
      throw new Error("Note not found");
    }
    if (d.project_id !== projectId) {
      throw new Error(
        "Cannot move selection that spans multiple WPN projects at once",
      );
    }
    let underSelected = false;
    let p: string | null = d.parent_id;
    const walked = new Set<string>();
    while (p) {
      if (idSet.has(p)) {
        underSelected = true;
        break;
      }
      if (walked.has(p)) {
        break;
      }
      walked.add(p);
      const parent = wpnJsonGetNoteById(store, ownerId, p);
      p = parent?.parent_id ?? null;
    }
    if (!underSelected) {
      minimal.push(id);
    }
  }

  const uniqueMinimal = [...new Set(minimal)];
  if (uniqueMinimal.length === 0) {
    return;
  }

  const flat = wpnJsonListNotesFlat(store, ownerId, projectId);
  const indexById = new Map(flat.map((r, i) => [r.id, i]));
  uniqueMinimal.sort(
    (a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0),
  );

  const target = wpnJsonGetNoteById(store, ownerId, targetId);
  if (!target) {
    throw new Error("Note not found");
  }
  if (target.project_id !== projectId) {
    throw new Error("Cannot move notes across WPN projects");
  }

  for (const r of uniqueMinimal) {
    if (r === targetId) {
      throw new Error("Invalid move target");
    }
    if (wpnIsDescendantOf(store, ownerId, r, targetId)) {
      throw new Error("Cannot move relative to node inside dragged subtree");
    }
  }

  if (placement === "into") {
    for (const r of uniqueMinimal) {
      if (wpnIsDescendantOf(store, ownerId, targetId, r)) {
        throw new Error("Cannot move into own subtree");
      }
    }
    for (const r of uniqueMinimal) {
      wpnJsonMoveNote(store, ownerId, projectId, r, targetId, "into");
    }
    return;
  }

  if (placement === "before") {
    for (const r of uniqueMinimal) {
      wpnJsonMoveNote(store, ownerId, projectId, r, targetId, "before");
    }
    return;
  }

  let anchor = targetId;
  for (const r of uniqueMinimal) {
    wpnJsonMoveNote(store, ownerId, projectId, r, anchor, "after");
    anchor = r;
  }
}

function collectSubtreePreorder(rows: WpnNoteRow[], rootId: string): string[] {
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

export function wpnJsonDuplicateNoteSubtree(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
  rootNoteId: string,
): { newRootId: string } {
  const slot = requireWpnJsonProject(store, ownerId, projectId);
  const rows = loadRows(slot, projectId);
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const rootRow = rowMap.get(rootNoteId);
  if (!rootRow) {
    throw new Error("Note not found");
  }
  const ordered = collectSubtreePreorder(rows, rootNoteId);
  const subtreeIds = new Set(ordered);
  const idMap = new Map<string, string>();
  for (const id of ordered) {
    idMap.set(id, newId());
  }
  const newRootId = idMap.get(rootNoteId)!;
  const P = rootRow.parent_id;
  const cmBefore = childrenMapFromRows(rows);
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
    slot.notes.push({
      id: nid,
      project_id: projectId,
      parent_id: newParent,
      type: r.type,
      title: r.title,
      content: r.content,
      metadata_json: r.metadata_json,
      sibling_index: 0,
      created_at_ms: t,
      updated_at_ms: t,
    });
  }

  applySiblingOrderJson(slot, projectId, newOrderAtP);

  for (const oid of ordered) {
    const kids = (cmBefore.get(oid) ?? []).filter((k) => subtreeIds.has(k.id));
    if (kids.length === 0) {
      continue;
    }
    const newPid = idMap.get(oid)!;
    const newKidOrder = kids.map((k) => idMap.get(k.id)!);
    applySiblingOrderJson(slot, projectId, newKidOrder);
  }

  persist(store);
  return { newRootId };
}

export function wpnJsonGetExplorerExpanded(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
): string[] {
  requireWpnJsonProject(store, ownerId, projectId);
  const slot = findSlotForProject(store, projectId)!;
  const row = slot.explorer.find((e) => e.project_id === projectId);
  if (!row?.expanded_ids?.length) {
    return [];
  }
  return [...row.expanded_ids];
}

export function wpnJsonSetExplorerExpanded(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
  expandedIds: string[],
): void {
  requireWpnJsonProject(store, ownerId, projectId);
  const slot = findSlotForProject(store, projectId)!;
  const json = [...new Set(expandedIds)];
  const idx = slot.explorer.findIndex((e) => e.project_id === projectId);
  if (idx >= 0) {
    slot.explorer[idx] = { project_id: projectId, expanded_ids: json };
  } else {
    slot.explorer.push({ project_id: projectId, expanded_ids: json });
  }
  persist(store);
}

export function wpnJsonListAllNotesWithContext(
  store: WorkspaceStore,
  ownerId: string,
): WpnNoteWithContextListItem[] {
  const out: WpnNoteWithContextListItem[] = [];
  for (const slot of store.slots) {
    for (const n of slot.notes) {
      const p = slot.projects.find((x) => x.id === n.project_id);
      if (!p) {
        continue;
      }
      const w = slot.workspaces.find((x) => x.id === p.workspace_id);
      if (!w || w.owner_id !== ownerId) {
        continue;
      }
      out.push({
        id: n.id,
        type: normalizeLegacyNoteType(n.type),
        title: n.title,
        project_id: n.project_id,
        project_name: p.name,
        workspace_id: p.workspace_id,
        workspace_name: w.name,
        parent_id: n.parent_id,
      });
    }
  }
  return out;
}

export function wpnJsonGetNoteWithContextById(
  store: WorkspaceStore,
  ownerId: string,
  noteId: string,
): WpnNoteWithContextListItem | null {
  const list = wpnJsonListAllNotesWithContext(store, ownerId);
  return list.find((x) => x.id === noteId) ?? null;
}

export function wpnJsonListAllNoteContentsForOwner(
  store: WorkspaceStore,
  ownerId: string,
): { id: string; content: string; project_id: string }[] {
  const out: { id: string; content: string; project_id: string }[] = [];
  for (const slot of store.slots) {
    for (const n of slot.notes) {
      const p = slot.projects.find((x) => x.id === n.project_id);
      if (!p) {
        continue;
      }
      const w = slot.workspaces.find((x) => x.id === p.workspace_id);
      if (!w || w.owner_id !== ownerId) {
        continue;
      }
      out.push({ id: n.id, content: n.content ?? "", project_id: n.project_id });
    }
  }
  return out;
}

export function wpnJsonGetDefaultProjectIdForOwner(
  store: WorkspaceStore,
  ownerId: string,
): string | null {
  for (const slot of store.slots) {
    const wsList = slot.workspaces
      .filter((w) => w.owner_id === ownerId)
      .sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
    for (const w of wsList) {
      const projs = slot.projects
        .filter((p) => p.workspace_id === w.id)
        .sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
      if (projs[0]) {
        return projs[0]!.id;
      }
    }
  }
  return null;
}

/** Flat list across all WPN projects for the owner (legacy `GET_ALL_NOTES` shape). */
export function wpnJsonListAllNotesAsNoteListItems(
  store: WorkspaceStore,
  ownerId: string,
): NoteListItem[] {
  const out: NoteListItem[] = [];
  for (const slot of store.slots) {
    for (const p of slot.projects) {
      const w = slot.workspaces.find((x) => x.id === p.workspace_id);
      if (!w || w.owner_id !== ownerId) {
        continue;
      }
      for (const it of wpnJsonListNotesFlat(store, ownerId, p.id)) {
        out.push({
          id: it.id,
          type: it.type,
          title: it.title,
          parentId: it.parent_id,
          depth: it.depth,
        });
      }
    }
  }
  return out;
}

export function wpnJsonListBacklinksToNote(
  store: WorkspaceStore,
  ownerId: string,
  targetNoteId: string,
): WpnBacklinkSourceItem[] {
  const rows: {
    id: string;
    title: string;
    content: string;
    project_id: string;
    workspace_name: string;
    project_name: string;
  }[] = [];
  for (const slot of store.slots) {
    for (const n of slot.notes) {
      const p = slot.projects.find((x) => x.id === n.project_id);
      if (!p) {
        continue;
      }
      const w = slot.workspaces.find((x) => x.id === p.workspace_id);
      if (!w || w.owner_id !== ownerId || n.id === targetNoteId) {
        continue;
      }
      rows.push({
        id: n.id,
        title: n.title,
        content: n.content,
        project_id: n.project_id,
        workspace_name: w.name,
        project_name: p.name,
      });
    }
  }

  // Build the full notes-with-context list once for VFS path resolution.
  let allNotesWithContext: WpnNoteWithContextListItem[] | null = null;

  const out: WpnBacklinkSourceItem[] = [];
  for (const r of rows) {
    const content = r.content ?? "";

    // Check direct note-id references (#/n/<id>).
    const noteIdRefs = collectReferencedNoteIdsFromMarkdown(content);
    if (noteIdRefs.has(targetNoteId)) {
      out.push({ id: r.id, title: r.title, project_id: r.project_id });
      continue;
    }

    // Check VFS path references (#/w/...).
    const vfsPaths = collectReferencedVfsPathsFromMarkdown(content);
    if (vfsPaths.size === 0) continue;

    // Lazily build the full notes list for resolution.
    if (allNotesWithContext === null) {
      allNotesWithContext = wpnJsonListAllNotesWithContext(store, ownerId);
    }

    let found = false;
    for (const vfsPath of vfsPaths) {
      let canonicalPath: string | null;
      if (isTreeRelativeVfsPath(vfsPath)) {
        // Resolve ../sibling etc. relative to the source note's position in the tree.
        canonicalPath = resolveTreeRelativeVfsPath(vfsPath, r.id, allNotesWithContext);
      } else if (isSameProjectRelativeVfsPath(vfsPath)) {
        // Resolve ./Title relative to the source note's workspace/project.
        canonicalPath = resolveSameProjectRelativeVfsToCanonical(vfsPath, {
          workspace_name: r.workspace_name,
          project_name: r.project_name,
        });
      } else {
        canonicalPath = vfsPath;
      }
      if (!canonicalPath) continue;

      const resolvedId = resolveNoteIdByCanonicalVfsPath(
        allNotesWithContext,
        canonicalPath,
      );
      if (resolvedId === targetNoteId) {
        found = true;
        break;
      }
    }
    if (found) {
      out.push({ id: r.id, title: r.title, project_id: r.project_id });
    }
  }
  return out;
}
