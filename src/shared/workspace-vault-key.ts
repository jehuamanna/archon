/** ADR-016: stable vault id for RxDB / mirror (must match renderer `project-root-sync`). */
export function buildWorkspaceVaultKey(workspaceRoots: string[]): string {
  return workspaceRoots
    .map((r) => String(r).trim())
    .filter(Boolean)
    .sort()
    .join("|")
    .slice(0, 240);
}
