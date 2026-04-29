/**
 * Sync-api mirror of the post-migration `note-vfs-*` link-rewrite logic.
 *
 * The canonical implementation lives in:
 *   - src/shared/note-vfs-path.ts
 *   - src/shared/note-vfs-link-rewrite.ts
 *   - src/shared/markdown-internal-note-href.ts
 *
 * This module is a structural copy used by `/wpn/notes/:id/preview-title-change`.
 * Sync-api convention is to mirror shared types/logic rather than import the
 * root `src/shared/` tree (cross-workspace dependency); the mirror MUST stay
 * in lockstep with the canonical files.
 *
 * Path scheme is post-flatten: `Project/Title` (was `Workspace/Project/Title`
 * pre-org/team migration).
 */

// ── note-vfs-path ─────────────────────────────────────────────────────────

export function normalizeVfsSegment(raw: string, fallback: string): string {
  const t = raw.trim();
  const base = t.length > 0 ? t : fallback;
  return base.replace(/\//g, "∕");
}

export function canonicalVfsPathFromLinkRow(row: {
  projectName: string;
  title: string;
}): string {
  const proj = normalizeVfsSegment(row.projectName, "Project");
  const title = normalizeVfsSegment(row.title, "Untitled");
  return `${proj}/${title}`;
}

export function isSameProjectRelativeVfsPath(vfsPath: string): boolean {
  const t = vfsPath.trim();
  return t === "." || t.startsWith("./");
}

export function isTreeRelativeVfsPath(vfsPath: string): boolean {
  const t = vfsPath.trim();
  return t === ".." || t.startsWith("../");
}

export function markdownVfsNoteHref(
  canonicalPath: string,
  markdownHeadingSlug?: string,
): string {
  const parts = canonicalPath.split("/").filter((p) => p.length > 0);
  const enc = parts.map((p) => encodeURIComponent(p)).join("/");
  return markdownHeadingSlug && /^[a-z0-9-]+$/i.test(markdownHeadingSlug)
    ? `#/w/${enc}/${markdownHeadingSlug}`
    : `#/w/${enc}`;
}

export type ParsedVfsNoteHash = {
  vfsPath: string;
  markdownHeadingSlug?: string;
};

export function parseVfsNoteHashPath(
  pathAfterW: string,
): ParsedVfsNoteHash | null {
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
    let upCount = 0;
    while (upCount < parts.length && parts[upCount] === "..") upCount++;
    const downParts = parts.slice(upCount);
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
  if (parts.length >= 3 && /^[a-z0-9-]+$/i.test(last)) {
    return { vfsPath: parts.slice(0, -1).join("/"), markdownHeadingSlug: last };
  }
  return { vfsPath: parts.join("/") };
}

// ── markdown-internal-note-href (parse only — sufficient for rewrites) ────

type InternalMarkdownNoteLink =
  | { kind: "noteId"; noteId: string; markdownHeadingSlug?: string }
  | { kind: "vfs"; vfsPath: string; markdownHeadingSlug?: string };

export function parseInternalMarkdownNoteLink(
  href: string,
): InternalMarkdownNoteLink | null {
  const raw = href.trim();
  if (!raw) return null;
  let path = raw;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) {
    path = path.slice(hashIdx + 1);
  }
  path = path.replace(/^\/+/, "");
  if (path.startsWith("w/")) {
    const rest = path.slice("w/".length);
    const parsed = parseVfsNoteHashPath(rest);
    if (!parsed?.vfsPath) return null;
    return {
      kind: "vfs",
      vfsPath: parsed.vfsPath,
      markdownHeadingSlug: parsed.markdownHeadingSlug,
    };
  }
  if (path.startsWith("n/")) {
    const rest = path.slice("n/".length);
    const parts = rest
      .split("/")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const noteId = parts[0];
    if (!noteId) return null;
    const slug = parts[1];
    if (slug && !/^[a-z0-9-]+$/i.test(slug)) {
      return { kind: "noteId", noteId };
    }
    return slug
      ? { kind: "noteId", noteId, markdownHeadingSlug: slug }
      : { kind: "noteId", noteId };
  }
  return null;
}

// ── note-vfs-link-rewrite ─────────────────────────────────────────────────

