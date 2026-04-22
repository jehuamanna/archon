import { isLocalRxdbWpnMirrorEnabledEnv } from "../../shared/workspace-rxdb-env";

/**
 * ADR-016 Phase 2: when enabled, the renderer opens a local RxDB mirror for workspace/WPN data
 * (Dexie/IndexedDB) and hooks project-root changes. JSON `archon-workspace.json` remains authoritative
 * until later phases remove dual-write.
 */
export function isLocalRxdbWpnMirrorEnabled(): boolean {
  return isLocalRxdbWpnMirrorEnabledEnv();
}
