import {
  isWorkspaceMountNoteId,
  noteDataWorkspaceSlot,
  WORKSPACE_MOUNT_SENTINEL,
} from "../shared/note-workspace";
import {
  childOrder,
  collectSubtreeIds,
  getChildren,
  notes,
  orderKey,
  removeFromParentList,
  setChildren,
  syncNullChildOrderFromRecords,
  type NoteMovePlacement,
} from "./notes-store-core";
import { isDescendantOf, getNotesFlat } from "./notes-store-query";
import {
  attachBlockAtPlacement,
  cloneSubtreeToNewSlot,
  insertClonedRootAt,
  targetParentWorkspaceSlot,
} from "./notes-store-tree";

export function deleteNoteSubtree(noteId: string): void {
  if (isWorkspaceMountNoteId(noteId)) {
    throw new Error("Cannot delete workspace folder headers from the tree");
  }
  if (!notes.get(noteId)) {
    throw new Error("Note not found");
  }
  const ids = collectSubtreeIds(noteId);
  removeFromParentList(noteId);
  for (const id of ids) {
    childOrder.delete(orderKey(id));
  }
  for (const id of ids) {
    notes.delete(id);
  }
  syncNullChildOrderFromRecords();
}

export function deleteNoteSubtrees(rootIds: string[]): void {
  const unique = [...new Set(rootIds)];
  const uniqueSet = new Set(unique);
  const minimal = unique.filter((id) => {
    let p = notes.get(id)?.parentId ?? null;
    while (p) {
      if (uniqueSet.has(p)) {
        return false;
      }
      p = notes.get(p)?.parentId ?? null;
    }
    return true;
  });
  const flat = getNotesFlat();
  const indexById = new Map(flat.map((r, i) => [r.id, i]));
  minimal.sort(
    (a, b) => (indexById.get(b) ?? 0) - (indexById.get(a) ?? 0),
  );
  const withoutMounts = minimal.filter((id) => !isWorkspaceMountNoteId(id));
  for (const id of withoutMounts) {
    if (notes.has(id)) {
      deleteNoteSubtree(id);
    }
  }
}

export function moveNotesBulk(
  noteIds: string[],
  targetId: string,
  placement: NoteMovePlacement,
): void {
  const idSet = new Set(noteIds);
  const minimal: string[] = [];
  for (const id of noteIds) {
    if (!notes.get(id)) {
      throw new Error("Note not found");
    }
    let p: string | null = notes.get(id)?.parentId ?? null;
    let underSelected = false;
    while (p) {
      if (idSet.has(p)) {
        underSelected = true;
        break;
      }
      p = notes.get(p)?.parentId ?? null;
    }
    if (!underSelected) {
      minimal.push(id);
    }
  }

  const uniqueMinimal = [...new Set(minimal)];
  if (uniqueMinimal.length === 0) {
    return;
  }

  const flat = getNotesFlat();
  const indexById = new Map(flat.map((r, i) => [r.id, i]));
  uniqueMinimal.sort(
    (a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0),
  );

  const target = notes.get(targetId);
  if (!target) {
    throw new Error("Note not found");
  }

  const workspaceSlots = new Set(
    uniqueMinimal.map((id) => noteDataWorkspaceSlot(id)),
  );
  if (workspaceSlots.has(WORKSPACE_MOUNT_SENTINEL)) {
    throw new Error("Cannot move workspace folder headers");
  }
  if (workspaceSlots.size !== 1) {
    throw new Error(
      "Cannot move selection that spans multiple project folders at once",
    );
  }
  const srcSlot = [...workspaceSlots][0]!;
  const destSlot = targetParentWorkspaceSlot(targetId, placement);

  for (const r of uniqueMinimal) {
    if (r === targetId) {
      throw new Error("Invalid move target");
    }
    if (isDescendantOf(r, targetId)) {
      throw new Error("Cannot move relative to node inside dragged subtree");
    }
  }

  if (placement === "into") {
    for (const r of uniqueMinimal) {
      if (isDescendantOf(targetId, r)) {
        throw new Error("Cannot move into own subtree");
      }
    }
  }

  if (srcSlot !== destSlot) {
    const sortedRemove = [...uniqueMinimal].sort(
      (a, b) => (indexById.get(b) ?? 0) - (indexById.get(a) ?? 0),
    );
    const newRoots = uniqueMinimal.map((r) =>
      cloneSubtreeToNewSlot(r, destSlot),
    );
    for (const r of sortedRemove) {
      deleteNoteSubtree(r);
    }
    attachBlockAtPlacement(newRoots, targetId, placement);
    return;
  }

  const sortedRemove = [...uniqueMinimal].sort(
    (a, b) => (indexById.get(b) ?? 0) - (indexById.get(a) ?? 0),
  );
  for (const r of sortedRemove) {
    removeFromParentList(r);
  }

  const block = uniqueMinimal;

  if (placement === "into") {
    const kids = [...getChildren(targetId)];
    for (const r of block) {
      const rec = notes.get(r);
      if (rec) {
        rec.parentId = targetId;
        kids.push(r);
      }
    }
    setChildren(targetId, kids);
    return;
  }

  const parentId = target.parentId;
  const siblings = [...getChildren(parentId)];
  const tIdx = siblings.indexOf(targetId);
  const ins = placement === "before" ? tIdx : tIdx + 1;
  for (const r of block) {
    const rec = notes.get(r);
    if (rec) {
      rec.parentId = parentId;
    }
  }
  if (tIdx < 0) {
    siblings.push(...block);
  } else {
    siblings.splice(ins, 0, ...block);
  }
  setChildren(parentId, siblings);
}

export function moveNote(
  draggedId: string,
  targetId: string,
  placement: NoteMovePlacement,
): void {
  if (draggedId === targetId) {
    return;
  }

  const dragged = notes.get(draggedId);
  const target = notes.get(targetId);
  if (!dragged || !target) {
    throw new Error("Note not found");
  }

  if (isDescendantOf(draggedId, targetId)) {
    throw new Error("Cannot move into own subtree");
  }

  if (isWorkspaceMountNoteId(draggedId)) {
    throw new Error("Cannot move workspace folder headers");
  }

  const srcSlot = noteDataWorkspaceSlot(draggedId);
  const destSlot = targetParentWorkspaceSlot(targetId, placement);

  if (srcSlot !== destSlot) {
    const newRoot = cloneSubtreeToNewSlot(draggedId, destSlot);
    deleteNoteSubtree(draggedId);
    insertClonedRootAt(newRoot, targetId, placement);
    return;
  }

  removeFromParentList(draggedId);

  if (placement === "into") {
    const kids = [...getChildren(targetId)];
    kids.push(draggedId);
    dragged.parentId = targetId;
    setChildren(targetId, kids);
    return;
  }

  const parentId = target.parentId;
  const siblings = [...getChildren(parentId)];
  const tIdx = siblings.indexOf(targetId);
  if (tIdx < 0) {
    siblings.push(draggedId);
    dragged.parentId = parentId;
    setChildren(parentId, siblings);
    return;
  }
  const ins = placement === "before" ? tIdx : tIdx + 1;
  siblings.splice(ins, 0, draggedId);
  dragged.parentId = parentId;
  setChildren(parentId, siblings);
}
