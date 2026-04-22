const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

type ParsedHref =
  | { kind: "noteId"; noteId: string }
  | { kind: "vfs"; pathAfterW: string }
  | null;

function parseInternalHref(href: string): ParsedHref {
  const raw = href.trim();
  if (!raw) return null;
  let path = raw;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) path = path.slice(hashIdx + 1);
  path = path.replace(/^\/+/, "");
  if (path.startsWith("n/")) {
    const rest = path.slice("n/".length);
    const parts = rest
      .split("/")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const noteId = parts[0];
    return noteId ? { kind: "noteId", noteId } : null;
  }
  if (path.startsWith("w/")) {
    const rest = path.slice("w/".length);
    return rest.length > 0 ? { kind: "vfs", pathAfterW: rest } : null;
  }
  return null;
}

export function extractReferencedNoteIdsFromMarkdown(text: string): string[] {
  return extractReferencedLinksFromMarkdown(text).noteIds;
}

export type ExtractedLinks = {
  noteIds: string[];
  vfsHrefPaths: string[];
};

export function extractReferencedLinksFromMarkdown(text: string): ExtractedLinks {
  if (!text) return { noteIds: [], vfsHrefPaths: [] };
  const seenIds = new Set<string>();
  const noteIds: string[] = [];
  const seenVfs = new Set<string>();
  const vfsHrefPaths: string[] = [];
  MARKDOWN_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKDOWN_LINK_RE.exec(text)) !== null) {
    const href = (m[2] ?? "").trim();
    const parsed = parseInternalHref(href);
    if (!parsed) continue;
    if (parsed.kind === "noteId") {
      if (!seenIds.has(parsed.noteId)) {
        seenIds.add(parsed.noteId);
        noteIds.push(parsed.noteId);
      }
    } else {
      if (!seenVfs.has(parsed.pathAfterW)) {
        seenVfs.add(parsed.pathAfterW);
        vfsHrefPaths.push(parsed.pathAfterW);
      }
    }
  }
  return { noteIds, vfsHrefPaths };
}
