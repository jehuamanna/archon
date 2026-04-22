/** Host design-system major version plugins should target (manifest `designSystemVersion`). */
export const ARCHON_DESIGN_SYSTEM_MAJOR = 1;

/**
 * Returns a user-visible warning if the plugin declares an incompatible designSystemVersion.
 */
export function designSystemWarning(version: string | undefined): string | null {
  if (version == null || String(version).trim() === "") {
    return null;
  }
  const trimmed = String(version).trim();
  const m = /^(\d+)/.exec(trimmed);
  if (!m) {
    return `Invalid designSystemVersion: "${trimmed}"`;
  }
  const major = Number(m[1]);
  if (Number.isNaN(major) || major !== ARCHON_DESIGN_SYSTEM_MAJOR) {
    return `Plugin targets design system v${major}.x; this app expects v${ARCHON_DESIGN_SYSTEM_MAJOR}.x.`;
  }
  return null;
}
