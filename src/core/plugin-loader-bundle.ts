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
import { PluginLoaderZipExport } from "./plugin-loader-zip-export";

export class PluginLoaderBundle extends PluginLoaderZipExport {
  async bundlePluginToLocalDist(pluginName: string): Promise<{
    success: boolean;
    error?: string;
    warnings?: string[];
  }> {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }

    const sourcePath = this.tryResolvePluginWorkspacePath(pluginName);
    if (!sourcePath) {
      return {
        success: false,
        error: `Plugin sources not found for ${pluginName} (expected sources/${pluginName} or legacy folder).`,
      };
    }

    const man = JSON.parse(
      fs.readFileSync(path.join(sourcePath, "manifest.json"), "utf8"),
    ) as PluginManifest;

    const binOut = path.join(this.userBinRoot(), pluginName);
    fs.mkdirSync(this.userBinRoot(), { recursive: true });
    fs.mkdirSync(binOut, { recursive: true });

    emitPluginProgress({
      op: "bundle",
      phase: "start",
      message: `Bundle to bin/${pluginName}: ${man.name}`,
      pluginName: man.name,
    });

    const result = await pluginBundler.bundle(sourcePath, {
      distDir: binOut,
      minify: false,
      sourcemap: true,
      onProgress: (m) => {
        console.log(`[PluginLoader] Bundle: ${m}`);
        emitPluginProgress({
          op: "bundle",
          phase: "progress",
          message: m,
          pluginName: man.name,
        });
      },
    });

    if (!result.success) {
      emitPluginProgress({
        op: "bundle",
        phase: "error",
        message: result.errors.join("\n"),
        pluginName: man.name,
      });
      return {
        success: false,
        error: result.errors.join("\n"),
        warnings: result.warnings,
      };
    }

    const prodManifest: PluginManifest = {
      ...man,
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
      path.join(binOut, "manifest.json"),
      JSON.stringify(prodManifest, null, 2),
      "utf8",
    );

    this.copyPluginProductionAssets(sourcePath, binOut, man);

    for (const key of [...this.devUiBundleCache.keys()]) {
      if (key.startsWith(`${sourcePath}:`)) {
        this.devUiBundleCache.delete(key);
      }
    }

    emitPluginProgress({
      op: "bundle",
      phase: "done",
      message: `Bundled ${man.name} → bin/${pluginName}`,
      pluginName: man.name,
    });

    return { success: true, warnings: result.warnings };
  }
}
