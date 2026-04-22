const pendingDeleteIds = new Set<string>();

export function markNotePendingDelete(noteId: string): void {
  pendingDeleteIds.add(noteId);
}

export function unmarkNotePendingDelete(noteId: string): void {
  pendingDeleteIds.delete(noteId);
}

export function isNotePendingDelete(noteId: string): boolean {
  return pendingDeleteIds.has(noteId);
}
