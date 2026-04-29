import { norm } from "./resolve-note.js";
import type { WpnNoteListItem } from "./wpn-client.js";

export type ResolveParentOk = {
  ok: true;
  parentId: string;
  projectId: string;
};

export type ResolveParentNone = {
  ok: false;
  reason: "none";
  message: string;
};

export type ResolveParentAmbiguous = {
  ok: false;
  reason: "ambiguous";
  message: string;
  candidates: { noteId: string; path: string }[];
};

export type ResolveParentInTreeResult = ResolveParentOk | ResolveParentNone | ResolveParentAmbiguous;

function byIdMap(notes: WpnNoteListItem[]): Map<string, WpnNoteListItem> {
  const m = new Map<string, WpnNoteListItem>();
  for (const n of notes) {
    m.set(n.id, n);
  }
  return m;
}

function childrenByParent(notes: WpnNoteListItem[]): Map<string | null, WpnNoteListItem[]> {
  const m = new Map<string | null, WpnNoteListItem[]>();
  for (const n of notes) {
    const k = n.parent_id;
    const arr = m.get(k) ?? [];
    arr.push(n);
    m.set(k, arr);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.sibling_index - b.sibling_index);
  }
  return m;
}

/** Title chain from root to `noteId` (note titles only, slash-separated). */
export function noteTitlePath(noteId: string, byId: Map<string, WpnNoteListItem>): string {
  const segments: string[] = [];
  let cur: WpnNoteListItem | undefined = byId.get(noteId);
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur.id)) {
      break;
    }
    guard.add(cur.id);
    segments.unshift(cur.title);
    if (cur.parent_id === null) {
      break;
    }
    cur = byId.get(cur.parent_id);
  }
  return segments.join(" / ");
}

/**
 * Walk the project note tree: first segment matches a root (`parent_id === null`),
 * each further segment matches a direct child of the previous match. Titles use `norm` like `resolve-note.ts`.
 */
export function resolveParentInTree(
  notes: WpnNoteListItem[],
  parentPathTitles: string[],
): ResolveParentInTreeResult {
  if (parentPathTitles.length === 0) {
    return { ok: false, reason: "none", message: "parentPathTitles must include at least one title." };
  }

  const byId = byIdMap(notes);
  const children = childrenByParent(notes);
  let level: WpnNoteListItem[] = children.get(null) ?? [];

  for (let i = 0; i < parentPathTitles.length; i++) {
    const rawSeg = parentPathTitles[i]!;
    const want = norm(rawSeg);
    if (!want) {
      return {
        ok: false,
        reason: "none",
        message: `Empty title at segment index ${i} after normalization.`,
      };
    }
    const matches = level.filter((n) => norm(n.title) === want);
    if (matches.length === 0) {
      return {
        ok: false,
        reason: "none",
        message: `No note matched title "${rawSeg}" at depth ${i} (0 = project root note).`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message:
          "Multiple sibling notes share the same normalized title under the same parent; pass parentNoteId or disambiguate.",
        candidates: matches.map((n) => ({
          noteId: n.id,
          path: noteTitlePath(n.id, byId),
        })),
      };
    }
    const only = matches[0]!;
    if (i === parentPathTitles.length - 1) {
      return { ok: true, parentId: only.id, projectId: only.project_id };
    }
    level = children.get(only.id) ?? [];
  }

  return { ok: false, reason: "none", message: "Unexpected resolveParentInTree end state." };
}

export type ParsedParentWpnPath =
  | { ok: true; projectName: string; parentPathTitles: string[] }
  | { ok: false; error: string };

/**
 * Split on ` / ` (space-slash-space). Post-migration the wpn path is
 * 2-segment-rooted: `Project / Title1 / …` — no workspace prefix. Titles
 * containing the substring ` / ` cannot be represented here.
 */
export function parseParentWpnPath(s: string): ParsedParentWpnPath {
  const parts = s
    .split(" / ")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) {
    return {
      ok: false,
      error:
        'parentWpnPath must be "Project / Title1 / …" with project and at least one note title.',
    };
  }
  return {
    ok: true,
    projectName: parts[0]!,
    parentPathTitles: parts.slice(1),
  };
}
