import { app, ipcMain } from "electron";
import * as fs from "fs";
import { appendPluginAudit } from "../core/plugin-audit";
import { getArchonUserPluginsDir } from "../core/archon-paths";
import { resolveArchonPluginUiMonacoLib } from "../core/resolve-archon-plugin-ui";
import { seedSamplePluginsToUserDir } from "../core/seed-user-plugins";
import { registry } from "../core/registry";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { toFileUri } from "../shared/file-uri";
import { isSafePluginName } from "../shared/validators";
import { ctx, getPluginLoader } from "./main-context";
import {
  broadcastPluginsChanged,
  setIdeWorkspaceWatch,
  showOpenDialogWithParent,
} from "./main-helpers";

function toFileUriForMonaco(absPath: string): string {
  return toFileUri(absPath);
}

export function registerStaticIpcPluginIdeMaintHandlers(): void {
ipcMain.handle(IPC_CHANNELS.PLUGIN_SELECT_IMPORT_FILES, async () => {
  const result = await showOpenDialogWithParent({
    properties: ["openFile", "multiSelections"],
    title: "Import files into plugin workspace",
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths;
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_SELECT_IMPORT_DIRECTORY, async () => {
  const result = await showOpenDialogWithParent({
    properties: ["openDirectory"],
    title: "Choose folder (plugin root or folder to merge into current plugin)",
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_IMPORT_FILES_INTO_WORKSPACE,
  async (
    _event,
    installedFolderName: string,
    absolutePaths: string[],
    destRelativeBase?: string,
  ) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    if (!Array.isArray(absolutePaths)) {
      return { success: false, error: "Invalid paths" };
    }
    return getPluginLoader().importExternalFilesIntoWorkspace(
      installedFolderName,
      absolutePaths,
      typeof destRelativeBase === "string" ? destRelativeBase : "",
    );
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_IMPORT_DIRECTORY_INTO_WORKSPACE,
  async (
    _event,
    installedFolderName: string,
    absoluteDir: string,
    destRelativeBase?: string,
  ) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    if (typeof absoluteDir !== "string") {
      return { success: false, error: "Invalid directory" };
    }
    return getPluginLoader().importExternalDirectoryIntoWorkspace(
      installedFolderName,
      absoluteDir,
      typeof destRelativeBase === "string" ? destRelativeBase : "",
    );
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_IMPORT_DIRECTORY_AS_NEW_WORKSPACE,
  async (_event, absoluteDir: unknown) => {
    if (typeof absoluteDir !== "string") {
      return { success: false, error: "Invalid directory" };
    }
    try {
      return getPluginLoader().importDirectoryAsNewWorkspace(absoluteDir);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(IPC_CHANNELS.PLUGIN_TYPECHECK, async (_event, pluginName: string) => {
  if (!isSafePluginName(pluginName)) {
    return {
      success: false,
      error: "Invalid plugin name",
      diagnostics: [] as {
        relativePath: string;
        line: number;
        column: number;
        message: string;
        category: "error" | "warning" | "suggestion";
        code: number | undefined;
      }[],
    };
  }
  try {
    return getPluginLoader().runTypecheckOnPluginWorkspace(pluginName);
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      diagnostics: [],
    };
  }
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_IDE_TYPINGS, async () => {
  const libs: { fileName: string; content: string }[] = [];
  const tryAdd = (request: string) => {
    try {
      const resolved = require.resolve(request);
      const content = fs.readFileSync(resolved, "utf8");
      libs.push({
        fileName: toFileUriForMonaco(resolved),
        content,
      });
    } catch {
      // optional typings
    }
  };
  tryAdd("@types/react/index.d.ts");
  tryAdd("@types/react-dom/index.d.ts");
  const archonSdk = resolveArchonPluginUiMonacoLib();
  if (archonSdk) {
    libs.push(archonSdk);
  }
  return { libs };
});

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_IDE_PLUGIN_TYPINGS,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return null;
    }
    return getPluginLoader().getIdePluginVirtualTypings(pluginName);
  },
);

ipcMain.handle(IPC_CHANNELS.PLUGIN_RELOAD_REGISTRY, async () => {
  try {
    getPluginLoader().reload(registry);
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send(IPC_CHANNELS.PLUGINS_CHANGED);
    }
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_GET_USER_PLUGINS_DIR, () => {
  try {
    return { path: getArchonUserPluginsDir(app.getPath("userData")) };
  } catch (e) {
    return {
      path: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_RESET_USER_DATA_PLUGINS, async () => {
  const pathResult: { success: boolean; path: string; error?: string } = {
    success: false,
    path: "",
  };
  try {
    const pluginsPath = getArchonUserPluginsDir(app.getPath("userData"));
    pathResult.path = pluginsPath;
    if (fs.existsSync(pluginsPath)) {
      fs.rmSync(pluginsPath, { recursive: true, force: true });
    }
    fs.mkdirSync(pluginsPath, { recursive: true });
    seedSamplePluginsToUserDir(pluginsPath);
    setIdeWorkspaceWatch(null);
    getPluginLoader().reload(registry);
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send(IPC_CHANNELS.PLUGINS_CHANGED);
    }
    pathResult.success = true;
    return pathResult;
  } catch (e) {
    pathResult.error = e instanceof Error ? e.message : String(e);
    return pathResult;
  }
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_MAINT_DELETE_BIN_AND_CACHES, async () => {
  try {
    getPluginLoader().clearBinAndPluginCaches(registry);
    setIdeWorkspaceWatch(null);
    broadcastPluginsChanged();
    return { success: true as const };
  } catch (e) {
    return {
      success: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_MAINT_FORMAT_ARCHON, async () => {
  try {
    getPluginLoader().formatArchonPluginData(registry);
    setIdeWorkspaceWatch(null);
    broadcastPluginsChanged();
    return { success: true as const };
  } catch (e) {
    return {
      success: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_MAINT_DELETE_SOURCES, async () => {
  try {
    getPluginLoader().deleteAllPluginSources(registry);
    setIdeWorkspaceWatch(null);
    broadcastPluginsChanged();
    return { success: true as const };
  } catch (e) {
    return {
      success: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

ipcMain.handle(IPC_CHANNELS.GET_INSTALLED_PLUGINS, async () => {
  return getPluginLoader().getUserFacingLoadedPluginsFromCatalog();
});

ipcMain.handle(
  IPC_CHANNELS.UNINSTALL_PLUGIN,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    const userDataPath = app.getPath("userData");
    try {
      getPluginLoader().uninstallPlugin(pluginName, registry);
      appendPluginAudit(userDataPath, {
        action: "uninstall",
        pluginName,
        ok: true,
      });
      return { success: true };
    } catch (error) {
      console.error("[Main] Plugin uninstall failed:", error);
      appendPluginAudit(userDataPath, {
        action: "uninstall",
        pluginName,
        ok: false,
        detail:
          error instanceof Error ? error.message : "Unknown error",
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
);
}
