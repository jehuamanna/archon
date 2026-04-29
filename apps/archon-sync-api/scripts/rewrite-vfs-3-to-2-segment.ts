/**
 * One-shot migration: rewrite 3-segment `#/w/<Workspace>/<Project>/<Title>`
 * markdown links inside `notes.content` to 2-segment `#/w/<Project>/<Title>`.
 *
 * Background. The org/team migration deleted workspaces from the data
 * model and the shared note-vfs scheme flattened to 2 segments
 * (`Project/Title`) in commit f136420. Existing markdown content still
 * carries pre-migration 3-segment links written before the flatten —
 * those links resolve to "no match" at runtime because the parser
 * treats the workspace segment as the project name and looks up a
 * project that doesn't exist.
 *
 * What this script does. For every non-deleted note, it scans
 * `content` for inline-markdown links of the shape
 * `[label](#/w/<a>/<b>/<c>(...optional heading slug))` and rewrites
 * each match by dropping the first path segment (`<a>`). The middle
 * segment was the project name; the third segment was the note title;
 * the optional fourth segment was a heading slug. The new shape is
 * `[label](#/w/<b>/<c>(...heading))`.
 *
 * Out of scope.
 *   • Same-project-relative `./Title` links — already 2-segment.
 *   • Tree-relative `../sibling` links — workspace-free already.
 *   • DocLink JSX (`<DocLink to="…">`) — rare; can be added later.
 *   • Conflict resolution when two pre-migration workspaces had
 *     projects with the same name — collapsed projects share a name
 *     in the post-migration org. The rewrite drops the workspace
 *     segment regardless; the user disambiguates by hand if a link
 *     becomes ambiguous.
 *
 * Usage.
 *   pnpm --filter @archon/sync-api exec tsx \
 *     scripts/rewrite-vfs-3-to-2-segment.ts [--dry-run] [--org <orgId>]
 *
 * Flags.
 *   --dry-run      Report what would change without writing rows.
 *   --org <orgId>  Limit the scan to a single org (default: every org).
 *   --verbose      Log every changed note id + count of links rewritten.
 */
import { and, eq, sql } from "drizzle-orm";
import { ensurePgConnected, getDb, disconnectPg } from "../src/pg.js";
import { notes } from "../src/db/schema.js";

type Args = {
  dryRun: boolean;
  orgId: string | null;
  verbose: boolean;
};

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let orgId: string | null = null;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--org" && i + 1 < argv.length) {
      orgId = argv[++i] ?? null;
    } else if (a === "--verbose") {
      verbose = true;
    }
  }
  return { dryRun, orgId, verbose };
}

/**
 * Rewrite inline markdown link hrefs of the shape
 * `#/w/<seg>/<seg>/<seg>(...)?` (optionally prefixed by leading `/`)
 * by dropping the first path segment.
 *
 * Returns the rewritten string and a count of replacements made.
 *
 * The implementation walks `[label](href...)` matches with a regex,
 * leaving fenced code blocks alone (anything inside triple-backtick
 * fences is preserved verbatim) so code samples that document the
 * old link shape are not silently rewritten.
 */
export function rewriteThreeSegmentVfsLinks(
  input: string,
): { content: string; rewrites: number } {
  let rewrites = 0;
  const segments = input.split(/(```[\s\S]*?```)/g);
  const out = segments.map((chunk, i) => {
    // Odd-indexed chunks are fenced code blocks — preserve verbatim.
    if (i % 2 === 1) return chunk;
    return chunk.replace(
      /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g,
      (match, bang, label, href, titlePart) => {
        const trimmed = String(href).trim();
        const replaced = rewriteVfsHref(trimmed);
        if (replaced === null) return match;
        rewrites++;
        return `${bang}[${label}](${replaced}${titlePart ?? ""})`;
      },
    );
  });
  return { content: out.join(""), rewrites };
}

/**
 * Returns the rewritten href (with the first path segment dropped) or
 * `null` when the input is not a 3-segment `#/w/...` link.
 *
 * Recognises `#/w/...`, `/#/w/...`, `w/...`, and `/w/...` prefixes.
 * Heading slugs (`/^[a-z0-9-]+$/i`) at the tail are preserved.
 */
