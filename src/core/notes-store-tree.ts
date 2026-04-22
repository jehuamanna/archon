import {
  isWorkspaceMountNoteId,
  noteDataWorkspaceSlot,
  WORKSPACE_MOUNT_SENTINEL,
} from "../shared/note-workspace";
import {
  collectSubtreeIds,
  getChildren,
  newNoteIdForWorkspaceSlot,
  notes,
  setChildren,
  type NoteMovePlacement,
} from "./notes-store-core";

export function targetParentWorkspaceSlot(
  targetId: string,
  placement: NoteMovePlacement,
): number {
  const target = notes.get(targetId);
  if (!target) {
    throw new Error("Note not found");
  }
  if (placement === "into") {
    const s = noteDataWorkspaceSlot(targetId);
    if (s === WORKSPACE_MOUNT_SENTINEL) {
      const mountM = /^__archon_mount_(\d+)$/.exec(targetId);
      return mountM ? Number(mountM[1]) : 0;
    }
    return s;
  }
  const p = target.parentId;
  if (p == null) {
    if (isWorkspaceMountNoteId(targetId)) {
      const mountM = /^__archon_mount_(\d+)$/.exec(targetId);
      return mountM ? Number(mountM[1]) : 0;
    }
    return noteDataWorkspaceSlot(targetId);
  }
  const ps = noteDataWorkspaceSlot(p);
  if (ps === WORKSPACE_MOUNT_SENTINEL) {
    const mountM = /^__archon_mount_(\d+)$/.exec(p);
    return mountM ? Number(mountM[1]) : 0;
  }
  return ps;
}

export function cloneSubtreeToNewSlot(
  sourceRootId: string,
  destSlot: number,
): string {
  const toClone = collectSubtreeIds(sourceRootId);
  const idMap = new Map<string, string>();
  for (const oldId of toClone) {
    idMap.set(oldId, newNoteIdForWorkspaceSlot(destSlot));
  }
  for (const oldId of toClone) {
    const old = notes.get(oldId)!;
    const newId = idMap.get(oldId)!;
    const oldP = old.parentId;
    const newP =
      oldId === sourceRootId
        ? null
        : oldP != null
          ? (idMap.get(oldP) ?? null)
          : null;
    notes.set(newId, {
      id: newId,
      parentId: newP,
      type: old.type,
      title: old.title,
      content: old.content,
      metadata: old.metadata ? { ...old.metadata } : undefined,
    });
  }
  for (const oldId of toClone) {
    const oldKids = [...getChildren(oldId)];
    setChildren(
      idMap.get(oldId)!,
      oldKids.map((k) => idMap.get(k)!),
    );
  }
  return idMap.get(sourceRootId)!;
}

export function attachBlockAtPlacement(
  block: string[],
  targetId: string,
  placement: NoteMovePlacement,
): void {
  const target = notes.get(targetId);
  if (!target) {
    throw new Error("Note not found");
  }
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

export function insertClonedRootAt(
  cloneRootId: string,
  targetId: string,
  placement: NoteMovePlacement,
): void {
  const cloneRoot = notes.get(cloneRootId);
  if (!cloneRoot) {
    throw new Error("Clone missing");
  }
  const target = notes.get(targetId);
  if (!target) {
    throw new Error("Target not found");
  }
  if (placement === "into") {
    const kids = [...getChildren(targetId)];
    kids.push(cloneRootId);
    cloneRoot.parentId = targetId;
    setChildren(targetId, kids);
    return;
  }
  const parentId = target.parentId;
  const siblings = [...getChildren(parentId)];
  const tIdx = siblings.indexOf(targetId);
  const ins = placement === "before" ? tIdx : tIdx + 1;
  if (tIdx < 0) {
    siblings.push(cloneRootId);
  } else {
    siblings.splice(ins, 0, cloneRootId);
  }
  cloneRoot.parentId = parentId;
  setChildren(parentId, siblings);
}
