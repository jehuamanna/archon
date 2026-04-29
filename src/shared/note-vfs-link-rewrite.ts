import { parseInternalMarkdownNoteLink } from "./markdown-internal-note-href";
import {
  canonicalVfsPathFromLinkRow,
  isSameProjectRelativeVfsPath,
  isTreeRelativeVfsPath,
  markdownVfsNoteHref,
  normalizeVfsSegment,
  resolveTreeRelativeVfsPath,
} from "./note-vfs-path";
import type { WpnNoteWithContextListItem } from "./wpn-v2-types";

/**
 * When a note moves to a different project, its canonical VFS path changes.
 * Returns old and new canonical paths, or `null` when the path would not change.
 */
export function vfsCanonicalPathsForProjectChange(
  oldProject: string,
  newProject: string,
  title: string,
): { oldCanonical: string; newCanonical: string } | null {
  const oldCanonical = canonicalVfsPathFromLinkRow({
    projectName: oldProject,
    title,
  });
  const newCanonical = canonicalVfsPathFromLinkRow({
    projectName: newProject,
    title,
  });
  if (oldCanonical === newCanonical) return null;
  return { oldCanonical, newCanonical };
}

/**
 * When a note title changes, its canonical VFS path `Project/Title` changes.
 * Rewrite markdown / MDX that pointed at the old path so `#/w/...` and `w/...` links keep working.
 */
export function vfsCanonicalPathsForTitleChange(
  ctx: Pick<WpnNoteWithContextListItem, "project_name">,
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
  if (p?.kind !== "vfs" || !isSameProjectRelativeVfsPath(p.vfsPath)) {
    return null;
  }
  const rest = p.vfsPath.trim() === "." ? "" : p.vfsPath.trim().slice(2).trim();
  const seg = normalizeVfsSegment(rest.length > 0 ? rest : "Untitled", "Untitled");
  if (seg !== oldTitleSeg) {
    return null;
  }
  return markdownVfsNoteHref(`./${newTitleSeg}`, p.markdownHeadingSlug);
}

/**
 * Apply rewrites outside ``` fenced ``` blocks only (inline `code` is not skipped).
 */
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
      i % 2 === 1 ? chunk : rewriteVfsLinksInPlainSegment(chunk, oldCanonical, newCanonical, oldTitle, newTitle),
    )
    .join("");
}

function rewriteVfsLinksInPlainSegment(
  segment: string,
  oldCanonical: string,
  newCanonical: string,
  oldTitle?: string,
  newTitle?: string,
): string {
  let s = rewriteMarkdownLinkHrefs(segment, oldCanonical, newCanonical, oldTitle, newTitle);
  s = rewriteDocLinkToAttrs(s, oldCanonical, newCanonical);
  return s;
}

/**
 * When a note title changes within a project, rewrite `./OldTitle` links in notes that live in that project.
 */
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

function rewriteRelativeTitleInPlainSegment(
  segment: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string {
  let s = rewriteMarkdownLinkHrefsRelativeTitle(segment, oldTitleSeg, newTitleSeg);
  s = rewriteDocLinkRelativeTitle(s, oldTitleSeg, newTitleSeg);
  return s;
}

function rewriteMarkdownLinkHrefsRelativeTitle(
  segment: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string {
  return segment.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g,
    (match, bang, label, href, titlePart) => {
      const nh = replaceRelativeSameProjectTitleHref(
        String(href).trim(),
        oldTitleSeg,
        newTitleSeg,
      );
      if (nh === null) return match;
      const nl = String(label).trim() === oldTitleSeg.trim() ? newTitleSeg.trim() : label;
      return `${bang}[${nl}](${nh}${titlePart ?? ""})`;
    },
  );
}

function rewriteDocLinkRelativeTitle(
  segment: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string {
  return segment.replace(
    /<DocLink\b([\s\S]*?)(\/>|>)/gi,
    (full: string, inner: string, end: string) => {
      const m = /\bto=(?:"([^"]*)"|'([^']*)')/.exec(inner);
      if (!m) return full;
      const q = m[0].includes('"') ? '"' : "'";
      const raw = (m[1] ?? m[2] ?? "").trim();
      const nh = replaceRelativeSameProjectTitleHref(raw, oldTitleSeg, newTitleSeg);
      if (nh === null) return full;
      const nextInner = inner.replace(/\bto=(?:"[^"]*"|'[^']*')/, `to=${q}${nh}${q}`);
      return `<DocLink${nextInner}${end}`;
    },
  );
}

function replaceTreeRelativeTitleHref(
  href: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string | null {
  const p = parseInternalMarkdownNoteLink(href);
  if (p?.kind !== "vfs" || !isTreeRelativeVfsPath(p.vfsPath)) return null;
  // The last non-".." segment is the target title
  const segments = p.vfsPath.split("/").filter((s) => s.length > 0);
  const lastSeg = segments[segments.length - 1];
  if (!lastSeg || lastSeg === "..") return null;
  const normalized = normalizeVfsSegment(lastSeg, "Untitled");
  if (normalized !== oldTitleSeg) return null;
  // Replace the last segment with the new title
  segments[segments.length - 1] = newTitleSeg;
  const newPath = segments.join("/");
  return markdownVfsNoteHref(newPath, p.markdownHeadingSlug);
}

/**
 * When a note title changes, rewrite tree-relative `../OldTitle` links in notes that live in the same project.
 */
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
            /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g,
            (match, bang, label, href, titlePart) => {
              const nh = replaceTreeRelativeTitleHref(
                String(href).trim(),
                oldTitleSeg,
                newTitleSeg,
              );
              if (nh === null) return match;
              const nl = String(label).trim() === oldTitleSeg.trim() ? newTitleSeg.trim() : label;
              return `${bang}[${nl}](${nh}${titlePart ?? ""})`;
            },
          ),
    )
    .join("");
}

