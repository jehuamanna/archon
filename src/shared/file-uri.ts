/**
 * Stable file:// URIs for Monaco / TypeScript (main + renderer).
 */
export function toFileUri(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized}`;
}

/**
 * Append a workspace-relative path (always `/`-separated) to a directory file:// URL.
 */
export function joinFileUri(rootDirFileUri: string, relativePath: string): string {
  const rel = relativePath.replace(/\\/g, "/");
  const base = rootDirFileUri.endsWith("/")
    ? rootDirFileUri
    : `${rootDirFileUri}/`;
  return new URL(rel, base).href;
}
