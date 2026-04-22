import type { ArchonRendererApi } from "../../shared/archon-renderer-api";
import { setElectronIdbScratchOverlay } from "../../shared/archon-host-access";
import { isElectronCloudWpnSession } from "../auth/electron-cloud-session";
import { readElectronRunMode } from "../auth/electron-run-mode";
import { webScratchPlainStubOverrides } from "../wpnscratch/web-scratch-archon-api";

function isElectronRenderer(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
}

/**
 * Electron `contextBridge` exposes a read-only `window.Archon`, so we cannot replace it with a Proxy.
 * Instead, merge web scratch (IndexedDB) into {@link setElectronIdbScratchOverlay} when the host has
 * no workspace roots; {@link getArchon} / {@link archonDelegatingProxy} forward to that overlay.
 */
export function installElectronArchonIdbScratchProxy(): void {
  if (typeof window === "undefined" || !isElectronRenderer()) {
    return;
  }
  const bridged = window.Archon;
  if (!bridged) {
    return;
  }

  const recompute = async (): Promise<void> => {
    if (isElectronCloudWpnSession()) {
      setElectronIdbScratchOverlay(null);
      return;
    }
    if (readElectronRunMode() !== "scratch") {
      setElectronIdbScratchOverlay(null);
      return;
    }
    setElectronIdbScratchOverlay(null);
    const state = await bridged.getProjectState();
    const roots = Array.isArray(state.workspaceRoots) ? state.workspaceRoots : [];
    if (roots.length > 0) {
      setElectronIdbScratchOverlay(null);
      return;
    }
    const merged = {
      ...bridged,
      ...webScratchPlainStubOverrides(),
    } as ArchonRendererApi;
    setElectronIdbScratchOverlay(merged);
  };

  bridged.onProjectRootChanged(() => {
    void recompute();
  });
  void recompute();
}
