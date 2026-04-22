import { spawn } from "child_process";
import { ipcMain, shell } from "electron";
import * as fs from "fs";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { isSafePluginName } from "../shared/validators";
import { getPluginLoader } from "./main-context";
import {
  setIdeWorkspaceWatch,
  showOpenDialogWithParent,
} from "./main-helpers";

export function registerStaticIpcPluginWorkspaceHandlers(): void {
ipcMain.handle(IPC_CHANNELS.GET_PLUGIN_LOAD_ISSUES, async () => {
  return getPluginLoader().getPluginLoadIssues();
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_LIST_WORKSPACE_FOLDERS, async () => {
  return getPluginLoader().listPluginWorkspaceFolders();
});

ipcMain.handle(IPC_CHANNELS.PLUGIN_LOAD_ARCHON_FROM_PARENT, async () => {
  const result = await showOpenDialogWithParent({
    properties: ["openDirectory"],
    title:
      "Parent folder — immediate subfolders containing .archonplugin are registered",
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, cancelled: true, added: [], warnings: [], errors: [] };
  }
  const scan = getPluginLoader().loadArchonPluginsFromParentDir(result.filePaths[0]);
  return { success: true, ...scan };
});

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_REMOVE_EXTERNAL_PLUGIN,
  async (_event, pluginId: string) => {
    if (!isSafePluginName(pluginId)) {
      return { success: false, error: "Invalid plugin id" };
    }
    const ok = getPluginLoader().removeExternalPluginWorkspace(pluginId);
    return ok
      ? { success: true }
      : {
          success: false,
          error:
            "Not found in external list (sources/ plugins are not removed here)",
        };
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_RENAME_SOURCE_PATH,
  async (
    _event,
    installedFolderName: string,
    fromRelative: string,
    toRelative: string,
  ) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    try {
      getPluginLoader().renamePluginSourcePath(
        installedFolderName,
        fromRelative,
        toRelative,
      );
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_COPY_SOURCE_WITHIN_WORKSPACE,
  async (
    _event,
    installedFolderName: string,
    fromRelative: string,
    toRelative: string,
  ) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    try {
      getPluginLoader().copyPluginSourceWithinWorkspace(
        installedFolderName,
        fromRelative,
        toRelative,
      );
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_COPY_SOURCE_BETWEEN_WORKSPACES,
  async (
    _event,
    fromPlugin: string,
    fromRelative: string,
    toPlugin: string,
    toRelative: string,
  ) => {
    if (!isSafePluginName(fromPlugin) || !isSafePluginName(toPlugin)) {
      return { success: false, error: "Invalid plugin name" };
    }
    if (typeof fromRelative !== "string" || typeof toRelative !== "string") {
      return { success: false, error: "Invalid path" };
    }
    try {
      getPluginLoader().copyPluginSourceBetweenWorkspaces(
        fromPlugin,
        fromRelative,
        toPlugin,
        toRelative,
      );
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_MOVE_SOURCE_BETWEEN_WORKSPACES,
  async (
    _event,
    fromPlugin: string,
    fromRelative: string,
    toPlugin: string,
    toRelative: string,
  ) => {
    if (!isSafePluginName(fromPlugin) || !isSafePluginName(toPlugin)) {
      return { success: false, error: "Invalid plugin name" };
    }
    if (typeof fromRelative !== "string" || typeof toRelative !== "string") {
      return { success: false, error: "Invalid path" };
    }
    try {
      getPluginLoader().movePluginSourceBetweenWorkspaces(
        fromPlugin,
        fromRelative,
        toPlugin,
        toRelative,
      );
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_GET_SOURCE_ENTRY_KIND,
  async (_event, installedFolderName: string, relativePath: string) => {
    if (!isSafePluginName(installedFolderName)) {
      return "missing" as const;
    }
    if (typeof relativePath !== "string") {
      return "missing" as const;
    }
    return getPluginLoader().getPluginSourceEntryKind(
      installedFolderName,
      relativePath,
    );
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_GET_SOURCE_FILE_META,
  async (_event, installedFolderName: string, relativePath: string) => {
    if (!isSafePluginName(installedFolderName)) {
      return null;
    }
    if (typeof relativePath !== "string") {
      return null;
    }
    return getPluginLoader().getPluginSourceFileMeta(
      installedFolderName,
      relativePath,
    );
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_OPEN_WORKSPACE_IN_EDITOR,
  async (
    _event,
    payload: { editor: string; customBin?: string; pluginName: string },
  ) => {
    if (
      !payload ||
      typeof payload.pluginName !== "string" ||
      !isSafePluginName(payload.pluginName)
    ) {
      return { success: false as const, error: "Invalid plugin" };
    }
    const root = getPluginLoader().getPluginWorkspaceAbsolutePath(
      payload.pluginName,
    );
    if (!root || !fs.existsSync(root)) {
      return { success: false as const, error: "Workspace path not found" };
    }
    let cmd: string;
    switch (payload.editor) {
      case "vscode":
        cmd = "code";
        break;
      case "cursor":
        cmd = "cursor";
        break;
      case "windsurf":
        cmd = "windsurf";
        break;
      case "anigravity":
        cmd = "antigravity";
        break;
      case "custom":
        if (!payload.customBin?.trim()) {
          return {
            success: false as const,
            error: "Custom command required",
          };
        }
        cmd = payload.customBin.trim();
        break;
      default:
        return { success: false as const, error: "Unknown editor" };
    }
    try {
      const child = spawn(cmd, ["."], {
        cwd: root,
        shell: true,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { success: true as const };
    } catch (e) {
      return {
        success: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_REVEAL_WORKSPACE,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false as const, error: "Invalid plugin" };
    }
    const root = getPluginLoader().getPluginWorkspaceAbsolutePath(pluginName);
    if (!root || !fs.existsSync(root)) {
      return { success: false as const, error: "Workspace path not found" };
    }
    const err = await shell.openPath(root);
    if (err) {
      return { success: false as const, error: err };
    }
    return { success: true as const };
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_SCAFFOLD_PLUGIN_WORKSPACE,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false as const, error: "Invalid plugin name" };
    }
    try {
      return getPluginLoader().scaffoldPluginWorkspace(pluginName);
    } catch (e) {
      return {
        success: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_COPY_DIST_TO_FOLDER,
  async (_event, installedFolderName: string) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    const pick = await showOpenDialogWithParent({
      properties: ["openDirectory", "createDirectory"],
      title: "Copy dist/ contents into this folder",
    });
    if (pick.canceled || pick.filePaths.length === 0) {
      return { success: false, error: "Cancelled" };
    }
    return getPluginLoader().copyPluginDistContentsToDirectory(
      installedFolderName,
      pick.filePaths[0],
    );
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_IDE_SET_WORKSPACE_WATCH,
  async (_event, pluginName: string | null) => {
    setIdeWorkspaceWatch(
      pluginName && isSafePluginName(pluginName) ? pluginName : null,
    );
    return { success: true };
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_LIST_SOURCE_FILES,
  async (_event, installedFolderName: string) => {
    if (!isSafePluginName(installedFolderName)) {
      throw new Error("Invalid plugin name");
    }
    return getPluginLoader().listPluginSourceFiles(installedFolderName);
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_READ_SOURCE_FILE,
  async (_event, installedFolderName: string, relativePath: string) => {
    if (!isSafePluginName(installedFolderName)) {
      throw new Error("Invalid plugin name");
    }
    try {
      return getPluginLoader().readPluginSourceFile(
        installedFolderName,
        relativePath,
      );
    } catch (e) {
      /** Missing optional files (e.g. .prettierrc) must not log as IPC handler errors. */
      if (e instanceof Error && e.message === "File not found") {
        return null;
      }
      throw e;
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_WRITE_SOURCE_FILE,
  async (
    _event,
    installedFolderName: string,
    relativePath: string,
    content: string,
  ) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    try {
      getPluginLoader().writePluginSourceFile(
        installedFolderName,
        relativePath,
        content,
      );
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_MKDIR_SOURCE,
  async (_event, installedFolderName: string, relativeDir: string) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    try {
      getPluginLoader().mkdirPluginSourceDir(installedFolderName, relativeDir);
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_CREATE_SOURCE_FILE,
  async (
    _event,
    installedFolderName: string,
    relativePath: string,
    content?: string,
  ) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    try {
      getPluginLoader().createPluginSourceFile(
        installedFolderName,
        relativePath,
        typeof content === "string" ? content : "",
      );
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PLUGIN_DELETE_SOURCE_PATH,
  async (_event, installedFolderName: string, relativePath: string) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    try {
      getPluginLoader().deletePluginSourcePath(installedFolderName, relativePath);
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);
}
