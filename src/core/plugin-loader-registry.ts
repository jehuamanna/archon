import { execFileSync, spawn } from "child_process";
import * as crypto from "crypto";
import { app } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getArchonDerivedCacheRoot } from "./archon-paths";
import { Registry } from "./registry";
import {
  isSafePluginName,
  isSafeRelativePluginSourcePath,
} from "../shared/validators";
import { manifestValidator } from "./manifest-validator";
import { packageManager } from "./package-manager";
import { pluginCacheManager } from "./plugin-cache-manager";
import { npmPackageExistsOnRegistry } from "./npm-registry-stub";
import { emitPluginProgress } from "./plugin-progress";
import { pluginBundler } from "./plugin-bundler";
import * as esbuild from "esbuild";
import {
  typecheckPluginWorkspace,
  type TypecheckDiagnostic,
} from "./plugin-typecheck";
import { toFileUri } from "../shared/file-uri";
import { designSystemWarning } from "../shared/design-system";
import {
  readDisabledPluginIds,
  writeDisabledPluginIds,
} from "./plugin-disabled-store";
import { syncHostArchonScopedPackagesIntoWorkspace } from "./archon-host-packages";
import { seedSamplePluginsToUserDir } from "./seed-user-plugins";
import type { NoteRenderer } from "../shared/plugin-api";
import { writeHybridPluginScaffoldFiles } from "./plugin-loader-scaffold-writer";
import type { PluginManifest } from "./plugin-loader-types";
import { PluginLoaderRuntime } from "./plugin-loader-runtime";
import {
  readUserLoadedPluginIds,
  readUserTierPluginInventory,
  syncPluginCatalogRows,
  type PluginCatalogPersistRow,
} from "./plugin-catalog-json";

export class PluginLoaderRegistry extends PluginLoaderRuntime {
  /** When set (Electron userData), plugin inventory is read from `plugin-catalog.json` after each rescan. */
  private pluginCatalogUserDataPath: string | null = null;

  setPluginCatalogUserDataPath(userDataPath: string): void {
    this.pluginCatalogUserDataPath = userDataPath.trim() || null;
  }

  /** Snapshot of all discovered plugins for persistence (bundled + user). */
  private buildPluginCatalogPersistRows(): PluginCatalogPersistRow[] {
    const disabled = this.getDisabledUserPluginIds();
    const bundled = this.listBundledPluginFolderNames();
    const user = this.collectUserPluginIds();
    const ids = new Set<string>([...bundled, ...user]);
    return [...ids].sort().map((id) => {
      const isBundled = this.isBundledPluginFolder(id);
      const tier = this.readHostTierForPluginId(id);
      return {
        plugin_id: id,
        host_tier: tier,
        is_bundled: isBundled,
        can_toggle: !isBundled,
        enabled: isBundled || !disabled.has(id),
        loaded: this.loadedPlugins.has(id),
        manifest_version: this.readManifestVersionForPluginId(id),
      };
    });
  }

