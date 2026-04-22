/**
 * Resolve the path under `assets/` from a parsed `archon-asset:` URL.
 *
 * Canonical form is `archon-asset:///rel/to/file` (three slashes) so pathname holds the full rel path.
 * If only two slashes are used (`archon-asset://_imports/file.mp3`), the URL parser treats the first
 * segment as `hostname` and drops it from pathname — this helper reconstructs `rel`.
 */
export function relativeAssetPathFromArchonAssetUrl(u: URL): string | null {
  let pathname = (u.pathname || "").replace(/^\/+/, "").replace(/\\/g, "/");
  let host = "";
  if (u.hostname) {
    try {
      host = decodeURIComponent(u.hostname);
    } catch {
      host = u.hostname;
    }
  }
  const combined = host ? (pathname ? `${host}/${pathname}` : host) : pathname;
  if (!combined || combined.includes("..")) {
    return null;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(combined);
  } catch {
    return null;
  }
  if (!rel || rel.includes("..")) {
    return null;
  }
  const segments = rel.split("/").filter(Boolean);
  for (const s of segments) {
    if (s.startsWith(".") || s === "..") {
      return null;
    }
  }
  return rel;
}

/**
 * Always `archon-asset:///…` (three slashes) so pathname is unambiguous; avoids
 * `archon-asset://_imports/…` where `_imports` is parsed as hostname.
 */
export function buildCanonicalArchonAssetHref(
  relativePath: unknown,
  projectRoot?: string,
): string {
  const normalized = normalizeNoteAssetRelativePath(relativePath);
  if (!normalized) {
    return "archon-asset:///";
  }
  const parts = normalized
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg));
  const u = new URL(`archon-asset:///${parts.join("/")}`);
  if (projectRoot != null && String(projectRoot).length > 0) {
    u.searchParams.set("root", String(projectRoot));
  }
  return u.href;
}

/** `assetRel` from note JSON / UI: trim slashes, or recover rel from a mistaken full `archon-asset:` string. */
export function normalizeNoteAssetRelativePath(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith("archon-asset:") || lower.startsWith("node-asset:")) {
    try {
      return relativeAssetPathFromArchonAssetUrl(new URL(raw)) ?? "";
    } catch {
      return "";
    }
  }
  return raw.replace(/^\/+/, "").replace(/\\/g, "/");
}
