import type { DragEvent } from "react";
import type { CreateNoteRelation, NoteListItem, NoteMovePlacement } from "@archon/ui-types";
import { normalizeVfsSegment } from "../../shared/note-vfs-path";
import { isWorkspaceMountNoteId, workspaceFolderPathForNote } from "../../shared/note-workspace";

export const DND_NOTE_MIME = "application/x-archon-note-id";
export const DND_NOTE_IDS_MIME = "application/x-archon-note-ids";
export const COLLAPSED_STORAGE_KEY = "archon-sidebar-collapsed-ids";
export const WORKSPACE_SECTION_EXPANDED_KEY = "archon-workspace-section-expanded";
export const WORKSPACE_MOUNT_ROW_RE = /^__archon_mount_\d+$/;

export type ContextMenuState = {
  x: number;
  y: number;
  anchorId: string | null;
  workspaceProjectRoot?: string | null;
  step: "main" | "pickType" | "pickMoveTarget";
  pickRelation?: CreateNoteRelation;
};

export type ClipboardState = { mode: "cut" | "copy"; sourceId: string } | null;

/** `sectionKey` scopes the indicator to one project panel (resolved workspace root path). */
export type DropHint = {
  targetId: string;
  placement: NoteMovePlacement;
  sectionKey: string;
};

export const ctxBtn =
  "block w-full rounded-sm px-2.5 py-1.5 text-left text-[12px] text-popover-foreground outline-none hover:bg-accent hover:text-accent-foreground transition-colors duration-150";

export function folderDisplayName(absPath: string): string {
  const norm = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = norm.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : absPath;
}

/** Custom label from prefs (if any), else folder basename. */
export function workspaceFolderLabel(
  absPath: string,
  labels: Record<string, string> | undefined,
): string {
  if (!labels || Object.keys(labels).length === 0) {
    return folderDisplayName(absPath);
  }
  const direct = labels[absPath];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const norm = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const [k, v] of Object.entries(labels)) {
    const kn = k.replace(/\\/g, "/").replace(/\/+$/, "");
    if (kn === norm && v.trim().length > 0) {
      return v.trim();
    }
  }
  return folderDisplayName(absPath);
}

/** Filesystem sidebar: workspace label + ancestor titles to the mount, joined with ` / `. */
export function filesystemNoteDisplayPath(args: {
  noteId: string;
  notes: NoteListItem[];
  parents: Map<string, string | null>;
  workspaceRoots: string[];
  workspaceLabels: Record<string, string>;
}): string | null {
  const { noteId, notes, parents, workspaceRoots, workspaceLabels } = args;
  const projectRoot = workspaceFolderPathForNote(noteId, workspaceRoots);
  if (!projectRoot) {
    return null;
  }
  const firstSeg = workspaceFolderLabel(projectRoot, workspaceLabels);
  const titleSegments: string[] = [];
  let cur: string | null = noteId;
  while (cur != null && !isWorkspaceMountNoteId(cur)) {
    const n = notes.find((x) => x.id === cur);
    if (!n) {
      return null;
    }
    titleSegments.unshift(normalizeVfsSegment(n.title, "Untitled"));
    cur = parents.get(cur) ?? null;
  }
  if (titleSegments.length === 0) {
    return firstSeg;
  }
  return [firstSeg, ...titleSegments].join(" / ");
}

export function parentMapFromNotes(notes: NoteListItem[]): Map<string, string | null> {
  return new Map(notes.map((n) => [n.id, n.parentId]));
}

export function readCollapsedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const a = JSON.parse(raw) as unknown;
    if (!Array.isArray(a)) {
      return new Set();
    }
    return new Set(a.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function writeCollapsedIds(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

export function readWorkspaceSectionExpandedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(WORKSPACE_SECTION_EXPANDED_KEY);
    if (!raw) {
      return {};
    }
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object") {
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "boolean") {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeWorkspaceSectionExpandedMap(m: Record<string, boolean>): void {
  try {
    localStorage.setItem(WORKSPACE_SECTION_EXPANDED_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

export function minimalSelectedRoots(
  selected: Set<string>,
  parents: Map<string, string | null>,
): string[] {
  const arr = [...selected];
  const out: string[] = [];
  for (const id of arr) {
    let p = parents.get(id) ?? null;
    let under = false;
    while (p) {
      if (selected.has(p)) {
        under = true;
        break;
      }
      p = parents.get(p) ?? null;
    }
    if (!under) {
      out.push(id);
    }
  }
  return [...new Set(out)];
}

export function visibleNotesList(
  notes: NoteListItem[],
  collapsedIds: Set<string>,
  parents: Map<string, string | null>,
): NoteListItem[] {
  function anyAncestorCollapsed(id: string): boolean {
    let p = parents.get(id) ?? null;
    while (p) {
      if (collapsedIds.has(p)) {
        return true;
      }
      p = parents.get(p) ?? null;
    }
    return false;
  }
  return notes.filter((n) => !anyAncestorCollapsed(n.id));
}

export function isStrictAncestor(
  ancestorId: string,
  nodeId: string,
  parents: Map<string, string | null>,
): boolean {
  let cur: string | null = nodeId;
  while (cur != null) {
    const p = parents.get(cur);
    if (p === ancestorId) {
      return true;
    }
    cur = p ?? null;
  }
  return false;
}

export function parseDragIds(e: DragEvent): string[] {
  const bulk = e.dataTransfer.getData(DND_NOTE_IDS_MIME);
  if (bulk) {
    try {
      const a = JSON.parse(bulk) as unknown;
      if (Array.isArray(a)) {
        return a.filter((x): x is string => typeof x === "string");
      }
    } catch {
      /* fall through */
    }
  }
  const one =
    e.dataTransfer.getData(DND_NOTE_MIME) ||
    e.dataTransfer.getData("text/plain");
  return one ? [one] : [];
}

export function clipboardTouchesDeleted(
  sourceId: string,
  deletedRoots: string[],
  parents: Map<string, string | null>,
): boolean {
  for (const root of deletedRoots) {
    if (sourceId === root || isStrictAncestor(root, sourceId, parents)) {
      return true;
    }
  }
  return false;
}