/** Applies canonical path rewrites plus same-project `./title` and tree-relative `../title` rewrites when `rowProjectId` matches `renamedProjectId`. */
export function rewriteMarkdownForWpnNoteTitleChange(
  content: string,
  rowProjectId: string,
  renamedProjectId: string,
  oldCanonical: string,
  newCanonical: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): string {
  let s = rewriteVfsCanonicalLinksInMarkdown(content, oldCanonical, newCanonical, oldTitleSeg, newTitleSeg);
  if (rowProjectId === renamedProjectId) {
    s = rewriteRelativeSameProjectTitleLinksInMarkdown(s, oldTitleSeg, newTitleSeg);
    s = rewriteTreeRelativeTitleLinksInMarkdown(s, oldTitleSeg, newTitleSeg);
  }
  return s;
}

/**
 * Converts tree-relative `../...` links in a note's markdown to absolute `#/w/Ws/Proj/Title` links.
 * Called before a note is moved so that relative links survive the tree position change.
 */
export function convertTreeRelativeLinksToAbsolute(
  content: string,
  sourceNoteId: string,
  notes: readonly WpnNoteWithContextListItem[],
): string {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return parts
    .map((chunk, i) =>
      i % 2 === 1
        ? chunk
        : chunk.replace(
            /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g,
            (match, bang, label, href, titlePart) => {
              const trimmed = String(href).trim();
              const p = parseInternalMarkdownNoteLink(trimmed);
              if (p?.kind !== "vfs" || !isTreeRelativeVfsPath(p.vfsPath)) return match;
              const canonical = resolveTreeRelativeVfsPath(p.vfsPath, sourceNoteId, notes);
              if (!canonical) return match;
              const nh = markdownVfsNoteHref(canonical, p.markdownHeadingSlug);
              return `${bang}[${label}](${nh}${titlePart ?? ""})`;
            },
          ),
    )
    .join("");
}

function rewriteMarkdownLinkHrefs(
  segment: string,
  oldCanonical: string,
  newCanonical: string,
  oldTitle?: string,
  newTitle?: string,
): string {
  return segment.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g,
    (match, bang, label, href, titlePart) => {
      const nh = replaceInternalHref(String(href).trim(), oldCanonical, newCanonical);
      if (nh === null) return match;
      const nl = oldTitle && newTitle && String(label).trim() === oldTitle.trim() ? newTitle.trim() : label;
      return `${bang}[${nl}](${nh}${titlePart ?? ""})`;
    },
  );
}

/**
 * `<DocLink to="…">` / `<DocLink to='…' />` — static string only.
 */
function rewriteDocLinkToAttrs(
  segment: string,
  oldCanonical: string,
  newCanonical: string,
): string {
  return segment.replace(
    /<DocLink\b([\s\S]*?)(\/>|>)/gi,
    (full: string, inner: string, end: string) => {
      const m = /\bto=(?:"([^"]*)"|'([^']*)')/.exec(inner);
      if (!m) return full;
      const q = m[0].includes('"') ? '"' : "'";
      const raw = (m[1] ?? m[2] ?? "").trim();
      const nh = replaceInternalHref(raw, oldCanonical, newCanonical);
      if (nh === null) return full;
      const nextInner = inner.replace(/\bto=(?:"[^"]*"|'[^']*')/, `to=${q}${nh}${q}`);
      return `<DocLink${nextInner}${end}`;
    },
  );
}
