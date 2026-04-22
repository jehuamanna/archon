import { app, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { appendPluginAudit } from "../core/plugin-audit";
import { packageManager } from "../core/package-manager";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { isSafePluginName } from "../shared/validators";
import { ctx, getPluginLoader } from "./main-context";
import { getDialogParent, showOpenDialogWithParent } from "./main-helpers";
import { registry } from "../core/registry";
import { emitPluginProgress } from "../core/plugin-progress";
import * as crypto from "crypto";
import {
  filterMarketplaceIndexByExistingFiles,
  loadMarketplaceIndex,
} from "../shared/marketplace-index";

function resolveElectronMarketplaceDir(): string {
  const env = process.env.ARCHON_MARKETPLACE_DIR?.trim();
  if (env) {
    return path.resolve(env);
  }
  const packaged = path.join(process.resourcesPath, "marketplace", "plugins");
  if (app.isPackaged && fs.existsSync(packaged)) {
    return packaged;
  }
  return path.resolve(process.cwd(), "dist", "plugins");
}

export function registerStaticIpcPluginPackagingHandlers(): void {
ipcMain.handle(IPC_CHANNELS.SELECT_ZIP_FILE, async () => {
  const { dialog } = require("electron");
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      {
        name: "Archon plugin",
        extensions: [
          "archonplugin",
          "archonplugin-dev",
          "Archonplugin",
          "Archonplugin-dev",
          "zip",
        ],
      },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle(
  IPC_CHANNELS.PUBLISH_PLUGIN_AS_FILE,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    const { dialog } = require("electron");
    const userDataPath = app.getPath("userData");
    try {
      const defaultFile = `${pluginName}.archonplugin`;

      const parent = getDialogParent();
      const save = parent
        ? await dialog.showSaveDialog(parent, {
            title: "Publish plugin as file (.archonplugin)",
            defaultPath: defaultFile,
            filters: [{ name: "Archon plugin", extensions: ["archonplugin"] }],
            properties: ["createDirectory", "showOverwriteConfirmation"],
          })
        : await dialog.showSaveDialog({
        title: "Publish plugin as file (.archonplugin)",
        defaultPath: defaultFile,
        filters: [{ name: "Archon plugin", extensions: ["archonplugin"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (save.canceled || !save.filePath) {
        return { success: false, error: "Cancelled" };
      }
      const outFile = save.filePath.toLowerCase().endsWith(".archonplugin")
        ? save.filePath
        : `${save.filePath}.archonplugin`;

      emitPluginProgress({
        op: "npm",
        phase: "start",
        pluginName,
        message: "Install dependencies…",
      });
      const install = await getPluginLoader().installPluginDependencies(pluginName);
      if (!install.success) {
        emitPluginProgress({
          op: "npm",
          phase: "error",
          pluginName,
          message: install.error ?? "npm install failed",
        });
        appendPluginAudit(userDataPath, {
          action: "publish",
          pluginName,
          ok: false,
          detail: install.error,
        });
        return { success: false, error: install.error ?? "npm install failed" };
      }
      emitPluginProgress({
        op: "npm",
        phase: "done",
        pluginName,
        message: "Dependencies installed.",
      });

      const stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), "archon-publish-"));
      try {
        const produced = await getPluginLoader().exportProductionPackage(
          pluginName,
          stagingParent,
        );

        // Ensure lowercase extension on final output.
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.copyFileSync(produced, outFile);
      } finally {
        fs.rmSync(stagingParent, { recursive: true, force: true });
      }

      appendPluginAudit(userDataPath, {
        action: "publish",
        pluginName,
        ok: true,
        detail: path.basename(outFile),
      });

      emitPluginProgress({
        op: "export",
        phase: "done",
        pluginName,
        message: `Published: ${path.basename(outFile)}`,
      });

      return { success: true, path: outFile };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emitPluginProgress({
        op: "export",
        phase: "error",
        pluginName,
        message: msg,
      });
      appendPluginAudit(userDataPath, {
        action: "publish",
        pluginName,
        ok: false,
        detail: msg,
      });
      return { success: false, error: msg };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.PUBLISH_PLUGIN_TO_MARKETPLACE,
  async (
    _event,
    payload: { pluginName?: unknown; options?: unknown },
  ): Promise<{ success: boolean; error?: string }> => {
    const pluginName =
      typeof payload?.pluginName === "string" ? payload.pluginName.trim() : "";
    const options = (payload?.options ?? {}) as { baseUrl?: unknown; token?: unknown };
    const baseUrl =
      typeof options.baseUrl === "string" ? options.baseUrl.trim().replace(/\/$/, "") : "";
    const token = typeof options.token === "string" ? options.token.trim() : "";

    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      return { success: false, error: "Invalid marketplace baseUrl" };
    }
    if (!token) {
      return { success: false, error: "Missing auth token" };
    }

    const userDataPath = app.getPath("userData");
    const stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), "archon-market-publish-"));
    try {
      emitPluginProgress({
        op: "export",
        phase: "start",
        pluginName,
        message: "Building production package…",
      });
      const produced = await getPluginLoader().exportProductionPackage(
        pluginName,
        stagingParent,
      );
      const buf = fs.readFileSync(produced);
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

      const packageBase = path.basename(produced);
      // Best-effort derive version from filename: name-version.archonplugin
      const m = packageBase.match(/^(.+)-([0-9A-Za-z.+-]+)\.archonplugin$/);
      const pluginId = m?.[1] ?? pluginName;
      const version = m?.[2] ?? "0.0.0";

      emitPluginProgress({
        op: "export",
        phase: "done",
        pluginName,
        message: `Built ${packageBase}`,
      });

      emitPluginProgress({
        op: "npm",
        phase: "start",
        pluginName,
        message: "Requesting upload URL…",
      });

      const initRes = await fetch(`${baseUrl}/api/v1/marketplace/publish/init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: pluginId,
          version,
          contentType: "application/octet-stream",
          sizeBytes: buf.byteLength,
          sha256,
        }),
      });
      const initText = await initRes.text();
      if (!initRes.ok) {
        return { success: false, error: initText || `init failed (${initRes.status})` };
      }
      const init = JSON.parse(initText) as {
        uploadUrl: string;
        objectKey: string;
        finalizeToken: string;
      };

      emitPluginProgress({
        op: "npm",
        phase: "done",
        pluginName,
        message: "Uploading…",
      });

      const putRes = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-amz-meta-sha256": sha256,
        },
        body: buf,
      });
      if (!putRes.ok) {
        const t = await putRes.text().catch(() => "");
        return { success: false, error: t || `upload failed (${putRes.status})` };
      }

      emitPluginProgress({
        op: "npm",
        phase: "done",
        pluginName,
        message: "Finalizing publish…",
      });

      const finRes = await fetch(`${baseUrl}/api/v1/marketplace/publish/finalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          finalizeToken: init.finalizeToken,
          objectKey: init.objectKey,
        }),
      });
      const finText = await finRes.text();
      if (!finRes.ok) {
        return { success: false, error: finText || `finalize failed (${finRes.status})` };
      }

      appendPluginAudit(userDataPath, {
        action: "publish",
        pluginName,
        ok: true,
        detail: `marketplace:${pluginId}@${version}`,
      });

      emitPluginProgress({
        op: "export",
        phase: "done",
        pluginName,
        message: `Published ${pluginId} v${version}`,
      });

      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendPluginAudit(userDataPath, {
        action: "publish",
        pluginName,
        ok: false,
        detail: msg,
      });
      return { success: false, error: msg };
    } finally {
      fs.rmSync(stagingParent, { recursive: true, force: true });
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.EXPORT_PLUGIN_DEV,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    const { dialog } = require("electron");
    const result = await showOpenDialogWithParent({
      properties: ["openDirectory", "createDirectory"],
      title: "Export dev package (.Archonplugin-dev)",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: "Cancelled" };
    }
    try {
      const outPath = await getPluginLoader().exportPluginAsDev(
        pluginName,
        result.filePaths[0],
      );
      return { success: true, path: outPath };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.EXPORT_PLUGIN_PRODUCTION,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    const { dialog } = require("electron");
    const result = await showOpenDialogWithParent({
      properties: ["openDirectory", "createDirectory"],
      title: "Export production package (.Archonplugin)",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: "Cancelled" };
    }
    try {
      const outPath = await getPluginLoader().exportProductionPackage(
        pluginName,
        result.filePaths[0],
      );
      return { success: true, path: outPath };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.BUNDLE_PLUGIN_LOCAL,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    try {
      return await getPluginLoader().bundlePluginToLocalDist(pluginName);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.INSTALL_PLUGIN_DEPENDENCIES,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    const userDataPath = app.getPath("userData");
    const result = await getPluginLoader().installPluginDependencies(pluginName);
    if (result.log) {
      console.log("[Main] npm install log:\n", result.log);
    }
    appendPluginAudit(userDataPath, {
      action: "install-deps",
      pluginName,
      ok: result.success,
      detail: result.error,
    });
    return result;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CLEAR_PLUGIN_DEPENDENCY_CACHE,
  async (_event, pluginName: string) => {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    const userDataPath = app.getPath("userData");
    const result = getPluginLoader().clearPluginDependencyCache(pluginName);
    appendPluginAudit(userDataPath, {
      action: "clear-dep-cache",
      pluginName,
      ok: result.success,
      detail: result.error,
    });
    return result;
  },
);

ipcMain.handle(IPC_CHANNELS.CLEAR_ALL_PLUGIN_DEPENDENCY_CACHES, async () => {
  const userDataPath = app.getPath("userData");
  getPluginLoader().clearAllPluginDependencyCaches();
  appendPluginAudit(userDataPath, {
    action: "clear-all-dep-caches",
    ok: true,
  });
  return { success: true };
});

ipcMain.handle(IPC_CHANNELS.GET_PLUGIN_CACHE_STATS, async () => {
  return getPluginLoader().getPluginCacheStats();
});

ipcMain.handle(IPC_CHANNELS.IMPORT_PLUGIN, async (_event, zipPath: string) => {
  const userDataPath = app.getPath("userData");
  try {
    const { warnings } = await getPluginLoader().importFromZip(zipPath, registry);

    appendPluginAudit(userDataPath, {
      action: "import",
      detail: path.basename(zipPath),
      ok: true,
    });

    if (ctx.mainWindow) {
      ctx.mainWindow.webContents.send(IPC_CHANNELS.PLUGINS_CHANGED);
    }

    return { success: true, warnings };
  } catch (error: unknown) {
    console.error("[Main] Plugin import failed:", error);
    appendPluginAudit(userDataPath, {
      action: "import",
      detail: path.basename(zipPath),
      ok: false,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle(IPC_CHANNELS.VALIDATE_PLUGIN_ZIP, async (_event, zipPath: string) => {
  return packageManager.validatePackage(zipPath);
});

ipcMain.handle(IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS, async () => {
  const marketDir = resolveElectronMarketplaceDir();
  const loaded = loadMarketplaceIndex(marketDir);
  if (!loaded.ok) {
    return {
      filesBasePath: "",
      marketplaceDir: marketDir,
      generatedAt: "",
      plugins: [],
      indexError: loaded.error,
    };
  }
  const data = filterMarketplaceIndexByExistingFiles(marketDir, loaded.data);
  return {
    filesBasePath: "",
    marketplaceDir: marketDir,
    generatedAt: data.generatedAt,
    plugins: data.plugins,
  };
});

ipcMain.handle(
  IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN,
  async (_event, packageFile: string) => {
    const base = path.basename(packageFile);
    if (typeof packageFile !== "string" || base !== packageFile) {
      return { success: false, error: "Invalid package file name" };
    }
    if (!/^[a-zA-Z0-9._-]+\.archonplugin$/.test(base)) {
      return { success: false, error: "Expected a .archonplugin basename" };
    }
    const marketDir = path.resolve(resolveElectronMarketplaceDir());
    const abs = path.resolve(path.join(marketDir, base));
    const rel = path.relative(marketDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { success: false, error: "Invalid path" };
    }
    if (!fs.existsSync(abs)) {
      return { success: false, error: "Package not found in marketplace directory" };
    }
    const userDataPath = app.getPath("userData");
    try {
      const { warnings } = await getPluginLoader().importFromZip(abs, registry);
      appendPluginAudit(userDataPath, {
        action: "import-marketplace",
        detail: base,
        ok: true,
      });
      if (ctx.mainWindow) {
        ctx.mainWindow.webContents.send(IPC_CHANNELS.PLUGINS_CHANGED);
      }
      return { success: true, warnings };
    } catch (error: unknown) {
      console.error("[Main] Marketplace plugin install failed:", error);
      appendPluginAudit(userDataPath, {
        action: "import-marketplace",
        detail: base,
        ok: false,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.GET_PLUGIN_INSTALL_PLAN,
  async (_event, installedFolderName: string) => {
    if (!isSafePluginName(installedFolderName)) {
      throw new Error("Invalid plugin name");
    }
    return getPluginLoader().getPluginInstallPlan(installedFolderName);
  },
);

ipcMain.handle(
  IPC_CHANNELS.GET_PLUGIN_RESOLVED_DEPS,
  async (_event, installedFolderName: string) => {
    if (!isSafePluginName(installedFolderName)) {
      return { declared: {}, resolved: {}, error: "Invalid plugin name" };
    }
    return getPluginLoader().getPluginResolvedDeps(installedFolderName);
  },
);

ipcMain.handle(
  IPC_CHANNELS.RUN_PLUGIN_CACHE_NPM,
  async (_event, installedFolderName: string, npmArgs: string[]) => {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    if (!Array.isArray(npmArgs) || npmArgs.length === 0) {
      return { success: false, error: "npm args required" };
    }
    const userDataPath = app.getPath("userData");
    const result = await getPluginLoader().runNpmOnPluginCache(
      installedFolderName,
      npmArgs,
    );
    appendPluginAudit(userDataPath, {
      action: "npm-cache",
      pluginName: installedFolderName,
      detail: npmArgs.join(" "),
      ok: result.success,
    });
    return result;
  },
);
}
