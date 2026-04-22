import { isElectronUserAgent } from "../archon-web-shim";
import { isElectronScratchSession } from "./electron-scratch";
import { isWebScratchSession } from "./web-scratch";

/** Anonymous web try-out (`archon.web.scratchSession`). */
export function isBrowserTryoutScratch(): boolean {
  return isWebScratchSession();
}

/** Desktop “Scratch” run mode (`archon.electron.runMode`). */
export function isElectronRunModeScratch(): boolean {
  return isElectronScratchSession();
}

/**
 * Any ephemeral scratch UX: web try-out or Electron scratch mode.
 * Does not imply WPN storage location (web shim vs empty workspace + IDB overlay).
 */
export function isEphemeralScratchExperience(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (isElectronUserAgent()) {
    return isElectronScratchSession();
  }
  return isWebScratchSession();
}
