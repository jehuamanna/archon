import { isWorkspaceMountNoteId } from "../shared/note-workspace";
import { getChildren, setChildren } from "./notes-store-core";

function computeRootRanges(children: string[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < children.length) {
    const id = children[i]!;
    if (isWorkspaceMountNoteId(id)) {
      ranges.push({ start: i, end: i + 1 });
      i += 1;
    } else {
      let j = i + 1;
      while (j < children.length && !isWorkspaceMountNoteId(children[j]!)) {
        j += 1;
      }
      ranges.push({ start: i, end: j });
      i = j;
    }
  }
  return ranges;
}

/**
 * Swap one root-level block (primary run of ids or a single `__archon_mount_*`) with its neighbor.
 * Block order matches sidebar project sections.
 */
export function swapWorkspaceRootBlock(
  blockIndex: number,
  direction: "up" | "down",
): { ok: true } | { ok: false; error: string } {
  const children = [...getChildren(null)];
  const ranges = computeRootRanges(children);
  if (blockIndex < 0 || blockIndex >= ranges.length) {
    return { ok: false, error: "Invalid block" };
  }
  const swapWith = direction === "up" ? blockIndex - 1 : blockIndex + 1;
  if (swapWith < 0 || swapWith >= ranges.length) {
    return { ok: false, error: "Cannot move further" };
  }
  const a = ranges[blockIndex]!;
  const b = ranges[swapWith]!;
  const aSlice = children.slice(a.start, a.end);
  const bSlice = children.slice(b.start, b.end);
  const lo = Math.min(a.start, b.start);
  const hi = Math.max(a.end, b.end);
  const before = children.slice(0, lo);
  const after = children.slice(hi);
  const mid =
    a.start < b.start ? [...bSlice, ...aSlice] : [...aSlice, ...bSlice];
  setChildren(null, [...before, ...mid, ...after]);
  return { ok: true };
}
