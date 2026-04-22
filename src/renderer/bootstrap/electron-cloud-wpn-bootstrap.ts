import type { ArchonRendererApi } from "../../shared/archon-renderer-api";
import { setElectronCloudWpnOverlay } from "../../shared/archon-host-access";
import { readElectronRunMode } from "../auth/electron-run-mode";
import { createWebArchonApi, isElectronUserAgent } from "../archon-web-shim";

/** Methods that must hit sync-api / headless WPN instead of the file-vault IPC bridge. */
const ELECTRON_CLOUD_WPN_DELEGATE_KEYS = new Set<keyof ArchonRendererApi>([
  "getNote",
  "getAllNotes",
  "createNote",
  "renameNote",
  "deleteNotes",
  "moveNote",
  "moveNotesBulk",
  "pasteSubtree",
  "saveNotePluginUiState",
  "saveNoteContent",
  "patchNoteMetadata",
  "getRegisteredTypes",
  "getSelectableNoteTypes",
  "getProjectState",
  "getShellLayout",
  "setShellLayout",
  "archonUndo",
  "archonRedo",
  "wpnListWorkspaces",
  "wpnListWorkspacesAndProjects",
  "wpnGetFullTree",
  "wpnCreateWorkspace",
  "wpnUpdateWorkspace",
  "wpnDeleteWorkspace",
  "wpnListProjects",
  "wpnCreateProject",
  "wpnUpdateProject",
  "wpnDeleteProject",
  "wpnListNotes",
  "wpnListAllNotesWithContext",
  "wpnListBacklinksToNote",
  "wpnGetNote",
  "wpnGetExplorerState",
  "wpnSetExplorerState",
  "wpnCreateNoteInProject",
  "wpnPreviewNoteTitleVfsImpact",
  "wpnPatchNote",
  "wpnDeleteNotes",
  "wpnMoveNote",
  "wpnDuplicateNoteSubtree",
]);

function isDelegatedKey(prop: string | symbol): prop is keyof ArchonRendererApi {
  return typeof prop === "string" && ELECTRON_CLOUD_WPN_DELEGATE_KEYS.has(prop as keyof ArchonRendererApi);
}

function installMergedCloudOverlay(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.__ARCHON_WPN_USE_SYNC_API__ = true;

  const bridged = window.Archon;
  if (!bridged) {
    return;
  }

  const webApi = createWebArchonApi("");

  const shell = Object.create(null) as object;
  const merged = new Proxy(shell, {
    get(_target, prop, receiver) {
      if (isDelegatedKey(prop)) {
        return Reflect.get(webApi, prop, webApi);
      }
      return Reflect.get(bridged, prop, receiver);
    },
    has(_target, prop) {
      if (isDelegatedKey(prop)) {
        return Reflect.has(webApi, prop);
      }
      return Reflect.has(bridged, prop);
    },
  }) as ArchonRendererApi;

  setElectronCloudWpnOverlay(merged);
}

function clearCloudOverlay(): void {
  setElectronCloudWpnOverlay(null);
  if (typeof window === "undefined") {
    return;
  }
  const w = window as Window & { __ARCHON_WPN_USE_SYNC_API__?: boolean };
  try {
    delete w.__ARCHON_WPN_USE_SYNC_API__;
  } catch {
    w.__ARCHON_WPN_USE_SYNC_API__ = false;
  }
}

/**
 * Sync HTTP WPN overlay with run mode and/or argv-cloud window. Call after `writeElectronRunMode`
 * or when `window.Archon` becomes available.
 */
export function syncElectronCloudWpnOverlayFromRunMode(): void {
  if (typeof window === "undefined" || !isElectronUserAgent()) {
    return;
  }
  const sessionCloud = readElectronRunMode() === "cloud";
  const argvCloud = window.__ARCHON_ELECTRON_WPN_BACKEND__ === "cloud";
  if (!sessionCloud && !argvCloud) {
    clearCloudOverlay();
    return;
  }
  installMergedCloudOverlay();
}

/**
 * Install or tear down the cloud WPN merge proxy from run mode / argv (single-window cloud uses
 * `readElectronRunMode() === "cloud"` on a file-argv window).
 */
export function installElectronCloudWpnOverlay(): void {
  syncElectronCloudWpnOverlayFromRunMode();
}
