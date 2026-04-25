/**
 * Per-workspace feature flag for the MDX mini-app plugin (PG path).
 *
 * Storage: `settings.mdxMiniApp = true | false` on the existing wpn_workspaces
 * row. Opt-in; default off.
 *
 * Global kill switch: env `ARCHON_MDX_RUNTIME_DISABLED === "1"` overrides
 * every workspace setting.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../pg.js";
import { wpnWorkspaces } from "../db/schema.js";

export function mdxRuntimeGloballyEnabled(): boolean {
  return process.env.ARCHON_MDX_RUNTIME_DISABLED !== "1";
}

export async function mdxEnabledForWorkspace(workspaceId: string): Promise<boolean> {
  if (!mdxRuntimeGloballyEnabled()) return false;
  const rows = await getDb()
    .select({ settings: wpnWorkspaces.settings })
    .from(wpnWorkspaces)
    .where(eq(wpnWorkspaces.id, workspaceId))
    .limit(1);
  const settings = rows[0]?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return false;
  }
  return (settings as Record<string, unknown>).mdxMiniApp === true;
}