function rewriteVfsHref(href: string): string | null {
  // STRICTLY lowercase: real heading slugs are kebab-cased lowercase ASCII
  // (the renderer's slug generator drops uppercase and punctuation). The
  // shared parser uses a case-insensitive variant which is permissive at
  // runtime; here we lean on the stricter rule to avoid mistaking a
  // capitalised note title (e.g. "Title-A", "Spec-Doc") for a heading
  // slug. Pure-lowercase titles (e.g. "home", "intro") remain genuinely
  // ambiguous post-migration and we choose to skip them — see the
  // related test "does NOT rewrite when the third segment looks like a
  // heading slug".
  const HEADING_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  // Identify the prefix and pull out the path-after-w.
  let prefix = "";
  let rest = "";
  if (href.startsWith("#/w/")) {
    prefix = "#/w/";
    rest = href.slice("#/w/".length);
  } else if (href.startsWith("/#/w/")) {
    prefix = "/#/w/";
    rest = href.slice("/#/w/".length);
  } else if (href.startsWith("/w/")) {
    prefix = "/w/";
    rest = href.slice("/w/".length);
  } else if (href.startsWith("w/")) {
    prefix = "w/";
    rest = href.slice("w/".length);
  } else {
    return null;
  }
  if (!rest) return null;

  const parts = rest
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Skip relative paths — they're already 2-segment-friendly.
  if (parts[0] === "." || parts[0] === "..") return null;

  // Determine if the tail is a heading slug.
  const last = parts[parts.length - 1] ?? "";
  const tailIsSlug = parts.length >= 4 && HEADING_SLUG_RE.test(last);

  // Pre-migration absolute path shapes:
  //   3 parts: Workspace/Project/Title
  //   4 parts: Workspace/Project/Title/heading-slug
  // Post-migration shapes that we should NOT touch:
  //   2 parts: Project/Title
  //   3 parts: Project/Title/heading-slug   (heading-slug at index 2)
  // The rewrite-vs-skip discriminator: a 3-part path with a heading
  // slug at index 2 is already 2-segment + heading; leave it alone.

  if (parts.length === 3) {
    if (HEADING_SLUG_RE.test(last)) {
      // Already 2-segment + heading. Skip.
      return null;
    }
    // 3-segment Workspace/Project/Title → drop first.
    const newParts = parts.slice(1);
    return `${prefix}${newParts.map((p) => encodeURIComponent(decodeSafe(p))).join("/")}`;
  }
  if (parts.length === 4 && tailIsSlug) {
    // 4-segment Workspace/Project/Title/heading → drop first, keep heading.
    const newParts = parts.slice(1);
    return `${prefix}${newParts.map((p) => encodeURIComponent(decodeSafe(p))).join("/")}`;
  }
  return null;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensurePgConnected();
  const db = getDb();

  const where = args.orgId
    ? and(eq(notes.orgId, args.orgId), sql`${notes.deleted} IS NOT TRUE`)
    : sql`${notes.deleted} IS NOT TRUE`;
  const rows = await db
    .select({ id: notes.id, content: notes.content, orgId: notes.orgId })
    .from(notes)
    .where(where);

  let scanned = 0;
  let touched = 0;
  let totalRewrites = 0;
  for (const r of rows) {
    scanned++;
    const before = r.content ?? "";
    if (!before.includes("/w/")) continue;
    const { content: after, rewrites } = rewriteThreeSegmentVfsLinks(before);
    if (rewrites === 0 || after === before) continue;
    touched++;
    totalRewrites += rewrites;
    if (args.verbose) {
      // eslint-disable-next-line no-console
      console.log(
        `[rewrite] note=${r.id} org=${r.orgId} links=${rewrites}`,
      );
    }
    if (!args.dryRun) {
      await db
        .update(notes)
        .set({ content: after, updatedAtMs: Date.now() })
        .where(eq(notes.id, r.id));
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `${args.dryRun ? "[dry-run] " : ""}scanned=${scanned} touched=${touched} total_link_rewrites=${totalRewrites}`,
  );

  await disconnectPg();
}

// Run only when invoked as a script (not when imported by tests).
// `process.argv[1]` is the entry path: when invoked as `tsx scripts/X.ts`
// it ends with `X.ts`; when the test runner imports this module, argv[1]
// points at the *.test.ts file (or at node's internal cli script). The
// `.test.ts` discriminator keeps the side effect from firing during tests.
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /rewrite-vfs-3-to-2-segment\.ts$/.test(process.argv[1]) &&
  !/\.test\.ts$/.test(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("rewrite-vfs-3-to-2-segment failed:", err);
    process.exit(1);
  });
}
