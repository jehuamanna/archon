import { randomUUID } from "crypto";

export type NoteRecord = {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type NoteListRow = {
  id: string;
  type: string;
  title: string;
  parentId: string | null;
  depth: number;
  metadata?: Record<string, unknown>;
};

export type NoteMovePlacement = "before" | "after" | "into";

export const ROOT_KEY = "__root__";

export {
  isWorkspaceMountNoteId,
  noteDataWorkspaceSlot,
  WORKSPACE_MOUNT_SENTINEL,
} from "../shared/note-workspace";

export const notes = new Map<string, NoteRecord>();
export const childOrder = new Map<string, string[]>();

export function orderKey(parentId: string | null): string {
  return parentId ?? ROOT_KEY;
}

export function getChildren(parentId: string | null): string[] {
  return childOrder.get(orderKey(parentId)) ?? [];
}

export function setChildren(parentId: string | null, ids: string[]): void {
  childOrder.set(orderKey(parentId), ids);
}

export function syncNullChildOrderFromRecords(): void {
  const rootIds = new Set<string>();
  for (const n of notes.values()) {
    if (n.parentId === null) {
      rootIds.add(n.id);
    }
  }
  if (rootIds.size === 0) {
    return;
  }
  const prev = getChildren(null);
  const ordered: string[] = [];
  for (const id of prev) {
    if (rootIds.delete(id)) {
      ordered.push(id);
    }
  }
  const remaining = [...rootIds];
  remaining.sort((a, b) => {
    const ma = /^__archon_mount_(\d+)$/.exec(a);
    const mb = /^__archon_mount_(\d+)$/.exec(b);
    if (ma && mb) {
      return Number(ma[1]) - Number(mb[1]);
    }
    if (ma) {
      return 1;
    }
    if (mb) {
      return -1;
    }
    return a.localeCompare(b);
  });
  ordered.push(...remaining);
  setChildren(null, ordered);
}

export function resetNotesStore(): void {
  notes.clear();
  childOrder.clear();
}

export function removeFromParentList(noteId: string): void {
  const n = notes.get(noteId);
  if (!n) {
    return;
  }
  const p = n.parentId;
  const list = [...getChildren(p)];
  const i = list.indexOf(noteId);
  if (i >= 0) {
    list.splice(i, 1);
    setChildren(p, list);
  }
}

export function collectSubtreeIds(rootId: string): string[] {
  const out: string[] = [];
  function walk(id: string): void {
    out.push(id);
    for (const c of getChildren(id)) {
      walk(c);
    }
  }
  walk(rootId);
  return out;
}

export function newNoteIdForWorkspaceSlot(destSlot: number): string {
  if (destSlot === 0) {
    return randomUUID();
  }
  return `r${destSlot}_${randomUUID()}`;
}

export function newNoteIdForAnchor(
  anchorId: string | undefined,
  relation: "child" | "sibling" | "root",
): string {
  if (relation === "root") {
    return randomUUID();
  }
  if (!anchorId) {
    return randomUUID();
  }
  const mountM = /^__archon_mount_(\d+)$/.exec(anchorId);
  if (mountM) {
    return `r${mountM[1]}_${randomUUID()}`;
  }
  const rm = /^r(\d+)_/.exec(anchorId);
  if (rm) {
    return `r${rm[1]}_${randomUUID()}`;
  }
  return randomUUID();
}
