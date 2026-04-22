import { app, ipcMain, shell } from "electron";
import { registry } from "../core/registry";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { isSafePluginName, isValidNoteType } from "../shared/validators";
import { ctx, getPluginLoader } from "./main-context";

export function registerRunAppReadyUiPluginIpc(): void {
  ipcMain.handle(IPC_CHANNELS.UI_TOGGLE_DEVTOOLS, () => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.toggleDevTools();
    }
    return { success: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.UI_QUIT_APP, () => {
    app.quit();
    return { success: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.UI_RELOAD_WINDOW, () => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.reload();
    }
    return { success: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.UI_OPEN_EXTERNAL_URL, (_e, url: unknown) => {
    if (typeof url !== "string" || !url.trim()) {
      return { ok: false as const, error: "Invalid url" };
    }
    const trimmed = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false as const, error: "Invalid URL" };
    }
    const proto = parsed.protocol.toLowerCase();
    if (proto !== "http:" && proto !== "https:" && proto !== "mailto:") {
      return { ok: false as const, error: "Unsupported protocol" };
    }
    return shell
      .openExternal(trimmed)
      .then(() => ({ ok: true as const }))
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));
  });

  ipcMain.handle(IPC_CHANNELS.PLUGIN_GET_DISABLED_IDS, () =>
    getPluginLoader().getDisabledUserPluginIdsForIpc(),
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGIN_SET_ENABLED,
    (_e, payload: unknown) => {
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as { pluginId?: unknown }).pluginId !== "string" ||
        typeof (payload as { enabled?: unknown }).enabled !== "boolean"
      ) {
        return { success: false as const, error: "Invalid payload" };
      }
      const { pluginId, enabled } = payload as {
        pluginId: string;
        enabled: boolean;
      };
      if (!isSafePluginName(pluginId)) {
        return { success: false as const, error: "Invalid plugin id" };
      }
      try {
        getPluginLoader().setUserPluginEnabled(pluginId, enabled);
        getPluginLoader().reload(registry);
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send(IPC_CHANNELS.PLUGINS_CHANGED);
        }
        return { success: true as const };
      } catch (err) {
        return {
          success: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.PLUGIN_GET_INVENTORY, () =>
    getPluginLoader().getPluginInventory(),
  );

  ipcMain.handle(
    IPC_CHANNELS.GET_PLUGIN_RENDERER_UI_META,
    (_e, noteType: string) => {
      if (!isValidNoteType(noteType)) {
        return null;
      }
      const r = registry.getRenderer(noteType);
      if (!r) {
        return null;
      }
      return {
        theme: r.theme ?? "inherit",
        designSystemVersion: r.designSystemVersion,
        deferDisplayUntilContentReady:
          r.deferDisplayUntilContentReady === true,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.GET_PLUGIN_MANIFEST_UI, (_e, name: string) => {
    if (typeof name !== "string" || name.trim().length === 0) {
      return null;
    }
    return getPluginLoader().getManifestUiFields(name.trim());
  });
}
