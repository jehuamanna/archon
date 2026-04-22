import { setElectronWorkspaceRxdbOverlay } from "../../shared/archon-host-access";
import { isElectronCloudWpnSession } from "../auth/electron-cloud-session";
import { readElectronRunMode } from "../auth/electron-run-mode";
import { syncElectronCloudWpnOverlayFromRunMode } from "./electron-cloud-wpn-bootstrap";
import { runElectronLegacyScratchWpnMigrationOnce } from "./electron-legacy-scratch-wpn-migration";
import { installElectronArchonIdbScratchProxy } from "./electron-archon-idb-scratch";
import { isElectronUserAgent } from "../archon-web-shim";

function isElectronRenderer(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
}

void (async () => {
  syncElectronCloudWpnOverlayFromRunMode();
  await runElectronLegacyScratchWpnMigrationOnce();
  installElectronArchonIdbScratchProxy();
  /** Web dev imports this bootstrap too; skip RxDB/Electron-only modules (avoids Turbopack HMR noise). */
  if (typeof window === "undefined" || !isElectronRenderer()) {
    return;
  }
  const { registerWorkspaceRxDbProjectRootHook } = await import("../workspace-rxdb/project-root-sync");
  registerWorkspaceRxDbProjectRootHook();
  const { createElectronWorkspaceRxdbArchonOverlay } = await import(
    "../workspace-rxdb/electron-workspace-rxdb-archon-overlay"
  );
  const { importWorkspaceMirrorFromMainPayload } = await import("../workspace-rxdb/workspace-wpn-rxdb");
  if (
    typeof window !== "undefined" &&
    window.Archon &&
    isElectronUserAgent() &&
    !isElectronCloudWpnSession() &&
    readElectronRunMode() !== "scratch"
  ) {
    setElectronWorkspaceRxdbOverlay(createElectronWorkspaceRxdbArchonOverlay(window.Archon));
  }
  if (typeof window !== "undefined" && window.archonDesktop?.onWorkspaceRxdbMirrorUpdated) {
    window.archonDesktop.onWorkspaceRxdbMirrorUpdated((payload) => {
      void importWorkspaceMirrorFromMainPayload(payload);
    });
  }
  if (typeof window !== "undefined" && window.archonDesktop?.onWorkspaceWpnPersisted) {
    window.archonDesktop.onWorkspaceWpnPersisted(() => {
      void import("../workspace-rxdb/wpn-persist-refetch").then((m) =>
        m.scheduleDebouncedNotesRefetchAfterWpnPersist(),
      );
    });
  }
})();
