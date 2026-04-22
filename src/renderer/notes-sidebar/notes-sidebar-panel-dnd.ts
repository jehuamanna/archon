import type { NoteListItem, NoteMovePlacement } from "@archon/ui-types";
import {
  isStrictAncestor,
  minimalSelectedRoots,
  WORKSPACE_MOUNT_ROW_RE,
} from "./notes-sidebar-utils";

export function placementFromPointer(
  e: React.DragEvent,
  el: HTMLElement,
): NoteMovePlacement {
  const rect = el.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const frac = rect.height > 0 ? y / rect.height : 0.5;
  if (frac < 0.25) {
    return "before";
  }
  if (frac > 0.75) {
    return "after";
  }
  return "into";
}

export function dropAllowedOne(
  draggedId: string,
  targetId: string,
  placement: NoteMovePlacement,
  parents: Map<string, string | null>,
): boolean {
  if (draggedId === targetId) {
    return false;
  }
  if (
    WORKSPACE_MOUNT_ROW_RE.test(targetId) &&
    (placement === "before" || placement === "after")
  ) {
    return false;
  }
  if (isStrictAncestor(draggedId, targetId, parents)) {
    return false;
  }
  if (placement === "into" && targetId === draggedId) {
    return false;
  }
  return true;
}

/** Dragging an asset file onto the tree (not an existing note id). */
export function dropAllowedAssetOnNote(
  targetId: string,
  placement: NoteMovePlacement,
): boolean {
  if (
    WORKSPACE_MOUNT_ROW_RE.test(targetId) &&
    (placement === "before" || placement === "after")
  ) {
    return false;
  }
  return true;
}

export function dropAllowedMany(
  draggedIds: string[],
  targetId: string,
  placement: NoteMovePlacement,
  parents: Map<string, string | null>,
): boolean {
  if (draggedIds.length === 0) {
    return false;
  }
  const dragSet = new Set(draggedIds);
  for (const d of draggedIds) {
    if (!dropAllowedOne(d, targetId, placement, parents)) {
      return false;
    }
  }
  if (dragSet.has(targetId)) {
    return false;
  }
  return true;
}

export function idsToDragForRow(
  noteId: string,
  selectedNoteIds: Set<string>,
  parents: Map<string, string | null>,
): string[] {
  if (WORKSPACE_MOUNT_ROW_RE.test(noteId)) {
    return [];
  }
  const sel = selectedNoteIds;
  if (sel.has(noteId) && sel.size > 1) {
    const bulk = new Set(sel);
    return minimalSelectedRoots(bulk, parents).filter(
      (id) => !WORKSPACE_MOUNT_ROW_RE.test(id),
    );
  }
  return [noteId];
}
