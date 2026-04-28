/**
 * Visibility predicate for the WPN explorer's nested-note tree.
 *
 * `expandedNoteParents` is the set of notes whose subtree the user has
 * opened. A note is rendered iff *every* ancestor on its path to the root
 * is in that set — checking only the immediate parent (the pre-fix
 * behaviour) would leak descendants when the user collapses a higher
 * ancestor whose children were left individually expanded (Bug-f08b02).
 *
 * Pure helper so we can unit-test the walk without spinning up the panel
 * component. `parentMap` maps `noteId → parentId | null` (top-level notes
 * map to `null`).
 */
export function isNoteVisibleInTree(
  noteId: string,
  parentMap: Map<string, string | null>,
  expandedNoteParents: ReadonlySet<string>,
): boolean {
  let cur = parentMap.get(noteId) ?? null;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) {
      // Defensive: cycle in parentMap should be impossible but bail out
      // rather than spin forever.
      return false;
    }
    seen.add(cur);
    if (!expandedNoteParents.has(cur)) {
      return false;
    }
    cur = parentMap.get(cur) ?? null;
  }
  return true;
}

/**
 * After the project-tree fetch returns a fresh `noteIds` list, drop any
 * ids in the local `expandedNoteParents` set that no longer exist (the
 * matching notes were deleted, moved out of the project, etc.). Pure
 * function — caller owns the resulting Set.
 *
 * Replaces `mergeWpnExpandedNoteParents` for the load path: server
 * persistence of expanded state is intentionally not restored on refresh
 * (Bug-fdcaf4 — user wants the tree to start fully collapsed every page
 * load and rely on the auto-reveal of the currently-open note's path).
 * The prune still runs so a long-lived session that has had notes
 * deleted underneath it doesn't keep stale ids around forever.
 */
export function pruneExpandedNoteParents(
  prev: ReadonlySet<string>,
  noteIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const id of prev) {
    if (noteIds.has(id)) out.add(id);
  }
  return out;
}
