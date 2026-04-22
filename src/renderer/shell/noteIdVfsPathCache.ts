import { canonicalVfsPathFromNoteContext } from "../../shared/note-vfs-path";
import type { WpnNoteWithContextListItem } from "../../shared/wpn-v2-types";

const NOTE_VFS_CACHE_EVENT = "archon:note-vfs-path-cache-changed";

let idToPath = new Map<string, string>();

export function setNoteIdVfsPathCacheFromWpnNotes(
  notes: readonly WpnNoteWithContextListItem[],
): void {
  const next = new Map<string, string>();
  for (const n of notes) {
    next.set(n.id, canonicalVfsPathFromNoteContext(n));
  }
  idToPath = next;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(NOTE_VFS_CACHE_EVENT));
  }
}

export function getCachedCanonicalVfsPathForNoteId(noteId: string): string | undefined {
  return idToPath.get(noteId);
}

export function subscribeNoteVfsPathCacheInvalidated(fn: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const listener = (): void => {
    fn();
  };
  window.addEventListener(NOTE_VFS_CACHE_EVENT, listener);
  return () => window.removeEventListener(NOTE_VFS_CACHE_EVENT, listener);
}
