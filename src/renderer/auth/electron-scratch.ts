import { isElectronUserAgent } from "../archon-web-shim";
import { readElectronRunMode } from "./electron-run-mode";

/** RxDB segment for ephemeral Electron scratch notes (no on-disk workspace). */
export const ELECTRON_SCRATCH_CLOUD_USER_ID = "__archon_electron_scratch__";

export function isElectronScratchSession(): boolean {
  if (typeof window === "undefined" || !isElectronUserAgent()) {
    return false;
  }
  return readElectronRunMode() === "scratch";
}

/** Wipe scratch IndexedDB (WPN + cloud-notes segment) and reload (run mode `scratch` stays in localStorage). */
export async function resetElectronScratchClearData(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  const { destroyCloudNotesDbForUser } = await import("../cloud-sync/cloud-notes-rxdb");
  const { destroyWpnScratchIndexedDb } = await import("../wpnscratch/wpn-scratch-store");
  await destroyCloudNotesDbForUser(ELECTRON_SCRATCH_CLOUD_USER_ID);
  await destroyWpnScratchIndexedDb();
  window.location.reload();
}
