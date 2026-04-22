import {
  isWorkspaceRxdbAuthorityEnvEnabled,
  WORKSPACE_RXDB_AUTHORITY_ENV,
} from "../../shared/workspace-rxdb-env";

/**
 * ADR-016 Phase 4 (thin main): when the renderer RxDB mirror becomes the sole local source of truth,
 * gate remaining JSON/IPC workspace writes behind an explicit env switch during rollout.
 */
export { WORKSPACE_RXDB_AUTHORITY_ENV };

export function isWorkspaceRxdbAuthorityEnabled(): boolean {
  return isWorkspaceRxdbAuthorityEnvEnabled();
}
