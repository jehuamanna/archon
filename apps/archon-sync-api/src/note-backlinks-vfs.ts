/**
 * PLAN-06 slice 3a — vFS-aware backlinks.
 *
 * The existing backlinks route only resolves `#/n/<id>` refs. Image embeds
 * created by PLAN-03 paste/drop use `#/w/./<Title>` (same-project relative)
 * or `#/w/<Workspace>/<Project>/<Title>` (absolute), so the old route
 * silently misses them — which is how the `jehu` note's embedder failed
 * to show up in `archon_backlinks`.
 *
 * This helper is pure (no DB, no Fastify) so the wpn-routes module can
 * pre-compute a per-target lookup once and then call `contentReferencesTargetViaVfs`
 * on each candidate note's markdown content.
 *
 * Supported ref shapes (matching `![alt](href)` and `[text](href)`):
 *   - `#/w/./<Title>`            — same-project-relative (embedder's projectId must match target)
 *   - `#/w/<WS>/<PROJ>/<Title>`  — absolute canonical
 *
 * Not supported (returns `false`, documented limit):
 *   - `#/w/../<…>` tree-relative refs — would need the embedder's note tree.
 *     Image embeds don't emit these, so the omission is intentional for slice 3a.
 */

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export function normalizeVfsSegment(raw: string, fallback: string): string {
  const t = raw.trim();
  const base = t.length > 0 ? t : fallback;
  return base.replace(/\//g, "∕");
}

export type VfsBacklinkTarget = {
  projectId: string;
  /** Pre-normalized "Workspace/Project/Title" with U+2215 slashes in segment names. */
  canonicalAbsolutePath: string;
  /** Pre-normalized bare Title segment (for same-project short-form match). */
  normalizedTitle: string;
};

export type VfsBacklinkEmbedder = {
  projectId: string;
};

type ParsedWref =
  | { kind: "rel-same"; title: string }
  | { kind: "absolute"; canonicalPath: string }
  | null;

function parseWref(href: string): ParsedWref {
  const raw = href.trim();
  if (!raw) return null;
  let path = raw;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) path = path.slice(hashIdx + 1);
  path = path.replace(/^\/+/, "");
  if (!path.startsWith("w/")) return null;
  const rest = path.slice("w/".length).replace(/^\/+/, "");
  const decoded = rest
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

  if (decoded[0] === ".") {
    // Same-project-relative: `./Title` (heading slug after title ignored here).
    const title = decoded[1];
    if (!title) return null;
    return { kind: "rel-same", title: normalizeVfsSegment(title, "Untitled") };
  }

  if (decoded[0] === "..") {
    // Tree-relative — unsupported in slice 3a.
    return null;
  }

  // Absolute: require at least Workspace/Project/Title.
  if (decoded.length < 3) return null;
  const ws = normalizeVfsSegment(decoded[0]!, "Workspace");
  const proj = normalizeVfsSegment(decoded[1]!, "Project");
  const title = normalizeVfsSegment(decoded[2]!, "Untitled");
  return { kind: "absolute", canonicalPath: `${ws}/${proj}/${title}` };
}

/**
 * Returns `true` if `content` contains at least one markdown link or image
 * reference that resolves (via vFS) to the given target note. Intended to
 * augment — not replace — the existing `#/n/<id>` matching in the backlinks
 * route.
 */
export function contentReferencesTargetViaVfs(
  content: string,
  embedder: VfsBacklinkEmbedder,
  target: VfsBacklinkTarget,
): boolean {
  if (!content) return false;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(content)) !== null) {
    const parsed = parseWref((m[2] ?? "").trim());
    if (!parsed) continue;
    if (parsed.kind === "rel-same") {
      if (
        embedder.projectId === target.projectId &&
        parsed.title === target.normalizedTitle
      ) {
        return true;
      }
    } else if (parsed.kind === "absolute") {
      if (parsed.canonicalPath === target.canonicalAbsolutePath) return true;
    }
  }
  return false;
}

/** Build the pre-normalized target shape from raw workspace + project + title strings. */
export function buildVfsBacklinkTarget(args: {
  projectId: string;
  workspaceName: string;
  projectName: string;
  title: string;
}): VfsBacklinkTarget {
  const ws = normalizeVfsSegment(args.workspaceName, "Workspace");
  const proj = normalizeVfsSegment(args.projectName, "Project");
  const title = normalizeVfsSegment(args.title, "Untitled");
  return {
    projectId: args.projectId,
    canonicalAbsolutePath: `${ws}/${proj}/${title}`,
    normalizedTitle: title,
  };
}