export function vfsCanonicalPathsForTitleChange(
  ctx: { project_name: string },
  oldTitle: string,
  newTitle: string,
): { oldCanonical: string; newCanonical: string } | null {
  const oldCanonical = canonicalVfsPathFromLinkRow({
    projectName: ctx.project_name,
    title: oldTitle,
  });
  const newCanonical = canonicalVfsPathFromLinkRow({
    projectName: ctx.project_name,
    title: newTitle,
  });
  if (oldCanonical === newCanonical) return null;
  return { oldCanonical, newCanonical };
}

function replaceInternalHref(
  href: string,
  oldCanonical: string,
  newCanonical: string,
): string | null {
  const p = parseInternalMarkdownNoteLink(href);
  if (p?.kind !== "vfs" || p.vfsPath !== oldCanonical) return null;
  return markdownVfsNoteHref(newCanonical, p.markdownHeadingSlug);
}

function replaceRelativeSameProjectTitleHref(
  href: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string | null {
  const p = parseInternalMarkdownNoteLink(href);
  if (p?.kind !== "vfs" || !isSameProjectRelativeVfsPath(p.vfsPath)) return null;
  const rest = p.vfsPath.trim() === "." ? "" : p.vfsPath.trim().slice(2).trim();
  const seg = normalizeVfsSegment(rest.length > 0 ? rest : "Untitled", "Untitled");
  if (seg !== oldTitleSeg) return null;
  return markdownVfsNoteHref(`./${newTitleSeg}`, p.markdownHeadingSlug);
}

function replaceTreeRelativeTitleHref(
  href: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string | null {
  const p = parseInternalMarkdownNoteLink(href);
  if (p?.kind !== "vfs" || !isTreeRelativeVfsPath(p.vfsPath)) return null;
  const segments = p.vfsPath.split("/").filter((s) => s.length > 0);
  const lastSeg = segments[segments.length - 1];
  if (!lastSeg || lastSeg === "..") return null;
  const normalized = normalizeVfsSegment(lastSeg, "Untitled");
  if (normalized !== oldTitleSeg) return null;
  segments[segments.length - 1] = newTitleSeg;
  return markdownVfsNoteHref(segments.join("/"), p.markdownHeadingSlug);
}

const MARKDOWN_LINK_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g;
const DOCLINK_TAG_RE = /<DocLink\b([\s\S]*?)(\/>|>)/gi;
const DOCLINK_TO_ATTR_RE = /\bto=(?:"([^"]*)"|'([^']*)')/;
const DOCLINK_TO_REPLACE_RE = /\bto=(?:"[^"]*"|'[^']*')/;

function rewriteMarkdownLinkHrefs(
  segment: string,
  oldCanonical: string,
  newCanonical: string,
  oldTitle?: string,
  newTitle?: string,
): string {
  return segment.replace(
    MARKDOWN_LINK_RE,
    (match, bang, label, href, titlePart) => {
      const nh = replaceInternalHref(
        String(href).trim(),
        oldCanonical,
        newCanonical,
      );
      if (nh === null) return match;
      const nl =
        oldTitle && newTitle && String(label).trim() === oldTitle.trim()
          ? newTitle.trim()
          : label;
      return `${bang}[${nl}](${nh}${titlePart ?? ""})`;
    },
  );
}

function rewriteDocLinkToAttrs(
  segment: string,
  oldCanonical: string,
  newCanonical: string,
): string {
  return segment.replace(DOCLINK_TAG_RE, (full, inner, end) => {
    const m = DOCLINK_TO_ATTR_RE.exec(inner);
    if (!m) return full;
    const q = m[0].includes('"') ? '"' : "'";
    const raw = (m[1] ?? m[2] ?? "").trim();
    const nh = replaceInternalHref(raw, oldCanonical, newCanonical);
    if (nh === null) return full;
    const nextInner = inner.replace(DOCLINK_TO_REPLACE_RE, `to=${q}${nh}${q}`);
    return `<DocLink${nextInner}${end}`;
  });
}

function rewriteVfsLinksInPlainSegment(
  segment: string,
  oldCanonical: string,
  newCanonical: string,
  oldTitle?: string,
  newTitle?: string,
): string {
  let s = rewriteMarkdownLinkHrefs(
    segment,
    oldCanonical,
    newCanonical,
    oldTitle,
    newTitle,
  );
  s = rewriteDocLinkToAttrs(s, oldCanonical, newCanonical);
  return s;
}

export function rewriteVfsCanonicalLinksInMarkdown(
  content: string,
  oldCanonical: string,
  newCanonical: string,
  oldTitle?: string,
  newTitle?: string,
): string {
  if (oldCanonical === newCanonical) return content;
  const parts = content.split(/(```[\s\S]*?```)/g);
  return parts
    .map((chunk, i) =>
      i % 2 === 1
        ? chunk
        : rewriteVfsLinksInPlainSegment(
            chunk,
            oldCanonical,
            newCanonical,
            oldTitle,
            newTitle,
          ),
    )
    .join("");
}

function rewriteRelativeTitleInPlainSegment(
  segment: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string {
  let s = segment.replace(
    MARKDOWN_LINK_RE,
    (match, bang, label, href, titlePart) => {
      const nh = replaceRelativeSameProjectTitleHref(
        String(href).trim(),
        oldTitleSeg,
        newTitleSeg,
      );
      if (nh === null) return match;
      const nl =
        String(label).trim() === oldTitleSeg.trim() ? newTitleSeg.trim() : label;
      return `${bang}[${nl}](${nh}${titlePart ?? ""})`;
    },
  );
  s = s.replace(DOCLINK_TAG_RE, (full, inner, end) => {
    const m = DOCLINK_TO_ATTR_RE.exec(inner);
    if (!m) return full;
    const q = m[0].includes('"') ? '"' : "'";
    const raw = (m[1] ?? m[2] ?? "").trim();
    const nh = replaceRelativeSameProjectTitleHref(raw, oldTitleSeg, newTitleSeg);
    if (nh === null) return full;
    const nextInner = inner.replace(DOCLINK_TO_REPLACE_RE, `to=${q}${nh}${q}`);
    return `<DocLink${nextInner}${end}`;
  });
  return s;
}

export function rewriteRelativeSameProjectTitleLinksInMarkdown(
  content: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string {
  if (oldTitleSeg === newTitleSeg) return content;
  const parts = content.split(/(```[\s\S]*?```)/g);
  return parts
    .map((chunk, i) =>
      i % 2 === 1
        ? chunk
        : rewriteRelativeTitleInPlainSegment(chunk, oldTitleSeg, newTitleSeg),
    )
    .join("");
}

export function rewriteTreeRelativeTitleLinksInMarkdown(
  content: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string {
  if (oldTitleSeg === newTitleSeg) return content;
  const parts = content.split(/(```[\s\S]*?```)/g);
  return parts
    .map((chunk, i) =>
      i % 2 === 1
        ? chunk
        : chunk.replace(
            MARKDOWN_LINK_RE,
            (match, bang, label, href, titlePart) => {
              const nh = replaceTreeRelativeTitleHref(
                String(href).trim(),
                oldTitleSeg,
                newTitleSeg,
              );
              if (nh === null) return match;
              const nl =
                String(label).trim() === oldTitleSeg.trim()
                  ? newTitleSeg.trim()
                  : label;
              return `${bang}[${nl}](${nh}${titlePart ?? ""})`;
            },
          ),
    )
    .join("");
}

/**
 * Apply canonical-path rewrites + same-project / tree-relative title
 * rewrites when `rowProjectId === renamedProjectId`.
 */
export function rewriteMarkdownForWpnNoteTitleChange(
  content: string,
  rowProjectId: string,
  renamedProjectId: string,
  oldCanonical: string,
  newCanonical: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string {
  let s = rewriteVfsCanonicalLinksInMarkdown(
    content,
    oldCanonical,
    newCanonical,
    oldTitleSeg,
    newTitleSeg,
  );
  if (rowProjectId === renamedProjectId) {
    s = rewriteRelativeSameProjectTitleLinksInMarkdown(s, oldTitleSeg, newTitleSeg);
    s = rewriteTreeRelativeTitleLinksInMarkdown(s, oldTitleSeg, newTitleSeg);
  }
  return s;
}
