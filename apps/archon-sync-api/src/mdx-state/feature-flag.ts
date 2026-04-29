/**
 * Per-project feature flag for the MDX mini-app plugin (PG path).
 *
 * Storage: `settings.mdxMiniApp = true | false` on the `projects` row.
 * Opt-in; default off.
 *
 * Global kill switch: env `ARCHON_MDX_RUNTIME_DISABLED === "1"` overrides
 * every project setting.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../pg.js";
import { projects } from "../db/schema.js";

export function mdxRuntimeGloballyEnabled(): boolean {
  return process.env.ARCHON_MDX_RUNTIME_DISABLED !== "1";
}

export async function mdxEnabledForProject(projectId: string): Promise<boolean> {
  if (!mdxRuntimeGloballyEnabled()) return false;
  const rows = await getDb()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const settings = rows[0]?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return false;
  }
  return (settings as Record<string, unknown>).mdxMiniApp === true;
}
