/**
 * Pure helpers for multi-root workspace note ids (safe for renderer webpack — no Node built-ins).
 */

/** Synthetic tree node for an added project folder (`__archon_mount_1`, …). */
export function isWorkspaceMountNoteId(noteId: string): boolean {
  return /^__archon_mount_\d+$/.test(noteId);
}

/** Which workspace slot owns this note: `0` = primary project, `N` = `rN_` prefix. Mount headers return `-1`. */
export const WORKSPACE_MOUNT_SENTINEL = -1;

export function noteDataWorkspaceSlot(noteId: string): number {
  if (isWorkspaceMountNoteId(noteId)) {
    return WORKSPACE_MOUNT_SENTINEL;
  }
  const m = /^r(\d+)_(.+)$/.exec(noteId);
  if (m) {
    return Number(m[1]);
  }
  return 0;
}

/** Loose compare of absolute project folder paths (Windows vs POSIX separators). */
export function sameWorkspaceFolderPath(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/").replace(/\/+$/u, "");
  const nb = b.replace(/\\/g, "/").replace(/\/+$/u, "");
  return na === nb;
}

/** Absolute project folder for this note (that root’s `data/archon-workspace.json` and `assets/`). */
export function workspaceFolderPathForNote(
  noteId: string,
  workspaceRoots: string[],
): string | null {
  if (workspaceRoots.length === 0) {
    return null;
  }
  if (isWorkspaceMountNoteId(noteId)) {
    const m = /^__archon_mount_(\d+)$/.exec(noteId);
    const idx = m ? Number(m[1]) : 0;
    return workspaceRoots[idx] ?? null;
  }
  const slot = noteDataWorkspaceSlot(noteId);
  if (slot < 0) {
    return null;
  }
  return workspaceRoots[slot] ?? null;
}
