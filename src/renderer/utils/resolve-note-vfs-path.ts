import { getArchon } from "../../shared/archon-host-access";
import {
  resolveNoteIdByCanonicalVfsPath,
  resolveSameProjectRelativeVfsToCanonical,
  isSameProjectRelativeVfsPath,
  isTreeRelativeVfsPath,
  resolveTreeRelativeVfsPath,
} from "../../shared/note-vfs-path";

/**
 * Resolves explorer-style canonical path `Workspace/Project/Title`,
 * same-project relative `./Title`, or tree-relative `../sibling` when
 * `baseNoteId` identifies the referrer note (for relative links in markdown).
 */
export async function resolveNoteIdFromVfsPath(
  vfsPath: string,
  baseNoteId?: string,
): Promise<string | null> {
  const archon = typeof window !== "undefined" ? getArchon() : undefined;
  if (!archon?.wpnListAllNotesWithContext) return null;
  try {
    const { notes } = await archon.wpnListAllNotesWithContext();
    const list = Array.isArray(notes) ? notes : [];
    let canonical = vfsPath.trim();

    // Tree-relative paths: ../sibling, ../../uncle, ../sibling/child
    if (isTreeRelativeVfsPath(canonical) && baseNoteId) {
      const resolved = resolveTreeRelativeVfsPath(canonical, baseNoteId, list);
      if (resolved) {
        canonical = resolved;
      } else {
        return null; // unresolvable tree path
      }
    }
    // Same-project relative paths: ./Title
    else if (isSameProjectRelativeVfsPath(canonical) && baseNoteId) {
      const baseRow = list.find((n) => n.id === baseNoteId);
      if (baseRow) {
        const mapped = resolveSameProjectRelativeVfsToCanonical(canonical, baseRow);
        if (mapped) {
          canonical = mapped;
        }
      }
    }

    return resolveNoteIdByCanonicalVfsPath(list, canonical);
  } catch {
    return null;
  }
}
