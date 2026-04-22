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
import { PluginLoaderIdeTypings } from "./plugin-loader-ide-typings";

export class PluginLoader extends PluginLoaderIdeTypings {
  /** CLI-accurate `tsc`-style check on the plugin workspace (on-disk files). */
  runTypecheckOnPluginWorkspace(installedFolderName: string): {
    success: boolean;
    error?: string;
    diagnostics: TypecheckDiagnostic[];
  } {
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      return { success: false, error: "Plugin not found", diagnostics: [] };
    }
    let extraTypesRoots: string[] | undefined;
    try {
      const raw = fs.readFileSync(path.join(base, "manifest.json"), "utf8");
      const manifest = JSON.parse(raw) as { name: string };
      const cacheNm = pluginCacheManager.getNodeModulesPath(manifest.name);
      const roots: string[] = [];
      const localTypes = path.join(base, "node_modules", "@types");
      const cacheTypes = path.join(cacheNm, "@types");
      if (fs.existsSync(localTypes)) {
        roots.push(localTypes);
      }
      if (fs.existsSync(cacheTypes)) {
        roots.push(cacheTypes);
      }
      if (roots.length > 0) {
        extraTypesRoots = roots;
      }
    } catch {
      // optional
    }
    return typecheckPluginWorkspace(base, extraTypesRoots);
  }

  /** Empty `bin/`, `.plugin-main-cache`, global plugin-cache; reload. */
  clearBinAndPluginCaches(registry: Registry): void {
    const bin = this.userBinRoot();
    if (fs.existsSync(bin)) {
      fs.rmSync(bin, { recursive: true, force: true });
    }
    fs.mkdirSync(bin, { recursive: true });
    const mc = path.join(this.userPluginsDir, ".plugin-main-cache");
    if (fs.existsSync(mc)) {
      fs.rmSync(mc, { recursive: true, force: true });
    }
    pluginCacheManager.clearAll();
    this.reload(registry);
  }

  /** Remove and recreate `sources/` only; reload. */
  deleteAllPluginSources(registry: Registry): void {
    const s = this.userSourcesRoot();
    if (fs.existsSync(s)) {
      fs.rmSync(s, { recursive: true, force: true });
    }
    fs.mkdirSync(s, { recursive: true });
    this.reload(registry);
  }

  /** Remove Electron `cache/archon`, legacy `~/.archon`, user plugins root; re-seed; clear disabled; reload. */
  formatArchonPluginData(registry: Registry): void {
    const legacyArchon = path.join(os.homedir(), ".archon");
    if (fs.existsSync(legacyArchon)) {
      fs.rmSync(legacyArchon, { recursive: true, force: true });
    }
    try {
      const cacheTree = getArchonDerivedCacheRoot(app.getPath("userData"));
      if (fs.existsSync(cacheTree)) {
        fs.rmSync(cacheTree, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
    pluginCacheManager.ensureRoot();
    if (fs.existsSync(this.userPluginsDir)) {
      fs.rmSync(this.userPluginsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.userPluginsDir, { recursive: true });
    seedSamplePluginsToUserDir(this.userPluginsDir);
    if (this.userDataPathForDisabled) {
      writeDisabledPluginIds(this.userDataPathForDisabled, new Set());
    }
    this.reload(registry);
  }
}
