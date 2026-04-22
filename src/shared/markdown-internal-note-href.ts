import {
  markdownVfsNoteHref,
  parseVfsNoteHashPath,
} from "./note-vfs-path";

export type InternalMarkdownNoteLink =
  | { kind: "noteId"; noteId: string; markdownHeadingSlug?: string }
  | { kind: "vfs"; vfsPath: string; markdownHeadingSlug?: string };

/**
 * Parses a markdown link `href` that targets another note via shell hash routes.
 * Supports `#/n/<id>[/slug]`, `#/w/<vfs path>[/slug]`, `/n/…`, `n/…`, `w/…`, and absolute URLs whose hash uses those forms.
 */
export function parseInternalMarkdownNoteLink(href: string): InternalMarkdownNoteLink | null {
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

export function parseNoteIdFromInternalMarkdownHref(href: string): string | null {
  const p = parseInternalMarkdownNoteLink(href);
  return p?.kind === "noteId" ? p.noteId : null;
}

export function markdownInternalNoteHref(noteId: string, markdownHeadingSlug?: string): string {
  return markdownHeadingSlug
    ? `#/n/${noteId}/${markdownHeadingSlug}`
    : `#/n/${noteId}`;
}

export { markdownVfsNoteHref };

/** Markdown `(...)` destinations only; used for backlink indexing (note ids only). */
export function collectReferencedNoteIdsFromMarkdown(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const href = (m[2] ?? "").trim();
    const id = parseNoteIdFromInternalMarkdownHref(href);
    if (id) out.add(id);
  }
  return out;
}

/** Collects VFS paths from markdown link destinations (`#/w/...` links). */
export function collectReferencedVfsPathsFromMarkdown(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const href = (m[2] ?? "").trim();
    const parsed = parseInternalMarkdownNoteLink(href);
    if (parsed?.kind === "vfs") out.add(parsed.vfsPath);
  }
  return out;
}
