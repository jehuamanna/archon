import type { WpnNoteListItem, WpnNoteWithContextRow } from "./wpn-client.js";

export function normalizeVfsSegment(raw: string, fallback: string): string {
  const t = raw.trim();
  const base = t.length > 0 ? t : fallback;
  return base.replace(/\//g, "∕");
}

/**
 * Canonical 2-segment `Project/Title` for a notes-with-context row.
 * Pre-migration this was 3-segment `Workspace/Project/Title`; the workspace
 * prefix is gone with the org/team flatten and the shared note-vfs module
 * was already updated to match (commit f136420).
 */
export function canonicalVfsPathFromRow(
  row: Pick<WpnNoteWithContextRow, "project_name" | "title">,
): string {
  const proj = normalizeVfsSegment(row.project_name, "Project");
  const title = normalizeVfsSegment(row.title, "Untitled");
  return `${proj}/${title}`;
}

const HEADING_SLUG_RE = /^[a-z0-9-]+$/i;

export type ParsedVfsHash = {
  segments: string[];
  headingSlug?: string;
  kind: "rel-same-project" | "rel-tree" | "absolute";
};

export function parseVfsHashSegments(pathAfterW: string): ParsedVfsHash | null {
  const raw = pathAfterW.replace(/^\/+/, "");
  const decoded = raw
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
  if (decoded.length === 0) return null;

  const isRelSame = decoded[0] === ".";
  const isRelTree = decoded[0] === "..";
  const last = decoded[decoded.length - 1]!;

  let segments = decoded;
  let headingSlug: string | undefined;
  if (isRelTree) {
    let upCount = 0;
    while (upCount < decoded.length && decoded[upCount] === "..") upCount++;
    const downCount = decoded.length - upCount;
    if (downCount >= 2 && HEADING_SLUG_RE.test(last)) {
      segments = decoded.slice(0, -1);
      headingSlug = last;
    }
  } else if (isRelSame) {
    // ./Title or ./Title/heading-slug — heading present when 3+ parts and last matches.
    if (decoded.length >= 3 && HEADING_SLUG_RE.test(last)) {
      segments = decoded.slice(0, -1);
      headingSlug = last;
    }
  } else {
    // Absolute Project/Title or Project/Title/heading-slug — heading present
    // when 3+ parts and the last segment matches the slug pattern.
    if (decoded.length >= 3 && HEADING_SLUG_RE.test(last)) {
      segments = decoded.slice(0, -1);
      headingSlug = last;
    }
  }

  const kind: ParsedVfsHash["kind"] = isRelTree
    ? "rel-tree"
    : isRelSame
      ? "rel-same-project"
      : "absolute";

  return { segments, headingSlug, kind };
}

export type ResolveVfsContext = {
  catalogByCanonical: Map<string, string>;
  getProjectTree: (projectId: string) => Promise<WpnNoteListItem[]>;
};

export type ResolveVfsBase = Pick<
  WpnNoteWithContextRow,
  "id" | "project_id" | "project_name"
>;

export type VfsResolveResult =
  | { ok: true; noteId: string }
  | { ok: false; reason: string };

export async function resolveVfsHrefToNoteId(
  pathAfterW: string,
  base: ResolveVfsBase,
  ctx: ResolveVfsContext,
): Promise<VfsResolveResult> {
  const parsed = parseVfsHashSegments(pathAfterW);
  if (!parsed) return { ok: false, reason: "empty or malformed vfs path" };

  if (parsed.kind === "rel-same-project") {
    const titleSegs = parsed.segments.slice(1);
    if (titleSegs.length === 0) {
      return { ok: false, reason: "same-project ref has no title" };
    }
    if (titleSegs.length > 1) {
      return {
        ok: false,
        reason: "same-project ref with nested path not supported",
      };
    }
    const proj = normalizeVfsSegment(base.project_name, "Project");
    const title = normalizeVfsSegment(titleSegs[0]!, "Untitled");
    const canonical = `${proj}/${title}`;
    const hit = ctx.catalogByCanonical.get(canonical);
    return hit
      ? { ok: true, noteId: hit }
      : { ok: false, reason: `no note matched canonical ${canonical}` };
  }

  if (parsed.kind === "rel-tree") {
    let upCount = 0;
    while (upCount < parsed.segments.length && parsed.segments[upCount] === "..") {
      upCount++;
    }
    const downSegs = parsed.segments.slice(upCount);
    if (downSegs.length === 0) {
      return { ok: false, reason: "tree-relative ref has no target segment" };
    }
    const tree = await ctx.getProjectTree(base.project_id);
    const byId = new Map<string, WpnNoteListItem>();
    const childrenOf = new Map<string | null, WpnNoteListItem[]>();
    for (const n of tree) {
      byId.set(n.id, n);
      const arr = childrenOf.get(n.parent_id);
      if (arr) arr.push(n);
      else childrenOf.set(n.parent_id, [n]);
    }
    const baseRow = byId.get(base.id);
    if (!baseRow) {
      return { ok: false, reason: "base note not in its project tree" };
    }

    let currentParent: string | null = baseRow.parent_id;
    const seen = new Set<string>();
    for (let i = 1; i < upCount; i++) {
      if (!currentParent) {
        return { ok: false, reason: "walked above project root" };
      }
      if (seen.has(currentParent)) {
        return { ok: false, reason: "cycle in parent chain" };
      }
      seen.add(currentParent);
      const parent = byId.get(currentParent);
      if (!parent) {
        return { ok: false, reason: "broken parent chain" };
      }
      currentParent = parent.parent_id;
    }

    let currentId: string | null = currentParent;
    for (const seg of downSegs) {
      const children = childrenOf.get(currentId) ?? [];
      const wanted = normalizeVfsSegment(seg, "Untitled");
      const match = children.find(
        (c) => normalizeVfsSegment(c.title, "Untitled") === wanted,
      );
      if (!match) {
        return { ok: false, reason: `no child named ${seg}` };
      }
      currentId = match.id;
    }
    return currentId
      ? { ok: true, noteId: currentId }
      : { ok: false, reason: "empty resolve" };
  }

  // Absolute: Project/Title (2 segments, post-migration).
  if (parsed.segments.length < 2) {
    return { ok: false, reason: "absolute path needs Project/Title" };
  }
  const proj = normalizeVfsSegment(parsed.segments[0]!, "Project");
  const titleSegs = parsed.segments.slice(1);
  if (titleSegs.length > 1) {
    return { ok: false, reason: "nested titles in absolute path not supported" };
  }
  const title = normalizeVfsSegment(titleSegs[0]!, "Untitled");
  const canonical = `${proj}/${title}`;
  const hit = ctx.catalogByCanonical.get(canonical);
  return hit
    ? { ok: true, noteId: hit }
    : { ok: false, reason: `no note matched canonical ${canonical}` };
}
