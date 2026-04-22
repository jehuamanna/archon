import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import {
  clearMainDebugLogBuffer,
  getMainDebugLogBuffer,
  ingestRendererStructuredLog,
} from "./main-process-debug-log";
import type { ClientLogPayload } from "../shared/client-log";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { broadcastNativeThemeToRenderers } from "./main-helpers";
import { registerElectronWpnWindowHandoffIpc } from "./electron-wpn-window-handoff-ipc";
import { setWebContentsWpnBackend } from "./electron-wpn-backend";
import { writePrimaryWpnBackend, type ElectronPrimaryWpnBackend } from "./electron-launch-profile";

export function registerRunAppReadyEarlyIpc(): void {
  registerElectronWpnWindowHandoffIpc();
  ipcMain.removeHandler(IPC_CHANNELS.ELECTRON_APPLY_PRIMARY_WPN_BACKEND);
  ipcMain.handle(
    IPC_CHANNELS.ELECTRON_APPLY_PRIMARY_WPN_BACKEND,
    (_event, raw: unknown) => {
      const p = raw as { backend?: string; relaunch?: boolean };
      const backend: ElectronPrimaryWpnBackend =
        p.backend === "cloud" ? "cloud" : "file";
      const userDataPath = app.getPath("userData");
      writePrimaryWpnBackend(userDataPath, backend);
      if (p.relaunch === true) {
        app.relaunch();
        app.exit(0);
      }
      return { ok: true as const };
    },
  );

  ipcMain.removeHandler(IPC_CHANNELS.ELECTRON_SET_WPN_BACKEND_FOR_SENDER);
  ipcMain.handle(IPC_CHANNELS.ELECTRON_SET_WPN_BACKEND_FOR_SENDER, (event, raw: unknown) => {
    const p = raw as { mode?: string };
    const mode: "file" | "cloud" = p.mode === "cloud" ? "cloud" : "file";
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { ok: false as const, error: "No sender window" };
    }
    setWebContentsWpnBackend(win.webContents, mode);
    return { ok: true as const };
  });

  ipcMain.removeHandler(IPC_CHANNELS.PLUGIN_IDE_GET_MAIN_DEBUG_LOGS);
  ipcMain.removeHandler(IPC_CHANNELS.PLUGIN_IDE_CLEAR_MAIN_DEBUG_LOGS);
  ipcMain.handle(IPC_CHANNELS.PLUGIN_IDE_GET_MAIN_DEBUG_LOGS, () =>
    getMainDebugLogBuffer(),
  );
  ipcMain.handle(IPC_CHANNELS.PLUGIN_IDE_CLEAR_MAIN_DEBUG_LOGS, () => {
    clearMainDebugLogBuffer();
    return { success: true as const };
  });

  ipcMain.removeAllListeners(IPC_CHANNELS.ARCHON_CLIENT_LOG);
  ipcMain.on(IPC_CHANNELS.ARCHON_CLIENT_LOG, (_event, raw: unknown) => {
    const p = raw as Partial<ClientLogPayload>;
    if (typeof p.component !== "string" || typeof p.message !== "string") {
      return;
    }
    const lv = p.level;
    const level: ClientLogPayload["level"] =
      lv === "info" || lv === "warn" || lv === "error" || lv === "debug" || lv === "log"
        ? lv
        : "log";
    ingestRendererStructuredLog({
      level,
      component: p.component.slice(0, 120),
      message: p.message.slice(0, 12_000),
      noteId: typeof p.noteId === "string" ? p.noteId.slice(0, 200) : undefined,
      noteTitle:
        typeof p.noteTitle === "string" ? p.noteTitle.slice(0, 500) : undefined,
    });
  });

  nativeTheme.on("updated", broadcastNativeThemeToRenderers);

  ipcMain.handle(IPC_CHANNELS.UI_GET_NATIVE_THEME_DARK, () => {
    return nativeTheme.shouldUseDarkColors;
  });

  ipcMain.handle(IPC_CHANNELS.NPM_REGISTRY_SEARCH, async (_event, query: string) => {
    if (typeof query !== "string" || query.length > 200) {
      return {
        success: false,
        error: "Invalid query",
        results: [] as {
          name: string;
          version: string;
          description: string;
          popularity: number;
        }[],
      };
    }
    const q = query.trim();
    if (q.length === 0) {
      return { success: true, results: [] };
    }
    try {
      const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=20`;
      const res = await fetch(url);
      if (!res.ok) {
        return {
          success: false,
          error: `HTTP ${res.status}`,
          results: [],
        };
      }
      const data = (await res.json()) as {
        objects?: Array<{
          package: {
            name: string;
            version: string;
            description?: string;
          };
          score?: { detail?: { popularity?: number } };
        }>;
      };
      const results = (data.objects ?? [])
        .map((o) => ({
          name: o.package.name,
          version: o.package.version,
          description: o.package.description ?? "",
          popularity: o.score?.detail?.popularity ?? 0,
        }))
        .sort((a, b) => b.popularity - a.popularity);
      return { success: true, results };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
        results: [],
      };
    }
  });
}
