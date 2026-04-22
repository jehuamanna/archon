import type { WpnNoteWithContextListItem } from "./wpn-v2-types";

/** Same-project-relative links use a leading `./` segment (e.g. `./OtherNote`). */
export function isSameProjectRelativeVfsPath(vfsPath: string): boolean {
  const t = vfsPath.trim();
  return t === "." || t.startsWith("./");
}

/**
 * Maps `./Title` (same project as `base`) to canonical `Workspace/Project/Title`.
 */
export function resolveSameProjectRelativeVfsToCanonical(
  vfsPath: string,
  base: Pick<WpnNoteWithContextListItem, "workspace_name" | "project_name">,
): string | null {
  const t = vfsPath.trim();
  if (!isSameProjectRelativeVfsPath(t)) {
    return null;
  }
  const rest = t === "." ? "" : t.slice(2).trim();
  const titleSeg = normalizeVfsSegment(rest.length > 0 ? rest : "Untitled", "Untitled");
  const ws = normalizeVfsSegment(base.workspace_name, "Workspace");
  const proj = normalizeVfsSegment(base.project_name, "Project");
  return `${ws}/${proj}/${titleSeg}`;
}

/** Single path segment: no raw `/` (replaced) so joined paths stay unambiguous. */
export function normalizeVfsSegment(raw: string, fallback: string): string {
  const t = raw.trim();
  const base = t.length > 0 ? t : fallback;
  return base.replace(/\//g, "\u2215");
}

/** Canonical `Workspace/Project/Title` matching explorer link rows. */
export function canonicalVfsPathFromNoteContext(n: WpnNoteWithContextListItem): string {
  const ws = normalizeVfsSegment(n.workspace_name, "Workspace");
  const proj = normalizeVfsSegment(n.project_name, "Project");
  const title = normalizeVfsSegment(n.title, "Untitled");
  return `${ws}/${proj}/${title}`;
}

export function canonicalVfsPathFromLinkRow(row: {
  workspaceName: string;
  projectName: string;
  title: string;
}): string {
  const ws = normalizeVfsSegment(row.workspaceName, "Workspace");
  const proj = normalizeVfsSegment(row.projectName, "Project");
  const title = normalizeVfsSegment(row.title, "Untitled");
  return `${ws}/${proj}/${title}`;
}

/** Human- and MCP-aligned path: `Workspace / Project / Title` with normalized segments. */
export function displayWpnNotePathParts(
  workspaceName: string,
  projectName: string,
  title: string,
): string {
  const ws = normalizeVfsSegment(workspaceName, "Workspace");
  const proj = normalizeVfsSegment(projectName, "Project");
  const t = normalizeVfsSegment(title, "Untitled");
  return `${ws} / ${proj} / ${t}`;
}

export function resolveNoteIdByCanonicalVfsPath(
  notes: readonly WpnNoteWithContextListItem[],
  canonicalPath: string,
): string | null {
  const target = canonicalPath.trim();
  if (!target) return null;
  for (const n of notes) {
    if (canonicalVfsPathFromNoteContext(n) === target) return n.id;
  }
  return null;
}

/** `#/w/<segment>/<segment>/...` optional trailing heading slug (same rules as note id hashes). */
export function markdownVfsNoteHref(canonicalPath: string, markdownHeadingSlug?: string): string {
  const parts = canonicalPath.split("/").filter((p) => p.length > 0);
  const enc = parts.map((p) => encodeURIComponent(p)).join("/");
  return markdownHeadingSlug && /^[a-z0-9-]+$/i.test(markdownHeadingSlug)
    ? `#/w/${enc}/${markdownHeadingSlug}`
    : `#/w/${enc}`;
}

/** VFS link to another note in the same project using `./Title` (shorter than full Workspace/Project/Title). */
export function markdownVfsNoteHrefSameProjectRelative(
  titleSegment: string,
  markdownHeadingSlug?: string,
): string {
  const seg = normalizeVfsSegment(titleSegment, "Untitled");
  return markdownVfsNoteHref(`./${seg}`, markdownHeadingSlug);
}

/** Tree-relative paths start with `../` (e.g. `../sibling`, `../../uncle`, `../sibling/child`). */
export function isTreeRelativeVfsPath(vfsPath: string): boolean {
  const t = vfsPath.trim();
  return t === ".." || t.startsWith("../");
}

/**
 * Resolve a tree-relative path (`../sibling`, `../../uncle`, `../sibling/child`)
 * by walking the note tree from the base note.
 *
 * - Each `..` segment walks up one level via `parent_id`.
 * - Remaining segments walk down by matching child titles.
 *
 * Returns the resolved note's canonical VFS path, or `null` if unresolvable.
 */
export function resolveTreeRelativeVfsPath(
  vfsPath: string,
  baseNoteId: string,
  notes: readonly WpnNoteWithContextListItem[],
): string | null {
  const t = vfsPath.trim();
  if (!isTreeRelativeVfsPath(t)) return null;

  const segments = t.split("/").filter((s) => s.length > 0);
  // Count leading ".." segments
  let upCount = 0;
  while (upCount < segments.length && segments[upCount] === "..") {
    upCount++;
  }
  const downSegments = segments.slice(upCount);
  if (downSegments.length === 0) return null; // bare ".." with no target

  // Build lookup maps
  const byId = new Map<string, WpnNoteWithContextListItem>();
  const childrenOf = new Map<string | null, WpnNoteWithContextListItem[]>();
  for (const n of notes) {
    byId.set(n.id, n);
    const key = n.parent_id;
    const arr = childrenOf.get(key);
    if (arr) arr.push(n);
    else childrenOf.set(key, [n]);
  }

  // Walk up from base note
  const base = byId.get(baseNoteId);
  if (!base) return null;

  let currentId: string | null = base.parent_id;
  const seen = new Set<string>();
  for (let i = 1; i < upCount; i++) {
    // First ".." already moves to parent; additional ".." climb further
    if (!currentId) return null;
    if (seen.has(currentId)) return null; // cycle
    seen.add(currentId);
    const parentNote = byId.get(currentId);
    if (!parentNote) return null;
    currentId = parentNote.parent_id;
  }

  // Walk down by matching child titles
  for (const seg of downSegments) {
    const children = childrenOf.get(currentId) ?? [];
    const normalizedSeg = normalizeVfsSegment(seg, "Untitled");
    const match = children.find(
      (c) => normalizeVfsSegment(c.title, "Untitled") === normalizedSeg,
    );
    if (!match) return null;
    currentId = match.id;
  }

  if (!currentId) return null;
  const resolved = byId.get(currentId);
  if (!resolved) return null;
  return canonicalVfsPathFromNoteContext(resolved);
}

/** Generate a tree-relative VFS href (e.g. `#/w/../sibling`). */
export function markdownVfsNoteHrefTreeRelative(
  treeRelativePath: string,
  markdownHeadingSlug?: string,
): string {
  const parts = treeRelativePath.split("/").filter((p) => p.length > 0);
  const enc = parts.map((p) => encodeURIComponent(p)).join("/");
  return markdownHeadingSlug && /^[a-z0-9-]+$/i.test(markdownHeadingSlug)
    ? `#/w/${enc}/${markdownHeadingSlug}`
    : `#/w/${enc}`;
}

export type ParsedVfsNoteHash = {
  vfsPath: string;
  markdownHeadingSlug?: string;
};

export function parseVfsNoteHashPath(pathAfterW: string): ParsedVfsNoteHash | null {
  const parts = pathAfterW
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1]!;
  const isRel = parts[0] === ".";
  const isTreeRel = parts[0] === "..";
  if (isTreeRel) {
    // Tree-relative: ../sibling, ../../uncle, ../sibling/child
    // Count non-".." segments after the leading ".." segments to determine heading slug
    let upCount = 0;
    while (upCount < parts.length && parts[upCount] === "..") upCount++;
    const downParts = parts.slice(upCount);
    // Need at least one down segment (the target title); heading slug if 2+ down segments and last matches slug pattern
    if (downParts.length >= 2 && /^[a-z0-9-]+$/i.test(last)) {
      return { vfsPath: parts.slice(0, -1).join("/"), markdownHeadingSlug: last };
    }
    return { vfsPath: parts.join("/") };
  }
  if (isRel) {
    if (parts.length >= 3 && /^[a-z0-9-]+$/i.test(last)) {
      return { vfsPath: parts.slice(0, -1).join("/"), markdownHeadingSlug: last };
    }
    return { vfsPath: parts.join("/") };
  }
  if (parts.length >= 4 && /^[a-z0-9-]+$/i.test(last)) {
    return { vfsPath: parts.slice(0, -1).join("/"), markdownHeadingSlug: last };
  }
  return { vfsPath: parts.join("/") };
}
