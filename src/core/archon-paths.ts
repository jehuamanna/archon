import * as path from "path";

/**
 * Cross-platform Archon paths under Electron `userData` / `cache`.
 * Never hardcode `~/.config` or `~/.archon` — OS layout differs (Windows %APPDATA%, etc.).
 */

function assertUnderBase(baseAbs: string, candidateAbs: string, label: string): void {
  const rel = path.relative(baseAbs, candidateAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must resolve under ${baseAbs}`);
  }
}

/** `userData/plugins` — sources/, bin/, IDE metadata (same layout as before, portable). */
export function getArchonUserPluginsDir(userDataPath: string): string {
  const base = path.resolve(userDataPath);
  const resolved = path.resolve(base, "plugins");
  assertUnderBase(base, resolved, "plugins directory");
  return resolved;
}

/** Legacy JSON notes path (migration source only). */
export function getLegacyNotesJsonPath(userDataPath: string): string {
  return path.join(userDataPath, "notes-tree.json");
}

/**
 * `userData/archon-cache` — regenerable caches (Electron 41 typings omit `getPath("cache")`;
 * keeping caches under userData stays portable and easy to wipe).
 */
export function getArchonDerivedCacheRoot(userDataPath: string): string {
  const base = path.resolve(userDataPath);
  const resolved = path.resolve(base, "archon-cache");
  assertUnderBase(base, resolved, "archon-cache directory");
  return resolved;
}

/** Per-plugin npm installs (regenerable). */
export function getArchonPluginCacheRoot(userDataPath: string): string {
  return path.join(getArchonDerivedCacheRoot(userDataPath), "plugin-cache");
}

/** JSX compile cache (regenerable). */
export function getArchonJsxCacheRoot(userDataPath: string): string {
  return path.join(getArchonDerivedCacheRoot(userDataPath), "jsx-cache");
}
