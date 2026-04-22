import { buildWorkspaceVaultKey } from "../../shared/workspace-vault-key";
import { getArchon } from "../../shared/archon-host-access";
import { isElectronUserAgent } from "../archon-web-shim";
import { isLocalRxdbWpnMirrorEnabled } from "./flags";
import {
  importWorkspaceMirrorFromMainPayload,
  touchWorkspaceRxDbForVaultKey,
} from "./workspace-wpn-rxdb";

let hooked = false;

/**
 * ADR-016 Phase 2: when `ARCHON_LOCAL_RXDB_WPN` is enabled, keep an RxDB handle warm for the current vault key
 * derived from workspace roots (sorted join). Writes still go through IPC/JSON until later phases.
 */
export function registerWorkspaceRxDbProjectRootHook(): void {
  if (hooked || typeof window === "undefined" || !isElectronUserAgent()) {
    return;
  }
  if (!isLocalRxdbWpnMirrorEnabled()) {
    return;
  }
  const archon = window.Archon;
  if (!archon) {
    return;
  }
  hooked = true;
  archon.onProjectRootChanged(() => {
    void refreshWorkspaceRxDbMirror();
  });
  void refreshWorkspaceRxDbMirror();
}

async function refreshWorkspaceRxDbMirror(): Promise<void> {
  try {
    const state = await getArchon().getProjectState();
    const roots = Array.isArray(state.workspaceRoots) ? state.workspaceRoots : [];
    if (roots.length === 0) {
      return;
    }
    const vaultKey = buildWorkspaceVaultKey(roots);
    await touchWorkspaceRxDbForVaultKey(vaultKey);
    try {
      const pull = await getArchon().pullWorkspaceRxdbMirrorPayload();
      if (pull.ok) {
        await importWorkspaceMirrorFromMainPayload(pull.payload);
      }
    } catch {
      /* cloud window or IPC unavailable */
    }
  } catch {
    /* ignore */
  }
}
