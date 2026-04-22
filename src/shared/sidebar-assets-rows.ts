/**
 * Group notes + per-project Assets into one collapsible section per workspace root.
 * Primary folder has no mount row; added folders use a synthetic mount id for DnD only — the header UI matches primary (folder label).
 */

import type { NoteListItem } from "../preload";

export type SidebarNoteRow = {
  kind: "note";
  note: NoteListItem;
};

export type SidebarAssetsRow = {
  kind: "assets";
  projectRoot: string;
  depth: number;
  key: string;
};

export type SidebarRow = SidebarNoteRow | SidebarAssetsRow;

export type SidebarWorkspaceSection = {
  projectRoot: string;
  /** Stable id for localStorage (path, or path + first note id for a primary block). */
  sectionKey: string;
  /** Added-folder mount row; rendered as section header + DnD target. Null for primary. */
  mountNote: NoteListItem | null;
  /** Subtract from row depth for padding inside this section (hides mount level). */
  depthTrim: number;
  innerRows: SidebarRow[];
  /** Index in root-level block order (primary run + each mount); used for ↑↓ reorder. */
  workspaceBlockIndex: number;
  workspaceBlockCount: number;
};

function isMountId(id: string): boolean {
  return /^__archon_mount_\d+$/.test(id);
}

function mountSlot(id: string): number {
  const m = /^__archon_mount_(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** @deprecated Use buildWorkspaceSidebarSections for UI; kept for single-list callers if any */
export function mergeNotesWithProjectAssetsRows(
  visibleNotes: NoteListItem[],
  workspaceRoots: string[],
): SidebarRow[] {
  const sections = buildWorkspaceSidebarSections(visibleNotes, workspaceRoots);
  const out: SidebarRow[] = [];
  for (const s of sections) {
    if (s.mountNote) {
      out.push({ kind: "note", note: s.mountNote });
    }
    out.push(...s.innerRows);
  }
  return out;
}

/**
 * Split merged visible notes into one section per root-level tree block (depth-first segment at depth 0).
 * Supports any order of primary vs attached folders under `parentId === null`.
 */
export function buildWorkspaceSidebarSections(
  visibleNotes: NoteListItem[],
  workspaceRoots: string[],
): SidebarWorkspaceSection[] {
  if (workspaceRoots.length === 0) {
    return [];
  }

  const root0 = workspaceRoots[0]!;
  const segments: NoteListItem[][] = [];
  for (const n of visibleNotes) {
    if (n.depth === 0) {
      segments.push([n]);
    } else if (segments.length > 0) {
      segments[segments.length - 1]!.push(n);
    }
  }

  const sections: SidebarWorkspaceSection[] = [];
  const blockCount = segments.length;

  for (let bi = 0; bi < segments.length; bi++) {
    const seg = segments[bi]!;
    const head = seg[0]!;
    if (isMountId(head.id)) {
      const slot = mountSlot(head.id);
      const pr = workspaceRoots[slot];
      if (!pr) {
        continue;
      }
      const mountNote = head;
      const d0 = mountNote.depth;
      const childNotes = seg.slice(1);
      const innerRows: SidebarRow[] = [];
      for (const n of childNotes) {
        innerRows.push({ kind: "note", note: n });
      }
      innerRows.push({
        kind: "assets",
        projectRoot: pr,
        depth: d0 + 1,
        key: `assets:${pr}:${slot}`,
      });
      sections.push({
        projectRoot: pr,
        sectionKey: pr,
        mountNote,
        depthTrim: d0 + 1,
        innerRows,
        workspaceBlockIndex: bi,
        workspaceBlockCount: blockCount,
      });
    } else {
      const primaryInner: SidebarRow[] = [];
      for (const n of seg) {
        primaryInner.push({ kind: "note", note: n });
      }
      const primaryNoteDepth =
        seg.length > 0 ? Math.min(...seg.map((n) => n.depth)) : 0;
      primaryInner.push({
        kind: "assets",
        projectRoot: root0,
        depth: seg.length > 0 ? primaryNoteDepth + 1 : 0,
        key: `assets:${root0}:${head.id}`,
      });
      sections.push({
        projectRoot: root0,
        sectionKey: `${root0}#${head.id}`,
        mountNote: null,
        depthTrim: primaryNoteDepth,
        innerRows: primaryInner,
        workspaceBlockIndex: bi,
        workspaceBlockCount: blockCount,
      });
    }
  }

  return sections;
}
