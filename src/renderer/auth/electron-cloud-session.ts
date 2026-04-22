import { readElectronRunMode } from "./electron-run-mode";

function isElectronRenderer(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
}

/**
 * True when this renderer should behave as a cloud WPN session: persisted run mode `cloud`
 * on a file-argv window, or a dedicated argv-cloud `BrowserWindow` (File → New cloud WPN window).
 */
export function isElectronCloudWpnSession(): boolean {
  if (typeof window === "undefined" || !isElectronRenderer()) {
    return false;
  }
  if (readElectronRunMode() === "cloud") {
    return true;
  }
  return window.__ARCHON_ELECTRON_WPN_BACKEND__ === "cloud";
}
