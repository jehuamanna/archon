/**
 * Scratch / WPN mutations that should refresh the Notes explorer and shell project workspace
 * state. `ShellProjectWorkspaceProvider` listens too so `workspaceRoots` updates if the first
 * `getProjectState` tick has not finished yet (otherwise `loadWorkspaces` used to no-op).
 */
export const ARCHON_WPN_TREE_CHANGED_EVENT = "archon:wpn-tree-changed" as const;

/**
 * When WPN is backed by the sync HTTP API, remote changes (other devices/tabs) do not emit
 * {@link ARCHON_WPN_TREE_CHANGED_EVENT}. The Notes explorer polls at this interval.
 * Tradeoff: request volume vs freshness (aligned with `useShellProjectWorkspace` project-state poll).
 */
export const WPN_SYNC_REMOTE_POLL_INTERVAL_MS = 8000;

export function dispatchWpnTreeChanged(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(ARCHON_WPN_TREE_CHANGED_EVENT));
}
