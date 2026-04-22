/**
 * Shared slug rules for markdown outline (TOC) and rendered heading ids.
 * TOC parses source lines; the preview uses plain text from the React tree — keep slugs aligned when possible.
 */
export function baseSlug(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "section";
}

/** Best-effort strip of common GFM inline syntax from an ATX / setext heading source fragment. */
export function stripInlineMarkdownHeadingSource(raw: string): string {
  let s = raw.trim();
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1");
  for (let i = 0; i < 4; i += 1) {
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  }
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/_([^_\s][^_]*[^_\s])_/g, "$1");
  return s.trim();
}

export type MarkdownTocRow = { level: number; text: string; slug: string };

/** ATX / setext headings from markdown source; slugs match {@link MarkdownRenderer} numbering rules. */
export function parseMarkdownHeadingsForToc(md: string): MarkdownTocRow[] {
  const out: MarkdownTocRow[] = [];
  const counts = new Map<string, number>();
  const lines = md.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      const level = atx[1]!.length;
      const text = atx[2]!.trim();
      if (!text) continue;
      const slugBase = baseSlug(stripInlineMarkdownHeadingSource(text));
      const prev = counts.get(slugBase) ?? 0;
      const n = prev + 1;
      counts.set(slugBase, n);
      const slug = n === 1 ? slugBase : `${slugBase}-${n}`;
      out.push({ level, text, slug });
      continue;
    }

    const next = lines[i + 1] ?? "";
    const setext = /^(=+|-+)\s*$/.exec(next);
    if (setext && line.trim().length > 0) {
      const level = setext[1]!.startsWith("=") ? 1 : 2;
      const text = line.trim();
      const slugBase = baseSlug(stripInlineMarkdownHeadingSource(text));
      const prev = counts.get(slugBase) ?? 0;
      const n = prev + 1;
      counts.set(slugBase, n);
      const slug = n === 1 ? slugBase : `${slugBase}-${n}`;
      out.push({ level, text, slug });
      i += 1;
    }
  }

  return out;
}
