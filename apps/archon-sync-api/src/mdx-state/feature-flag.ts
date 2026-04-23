import type { Db } from "mongodb";
import { getWpnWorkspacesCollection } from "../db.js";

/**
 * Per-workspace feature flag for the MDX mini-app plugin.
 *
 * Storage: `settings.mdxMiniApp = true | false` on the existing workspace doc
 * (see `WpnWorkspaceDoc.settings` in db.ts). Opt-in; default off.
 *
 * Global kill switch: if env `ARCHON_MDX_RUNTIME_DISABLED === "1"`, every
 * workspace is treated as disabled regardless of its setting — lets ops
 * yank the runtime on a bad deploy without per-workspace writes.
 */

export function mdxRuntimeGloballyEnabled(): boolean {
  return process.env.ARCHON_MDX_RUNTIME_DISABLED !== "1";
}

export async function mdxEnabledForWorkspace(
  _db: Db,
  workspaceId: string,
): Promise<boolean> {
  if (!mdxRuntimeGloballyEnabled()) return false;
  const ws = await getWpnWorkspacesCollection().findOne({ id: workspaceId });
  if (!ws) return false;
  return ws.settings?.mdxMiniApp === true;
}
