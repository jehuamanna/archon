import { BrowserWindow, app, ipcMain } from "electron";
import { createCloudWpnWindow, createLocalVaultWindow } from "./create-cloud-wpn-window";
import { writePrimaryWpnBackend } from "./electron-launch-profile";
import { ctx } from "./main-context";
import { IPC_CHANNELS } from "../shared/ipc-channels";

const LOAD_WAIT_MS = 120_000;

function bindMainWindowPromotion(newWin: BrowserWindow, sender: BrowserWindow): void {
  if (ctx.mainWindow === sender) {
    ctx.mainWindow = newWin;
    newWin.on("closed", () => {
      if (ctx.mainWindow === newWin) {
        ctx.mainWindow = null;
      }
    });
  }
}

/**
 * After the new window finishes loading, persist file-first cold start, optionally promote
 * `ctx.mainWindow`, focus the new window, and close the sender (avoids a zero-window gap on Linux).
 */
function openNewWindowAndCloseSender(
  sender: BrowserWindow,
  newWin: BrowserWindow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const fail = (error: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (!newWin.isDestroyed()) {
        newWin.close();
      }
      resolve({ ok: false, error });
    };
    const timer = setTimeout(() => {
      fail("Timed out waiting for the new window to load");
    }, LOAD_WAIT_MS);

    const finishOk = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      writePrimaryWpnBackend(app.getPath("userData"), "file");
      bindMainWindowPromotion(newWin, sender);
      try {
        if (!newWin.isDestroyed()) {
          newWin.show();
          newWin.focus();
        }
      } catch {
        /* ignore */
      }
      if (!sender.isDestroyed()) {
        sender.close();
      }
      resolve({ ok: true });
    };

    newWin.webContents.once("did-fail-load", (_e, errorCode, _desc, validatedURL, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }
      fail(`Load failed (${errorCode}): ${validatedURL}`);
    });

    newWin.webContents.once("did-finish-load", () => {
      finishOk();
    });
  });
}

export function registerElectronWpnWindowHandoffIpc(): void {
  ipcMain.removeHandler(IPC_CHANNELS.ELECTRON_OPEN_CLOUD_WPN_WINDOW_CLOSE_SENDER);
  ipcMain.handle(IPC_CHANNELS.ELECTRON_OPEN_CLOUD_WPN_WINDOW_CLOSE_SENDER, async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender || sender.isDestroyed()) {
      return { ok: false as const, error: "No sender window" };
    }
    const newWin = createCloudWpnWindow();
    try {
      newWin.setBounds(sender.getBounds());
    } catch {
      /* ignore */
    }
    return openNewWindowAndCloseSender(sender, newWin);
  });

  ipcMain.removeHandler(IPC_CHANNELS.ELECTRON_OPEN_FILE_WPN_WINDOW_CLOSE_SENDER);
  ipcMain.handle(IPC_CHANNELS.ELECTRON_OPEN_FILE_WPN_WINDOW_CLOSE_SENDER, async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender || sender.isDestroyed()) {
      return { ok: false as const, error: "No sender window" };
    }
    const newWin = createLocalVaultWindow();
    try {
      newWin.setBounds(sender.getBounds());
    } catch {
      /* ignore */
    }
    return openNewWindowAndCloseSender(sender, newWin);
  });
}
