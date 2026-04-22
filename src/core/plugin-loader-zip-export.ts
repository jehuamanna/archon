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
import { PluginLoaderRegistry } from "./plugin-loader-registry";

export class PluginLoaderZipExport extends PluginLoaderRegistry {

  async importFromZip(
    zipPath: string,
    registry: Registry,
  ): Promise<{ warnings: string[] }> {
    try {
      emitPluginProgress({
        op: "import",
        phase: "start",
        message: `Importing ${path.basename(zipPath)}`,
      });

      // Validate package first
      const validation = await packageManager.validatePackage(zipPath);
      if (!validation.valid) {
        throw new Error(`Invalid package: ${validation.errors.join(", ")}`);
      }

      const importWarnings = [...validation.warnings];

      // Get package info
      const packageInfo = await packageManager.getPackageInfo(zipPath);
      if (!isSafePluginName(packageInfo.name)) {
        throw new Error("Invalid plugin name in package manifest");
      }

      console.log(
        `[PluginLoader] Importing ${packageInfo.mode} package: ${packageInfo.name} v${packageInfo.version}`,
      );

      fs.mkdirSync(this.userSourcesRoot(), { recursive: true });
      const pluginDir = path.join(this.userSourcesRoot(), packageInfo.name);
      const legacyDir = path.join(this.userPluginsDir, packageInfo.name);
      const binDir = path.join(this.userBinRoot(), packageInfo.name);

      if (
        fs.existsSync(pluginDir) ||
        fs.existsSync(legacyDir) ||
        fs.existsSync(binDir)
      ) {
        throw new Error(
          `Plugin ${packageInfo.name} already exists. Please remove it first.`,
        );
      }

      fs.mkdirSync(pluginDir, { recursive: true });

      // Extract package
      await packageManager.extractPackage(zipPath, pluginDir);

      const loadPath = this.resolvePluginRuntimePath(packageInfo.name);
      if (loadPath) {
        this.loadPluginAt(loadPath, registry);
      }

      console.log(
        `[PluginLoader] Successfully imported ${packageInfo.mode} plugin: ${packageInfo.name}`,
      );

      emitPluginProgress({
        op: "import",
        phase: "done",
        message: `Imported ${packageInfo.name}`,
        pluginName: packageInfo.name,
      });

      return { warnings: importWarnings };
    } catch (error) {
      console.error("[PluginLoader] Failed to import plugin from zip:", error);
      emitPluginProgress({
        op: "import",
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getLoadedPlugins(): string[] {
    return Array.from(this.loadedPlugins);
  }

  /** Loaded plugin ids shown in Plugin Manager (excludes system/core bundled). */
  getUserFacingLoadedPlugins(): string[] {
    return this.getLoadedPlugins().filter(
      (id) => this.readHostTierForPluginId(id) === "user",
    );
  }

  /**
   * UI fields from manifest for a loaded plugin (matched by `manifest.name`).
   */
  getManifestUiFields(manifestName: string): {
    theme: "inherit" | "isolated";
    designSystemVersion?: string;
    designSystemWarning: string | null;
  } | null {
    const readAt = (root: string) => {
      const mp = path.join(root, "manifest.json");
      if (!fs.existsSync(mp)) {
        return null;
      }
      try {
        const m = JSON.parse(fs.readFileSync(mp, "utf8")) as PluginManifest;
        if (m.name !== manifestName) {
          return null;
        }
        const theme: "inherit" | "isolated" =
          m.theme === "isolated" ? "isolated" : "inherit";
        return {
          theme,
          designSystemVersion: m.designSystemVersion,
          designSystemWarning: designSystemWarning(m.designSystemVersion),
        };
      } catch {
        return null;
      }
    };

    for (const id of this.collectUserPluginIds()) {
      const r = this.resolvePluginRuntimePath(id);
      if (!r) {
        continue;
      }
      const hit = readAt(r);
      if (hit) {
        return hit;
      }
    }

    for (const br of this.bundledCoreRoots) {
      if (!fs.existsSync(br)) {
        continue;
      }
      for (const ent of fs.readdirSync(br, { withFileTypes: true })) {
        if (!ent.isDirectory()) {
          continue;
        }
        const hit = readAt(path.join(br, ent.name));
        if (hit) {
          return hit;
        }
      }
    }

    return null;
  }

  uninstallPlugin(pluginName: string, registry: Registry): void {
    if (!isSafePluginName(pluginName)) {
      throw new Error("Invalid plugin name");
    }

    const binPath = path.join(this.userBinRoot(), pluginName);
    if (!fs.existsSync(binPath)) {
      throw new Error(
        `No bundled plugin in bin/ for "${pluginName}". Sources under sources/ were not removed.`,
      );
    }

    fs.rmSync(binPath, { recursive: true, force: true });

    this.loadedPlugins.delete(pluginName);

    this.reload(registry);

    console.log(
      `[PluginLoader] Removed bundled plugin from bin: ${pluginName} (sources preserved)`,
    );
  }

  async exportPluginAsDev(
    pluginName: string,
    outputDir: string,
  ): Promise<string> {
    if (!isSafePluginName(pluginName)) {
      throw new Error("Invalid plugin name");
    }

    const pluginPath = this.tryResolvePluginWorkspacePath(pluginName);

    if (!pluginPath) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    // Read manifest to verify it's in development mode
    const manifestPath = path.join(pluginPath, "manifest.json");
    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    );

    if (manifest.mode !== "development") {
      throw new Error(
        `Plugin ${pluginName} is not in development mode. Cannot export as dev package.`,
      );
    }

    emitPluginProgress({
      op: "export",
      phase: "start",
      message: `Export dev package: ${manifest.name}`,
      pluginName: manifest.name,
    });

    try {
      const packagePath = await packageManager.createDevPackage({
        pluginPath,
        outputPath: outputDir,
        mode: "development",
      });

      console.log(
        `[PluginLoader] Exported ${pluginName} as dev package: ${packagePath}`,
      );

      emitPluginProgress({
        op: "export",
        phase: "done",
        message: `Dev export: ${path.basename(packagePath)}`,
        pluginName: manifest.name,
      });

      return packagePath;
    } catch (e) {
      emitPluginProgress({
        op: "export",
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
        pluginName: manifest.name,
      });
      throw e;
    }
  }

  async exportPluginAsProduction(
    pluginName: string,
    outputDir: string,
  ): Promise<string> {
    if (!isSafePluginName(pluginName)) {
      throw new Error("Invalid plugin name");
    }

    const pluginPath = this.resolveProductionPluginRoot(pluginName);
    if (!pluginPath) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    // Read manifest to verify it's in production mode
    const manifestPath = path.join(pluginPath, "manifest.json");
    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    );

    if (manifest.mode !== "production") {
      throw new Error(
        `Plugin ${pluginName} is not in production mode. Cannot export as production package.`,
      );
    }

    const packagePath = await packageManager.createProductionPackage({
      pluginPath,
      outputPath: outputDir,
      mode: "production",
    });

    console.log(
      `[PluginLoader] Exported ${pluginName} as production package: ${packagePath}`,
    );

    return packagePath;
  }

  /**
   * Build a `.Archonplugin` from a development plugin (bundle + stage + zip), or re-package an
   * already production-mode plugin folder.
   */
  async exportProductionPackage(
    pluginName: string,
    outputDir: string,
  ): Promise<string> {
    if (!isSafePluginName(pluginName)) {
      throw new Error("Invalid plugin name");
    }

    const workspacePath = this.tryResolvePluginWorkspacePath(pluginName);
    const prodPath = this.resolveProductionPluginRoot(pluginName);
    const pluginPath = prodPath ?? workspacePath;

    if (!pluginPath) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    const manifestPath = path.join(pluginPath, "manifest.json");
    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    );

    emitPluginProgress({
      op: "export",
      phase: "start",
      message: `Export production: ${manifest.name}`,
      pluginName: manifest.name,
    });

    if (manifest.mode === "production") {
      const packagePath = await packageManager.createProductionPackage({
        pluginPath,
        outputPath: outputDir,
        mode: "production",
      });
      console.log(
        `[PluginLoader] Exported ${pluginName} as production package: ${packagePath}`,
      );
      emitPluginProgress({
        op: "export",
        phase: "done",
        message: `Production export: ${path.basename(packagePath)}`,
        pluginName: manifest.name,
      });
      return packagePath;
    }

    if (manifest.mode === "development") {
      const devRoot = workspacePath ?? pluginPath;
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), "archon-prod-"));
      try {
        const distStaging = path.join(staging, "dist");
        const result = await pluginBundler.bundle(devRoot, {
          distDir: distStaging,
          minify: true,
          sourcemap: true,
          onProgress: (m) => {
            console.log(`[PluginLoader] Bundle: ${m}`);
            emitPluginProgress({
              op: "export",
              phase: "progress",
              message: m,
              pluginName: manifest.name,
            });
          },
        });

        if (!result.success) {
          const errText = result.errors.join("\n");
          emitPluginProgress({
            op: "export",
            phase: "error",
            message: errText,
            pluginName: manifest.name,
          });
          throw new Error(errText);
        }

        const prodManifest: PluginManifest = {
          ...manifest,
          mode: "production",
          main: result.mainBundle!,
        };
        if (result.uiBundle) {
          prodManifest.ui = result.uiBundle;
        } else {
          delete prodManifest.ui;
        }
        delete prodManifest.dependencies;
        delete prodManifest.devDependencies;

        fs.writeFileSync(
          path.join(staging, "manifest.json"),
          JSON.stringify(prodManifest, null, 2),
        );

        this.copyPluginProductionAssets(devRoot, staging, manifest);

        const packagePath = await packageManager.createProductionPackage({
          pluginPath: staging,
          outputPath: outputDir,
          mode: "production",
        });

        console.log(
          `[PluginLoader] Bundled and exported ${pluginName}: ${packagePath}`,
        );
        emitPluginProgress({
          op: "export",
          phase: "done",
          message: `Production export: ${path.basename(packagePath)}`,
          pluginName: manifest.name,
        });
        return packagePath;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }

    emitPluginProgress({
      op: "export",
      phase: "error",
      message: `Unsupported manifest mode: ${manifest.mode}`,
      pluginName: manifest.name,
    });
    throw new Error(`Unsupported manifest mode: ${manifest.mode}`);
  }
}