  private persistPluginCatalog(): void {
    if (!this.pluginCatalogUserDataPath) {
      return;
    }
    try {
      syncPluginCatalogRows(
        this.pluginCatalogUserDataPath,
        this.buildPluginCatalogPersistRows(),
      );
    } catch (e) {
      console.warn(
        "[PluginLoader] plugin catalog JSON sync failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  getPluginInventory(): {
    id: string;
    isBundled: boolean;
    canToggle: boolean;
    enabled: boolean;
    loaded: boolean;
  }[] {
    if (this.pluginCatalogUserDataPath) {
      try {
        const fromDb = readUserTierPluginInventory(
          this.pluginCatalogUserDataPath,
        );
        if (fromDb.length > 0) {
          return fromDb;
        }
      } catch (e) {
        console.warn(
          "[PluginLoader] read plugin catalog JSON failed, using scan:",
          e instanceof Error ? e.message : e,
        );
      }
    }
    return super
      .getPluginInventory()
      .filter((row) => this.readHostTierForPluginId(row.id) === "user");
  }

  /**
   * User-tier plugins that successfully loaded (for note-type pickers, etc.).
   * Prefers `plugin-catalog.json` when catalog is configured and populated.
   */
  getUserFacingLoadedPluginsFromCatalog(): string[] {
    if (this.pluginCatalogUserDataPath) {
      try {
        const ids = readUserLoadedPluginIds(this.pluginCatalogUserDataPath);
        if (ids.length > 0) {
          return ids;
        }
      } catch {
        /* fall through */
      }
    }
    return [...this.loadedPlugins].filter(
      (id) => this.readHostTierForPluginId(id) === "user",
    );
  }

  loadAll(registry: Registry): void {
    this.loadIssues = [];

    fs.mkdirSync(this.userPluginsDir, { recursive: true });

    for (const root of this.bundledCoreRoots) {
      this.loadPluginsInDirectory(root, registry);
    }
    this.loadUserPlugins(registry);
    this.persistPluginCatalog();
  }

  /** Each immediate child directory with a manifest.json is one plugin. */
  protected loadPluginsInDirectory(parentDir: string, registry: Registry): void {
    if (!fs.existsSync(parentDir)) {
      return;
    }

    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) {
        continue;
      }
      const pluginPath = path.join(parentDir, ent.name);
      const manifestPath = path.join(pluginPath, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      try {
        this.loadPluginAt(pluginPath, registry);
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : String(error);
        console.error(
          `[PluginLoader] Failed to load plugin ${ent.name}:`,
          error,
        );
        this.loadIssues.push({ folder: ent.name, error: msg });
      }
    }
  }

  getPluginLoadIssues(): { folder: string; error: string }[] {
    return [...this.loadIssues];
  }

  protected loadPluginAt(pluginPath: string, registry: Registry): void {
    const folder = path.basename(pluginPath);
    const manifestPath = path.join(pluginPath, "manifest.json");

    if (!fs.existsSync(manifestPath)) {
      console.log(`[PluginLoader] No manifest.json found in ${folder}`);
      return;
    }

    const manifestContent = fs.readFileSync(manifestPath, "utf8");
    const manifest: PluginManifest = JSON.parse(manifestContent);

    const validationResult = manifestValidator.validateForLoad(
      manifest,
      pluginPath,
    );
    if (!validationResult.valid) {
      const errorMessage = manifestValidator.formatErrors(validationResult);
      console.error(
        `[PluginLoader] Invalid manifest for ${folder}:\n${errorMessage}`,
      );
      throw new Error(
        `Invalid manifest: ${validationResult.errors[0]?.message || "validation failed"}`,
      );
    }

    // Log warnings if any
    if (validationResult.warnings.length > 0) {
      console.warn(`[PluginLoader] Manifest warnings for ${folder}:`);
      validationResult.warnings.forEach((w) => {
        console.warn(`  - [${w.field}] ${w.message}`);
      });
    }

    if (folder !== manifest.name) {
      console.warn(
        `[PluginLoader] Plugin folder "${folder}" differs from manifest name "${manifest.name}" (cache uses manifest name).`,
      );
    }

    this.assertPluginFilesExist(pluginPath, manifest);

    const mainFile = this.resolvePluginMainRequirePath(pluginPath, manifest);

    try {
      // Use dynamic require to prevent webpack from bundling plugin code
      // This is safe because it only runs in the main process (Node.js)
      const dynamicRequire = eval("require");

      // Clear require cache to allow plugin reloading
      if (dynamicRequire.cache[mainFile]) {
        delete dynamicRequire.cache[mainFile];
      }

      // Load plugin as Node.js module
      const pluginModule = dynamicRequire(mainFile);

      if (!pluginModule || typeof pluginModule.activate !== "function") {
        throw new Error("Plugin must export an activate function");
      }

      // Create plugin context
      const context = {
        subscriptions: [],
      };

      const api: {
        registerNoteRenderer: (type: string, renderer: NoteRenderer) => {
          dispose: () => void;
        };
        getNote: () => null;
        getUiBootstrap?: () => Promise<string>;
      } = {
        registerNoteRenderer: (type: string, renderer: NoteRenderer) => {
          registry.registerRenderer(manifest.name, type, renderer, {
            theme:
              manifest.theme === "isolated" ? "isolated" : "inherit",
            designSystemVersion: manifest.designSystemVersion,
            deferDisplayUntilContentReady:
              manifest.deferDisplayUntilContentReady === true,
            hostTier: this.effectiveHostTier(manifest, pluginPath),
          });
          this.loadedPlugins.add(manifest.name);
          console.log(
            `[PluginLoader] Loaded plugin: ${manifest.name} (type: ${type})`,
          );
          return {
            dispose: () => {
              registry.unregisterRenderer(manifest.name, type);
            },
          };
        },
        getNote: () => null,
      };

      if (manifest.ui) {
        api.getUiBootstrap = async () => {
          const uiPath = path.join(pluginPath, manifest.ui!);
          if (manifest.mode === "production") {
            if (!fs.existsSync(uiPath)) {
              throw new Error(`UI bundle not found: ${manifest.ui}`);
            }
            return fs.readFileSync(uiPath, "utf8");
          }
          if (
            manifest.ui!.endsWith(".jsx") ||
            manifest.ui!.endsWith(".tsx")
          ) {
            const stat = fs.statSync(uiPath);
            const cacheKey = `${pluginPath}:${manifest.ui}`;
            const hit = this.devUiBundleCache.get(cacheKey);
            if (hit && hit.mtime === stat.mtimeMs) {
              return hit.code;
            }
            let code: string;
            try {
              code = await pluginBundler.bundleUiForDevIframe(
                pluginPath,
                manifest.ui!,
                false,
              );
            } catch (err) {
              const msg =
                err instanceof Error ? err.message : String(err);
              emitPluginProgress({
                op: "bundle",
                phase: "error",
                message: msg,
                pluginName: manifest.name,
              });
              throw err;
            }
            this.devUiBundleCache.set(cacheKey, {
              mtime: stat.mtimeMs,
              code,
            });
            return code;
          }
          return fs.readFileSync(uiPath, "utf8");
        };
      }

      // Activate plugin
      pluginModule.activate(context, api);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[PluginLoader] Failed to load plugin ${manifest.name}:`,
        error,
      );
      this.loadIssues.push({ folder: manifest.name, error: msg });
    }
  }

  reload(registry: Registry): void {
    this.loadedPlugins.clear();
    this.devUiBundleCache.clear();
    registry.clear();
    this.loadAll(registry);
  }
  protected loadUserPlugins(registry: Registry): void {
    const disabled = this.getDisabledUserPluginIds();
    for (const id of this.collectUserPluginIds()) {
      if (disabled.has(id)) {
        continue;
      }
      const loadPath = this.resolvePluginRuntimePath(id);
      if (!loadPath) {
        continue;
      }
      try {
        this.loadPluginAt(loadPath, registry);
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : String(error);
        console.error(`[PluginLoader] Failed to load plugin ${id}:`, error);
        this.loadIssues.push({ folder: id, error: msg });
      }
    }
  }
}
