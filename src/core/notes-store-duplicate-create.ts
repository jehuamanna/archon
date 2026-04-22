import { randomUUID } from "crypto";
import {
  PLUGIN_UI_METADATA_KEY,
  validatePluginUiStateSize,
} from "../shared/plugin-state-protocol";
import {
  isWorkspaceMountNoteId,
  noteDataWorkspaceSlot,
  WORKSPACE_MOUNT_SENTINEL,
} from "../shared/note-workspace";
import {
  getChildren,
  newNoteIdForAnchor,
  notes,
  setChildren,
  type NoteRecord,
  type NoteMovePlacement,
} from "./notes-store-core";
import { bodyForType, titleForType } from "./notes-store-seed";
import {
  insertClonedRootAt,
  cloneSubtreeToNewSlot,
  targetParentWorkspaceSlot,
} from "./notes-store-tree";

export const MAX_NOTE_CONTENT_CHARS = 5_000_000;

export function duplicateSubtreeAt(
  sourceRootId: string,
  targetId: string,
  placement: NoteMovePlacement,
): { newRootId: string } {
  const source = notes.get(sourceRootId);
  const target = notes.get(targetId);
  if (!source || !target) {
    throw new Error("Note not found");
  }
  if (isWorkspaceMountNoteId(sourceRootId)) {
    throw new Error("Cannot duplicate workspace folder headers");
  }
  const srcSlot = noteDataWorkspaceSlot(sourceRootId);
  const destSlot = targetParentWorkspaceSlot(targetId, placement);
  if (srcSlot !== destSlot) {
    const newRootId = cloneSubtreeToNewSlot(sourceRootId, destSlot);
    insertClonedRootAt(newRootId, targetId, placement);
    return { newRootId };
  }

  function cloneRecursive(oldId: string): string {
    const old = notes.get(oldId)!;
    const newId =
      srcSlot === 0 || srcSlot === WORKSPACE_MOUNT_SENTINEL
        ? randomUUID()
        : `r${srcSlot}_${randomUUID()}`;
    const oldChildIds = [...getChildren(oldId)];
    const newChildIds = oldChildIds.map(cloneRecursive);
    notes.set(newId, {
      id: newId,
      parentId: null,
      type: old.type,
      title: old.title,
      content: old.content,
      metadata: old.metadata ? { ...old.metadata } : undefined,
    });
    setChildren(newId, newChildIds);
    for (const cid of newChildIds) {
      const c = notes.get(cid)!;
      c.parentId = newId;
    }
    return newId;
  }

  const newRootId = cloneRecursive(sourceRootId);
  insertClonedRootAt(newRootId, targetId, placement);
  return { newRootId };
}

export function createNote(opts: {
  anchorId?: string;
  relation: "child" | "sibling" | "root";
  type: string;
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): NoteRecord {
  const id = newNoteIdForAnchor(opts.anchorId, opts.relation);
  const body = bodyForType(opts.type);
  const rec: NoteRecord = {
    id,
    parentId: null,
    type: opts.type,
    title: opts.title !== undefined ? opts.title : titleForType(opts.type),
    content: opts.content !== undefined ? opts.content : body.content,
    metadata:
      opts.metadata !== undefined ? opts.metadata : body.metadata,
  };

  if (opts.relation === "root") {
    rec.parentId = null;
    notes.set(id, rec);
    const ch = [...getChildren(null), id];
    setChildren(null, ch);
    return rec;
  }

  if (!opts.anchorId) {
    throw new Error("Anchor note required");
  }

  const anchor = notes.get(opts.anchorId);
  if (!anchor) {
    throw new Error("Note not found");
  }

  if (opts.relation === "child") {
    rec.parentId = opts.anchorId;
    notes.set(id, rec);
    const ch = [...getChildren(opts.anchorId), id];
    setChildren(opts.anchorId, ch);
    return rec;
  }

  const parentId = anchor.parentId;
  rec.parentId = parentId;
  notes.set(id, rec);
  const siblings = [...getChildren(parentId)];
  const idx = siblings.indexOf(opts.anchorId);
  if (idx === -1) {
    siblings.push(id);
  } else {
    siblings.splice(idx + 1, 0, id);
  }
  setChildren(parentId, siblings);
  return rec;
}

export function renameNote(id: string, title: string): void {
  const n = notes.get(id);
  if (!n) {
    throw new Error("Note not found");
  }
  const t = title.trim();
  if (!t) {
    throw new Error("Title is required");
  }
  n.title = t;
}

export function setNoteContent(noteId: string, content: string): void {
  if (typeof content !== "string") {
    throw new Error("Content must be a string");
  }
  if (content.length > MAX_NOTE_CONTENT_CHARS) {
    throw new Error(
      `Content exceeds maximum length (${MAX_NOTE_CONTENT_CHARS} characters)`,
    );
  }
  const n = notes.get(noteId);
  if (!n) {
    throw new Error("Note not found");
  }
  n.content = content;
}

export function setNotePluginUiState(noteId: string, state: unknown): void {
  const err = validatePluginUiStateSize(state);
  if (err) {
    throw new Error(err);
  }
  const n = notes.get(noteId);
  if (!n) {
    throw new Error("Note not found");
  }
  const meta: Record<string, unknown> = { ...(n.metadata ?? {}) };
  meta[PLUGIN_UI_METADATA_KEY] = state;
  n.metadata = meta;
}

export function patchNoteMetadata(noteId: string, patch: Record<string, unknown>): void {
  if (!patch || typeof patch !== "object") {
    throw new Error("Invalid metadata patch");
  }
  const n = notes.get(noteId);
  if (!n) {
    throw new Error("Note not found");
  }
  const base: Record<string, unknown> = { ...(n.metadata ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    base[k] = v;
  }
  n.metadata = base;
}
