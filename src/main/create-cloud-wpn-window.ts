import { BrowserWindow } from "electron";
import { registerWebContentsWpnBackend } from "./electron-wpn-backend";
import {
  DEV_SERVER_NET_ERRORS,
  devServerMissingDataUrl,
  resolveMainWindowLoadUrl,
} from "./main-window-url";

declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

function attachDevFailLoadHandler(win: BrowserWindow, initialLoadUrl: string): void {
  if (process.env.NODE_ENV !== "development") {
    return;
  }
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || validatedURL.startsWith("data:")) {
      return;
    }
    if (!DEV_SERVER_NET_ERRORS.has(errorCode)) {
      return;
    }
    let expected: URL;
    let got: URL;
    try {
      expected = new URL(initialLoadUrl);
      got = new URL(validatedURL);
    } catch {
      return;
    }
    if (got.origin !== expected.origin) {
      return;
    }
    if (win.isDestroyed()) {
      return;
    }
    void win.loadURL(devServerMissingDataUrl(initialLoadUrl));
  });
}

function createBrowserWindowWithBackend(mode: "file" | "cloud"): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--archon-electron-wpn-backend=${mode}`],
      devTools: true,
    },
  });
  registerWebContentsWpnBackend(win.webContents, mode);

  const initialLoadUrl = resolveMainWindowLoadUrl();
  void win.loadURL(initialLoadUrl);
  attachDevFailLoadHandler(win, initialLoadUrl);

  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools();
  } else if (process.env.ARCHON_OPEN_DEVTOOLS === "1") {
    win.webContents.openDevTools();
  }

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) {
      return;
    }
    if (win.isDestroyed()) {
      return;
    }
    if (input.key === "F12") {
      event.preventDefault();
      win.webContents.toggleDevTools();
      return;
    }
    const primary = input.control || input.meta;
    if (primary && input.shift && input.key.toLowerCase() === "i") {
      event.preventDefault();
      win.webContents.toggleDevTools();
      return;
    }
    if (
      process.platform === "darwin" &&
      input.meta &&
      input.alt &&
      input.key.toLowerCase() === "i"
    ) {
      event.preventDefault();
      win.webContents.toggleDevTools();
      return;
    }
    if (!primary || input.alt || input.shift) {
      return;
    }
    if (input.key.toLowerCase() !== "r") {
      return;
    }
    event.preventDefault();
    win.webContents.reload();
  });

  return win;
}

/** Second+ window using on-disk vault (IPC file SoT). */
export function createLocalVaultWindow(): BrowserWindow {
  return createBrowserWindowWithBackend("file");
}

/** Cloud (sync-api) WPN in renderer; must not use file vault IPC for WPN mutations. */
export function createCloudWpnWindow(): BrowserWindow {
  return createBrowserWindowWithBackend("cloud");
}
