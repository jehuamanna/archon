/**
 * Tree move logic for WPN writes.
 */
export type NoteMovePlacement = "before" | "after" | "into";

export type WpnNoteRowLite = {
  id: string;
  parent_id: string | null;
  sibling_index: number;
};

function parentMapFromRows(rows: WpnNoteRowLite[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const r of rows) {
    m.set(r.id, r.parent_id);
  }
  return m;
}

function isStrictDescendantOf(
  parentOf: Map<string, string | null>,
  ancestor: string,
  node: string,
): boolean {
  let cur: string | null | undefined = parentOf.get(node);
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestor) {
      return true;
    }
    if (seen.has(cur)) {
      break;
    }
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

function buildChildMap(rows: WpnNoteRowLite[]): Map<string | null, string[]> {
  const m = new Map<string | null, string[]>();
  for (const r of rows) {
    const k = r.parent_id;
    const arr = m.get(k) ?? [];
    arr.push(r.id);
    m.set(k, arr);
  }
  for (const [k, arr] of m) {
    const order = new Map(
      rows.filter((x) => x.parent_id === k).map((x) => [x.id, x.sibling_index]),
    );
    arr.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  return m;
}

export function wpnComputeChildMapAfterMove(
  rows: WpnNoteRowLite[],
  draggedId: string,
  targetId: string,
  placement: NoteMovePlacement,
): Map<string | null, string[]> {
  if (draggedId === targetId) {
    return buildChildMap(rows);
  }
  const idSet = new Set(rows.map((r) => r.id));
  if (!idSet.has(draggedId) || !idSet.has(targetId)) {
    throw new Error("Note not found");
  }
  const parentOf = parentMapFromRows(rows);
  if (isStrictDescendantOf(parentOf, draggedId, targetId)) {
    throw new Error("Cannot move relative to a node inside the dragged subtree");
  }
  const childMap = buildChildMap(rows);

  const findParentKey = (id: string): string | null => {
    for (const [p, kids] of childMap) {
      if (kids.includes(id)) {
        return p;
      }
    }
    return null;
  };

  const draggedParent = findParentKey(draggedId);
  const dp = [...(childMap.get(draggedParent) ?? [])];
  const di = dp.indexOf(draggedId);
  if (di >= 0) {
    dp.splice(di, 1);
  }
  childMap.set(draggedParent, dp);

  const targetParent = findParentKey(targetId);

  if (placement === "into") {
    const kids = [...(childMap.get(targetId) ?? [])];
    kids.push(draggedId);
    childMap.set(targetId, kids);
  } else {
    const sibs = [...(childMap.get(targetParent) ?? [])];
    const tIdx = sibs.indexOf(targetId);
    if (tIdx < 0) {
      sibs.push(draggedId);
    } else {
      const ins = placement === "before" ? tIdx : tIdx + 1;
      sibs.splice(ins, 0, draggedId);
    }
    childMap.set(targetParent, sibs);
  }

  return childMap;
}
