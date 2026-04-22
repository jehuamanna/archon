import {
  getChildren,
  notes,
  syncNullChildOrderFromRecords,
  type NoteListRow,
  type NoteRecord,
} from "./notes-store-core";

export function isDescendantOf(ancestorId: string, nodeId: string): boolean {
  let p = notes.get(nodeId)?.parentId ?? null;
  while (p) {
    if (p === ancestorId) {
      return true;
    }
    p = notes.get(p)?.parentId ?? null;
  }
  return false;
}

export function mergeMultipleRootsIfNeeded(): void {
  syncNullChildOrderFromRecords();
}

export function getNotesFlat(): NoteListRow[] {
  if (notes.size > 0 && getChildren(null).length === 0) {
    syncNullChildOrderFromRecords();
  }
  const out: NoteListRow[] = [];
  function walk(parentId: string | null, depth: number): void {
    for (const id of getChildren(parentId)) {
      const n = notes.get(id);
      if (!n) {
        continue;
      }
      const row: NoteListRow = {
        id: n.id,
        type: n.type,
        title: n.title,
        parentId: n.parentId,
        depth,
      };
      if (n.metadata && Object.keys(n.metadata).length > 0) {
        row.metadata = { ...n.metadata };
      }
      out.push(row);
      walk(id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

export function getNoteById(noteId: string): NoteRecord | null {
  return notes.get(noteId) ?? null;
}

export function getFirstNote(): NoteRecord | null {
  const flat = getNotesFlat();
  if (flat.length === 0) {
    return null;
  }
  return notes.get(flat[0]!.id) ?? null;
}
