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
import type {
  PluginHostTier,
  PluginManifest,
} from "./plugin-loader-types";
import { PluginLoaderBase } from "./plugin-loader-base";

export class PluginLoaderRuntime extends PluginLoaderBase {
  protected isPathUnderBundledCore(pluginAbsPath: string): boolean {
    const norm = path.resolve(pluginAbsPath);
    for (const root of this.bundledCoreRoots) {
      const r = path.resolve(root);
      if (norm === r || norm.startsWith(`${r}${path.sep}`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * User-installed trees are always `user`. Bundled defaults to `core` unless manifest sets `hostTier`.
   */
  protected effectiveHostTier(
    manifest: PluginManifest,
    pluginPath: string,
  ): PluginHostTier {
    if (!this.isPathUnderBundledCore(path.resolve(pluginPath))) {
      return "user";
    }
    const h = manifest.hostTier;
    if (h === "system" || h === "core" || h === "user") {
      return h;
    }
    return "core";
  }

  protected getManifestPathForPluginId(pluginId: string): string | null {
    if (!isSafePluginName(pluginId)) {
      return null;
    }
    for (const root of this.bundledCoreRoots) {
      const p = path.join(root, pluginId, "manifest.json");
      if (fs.existsSync(p)) {
        return p;
      }
    }
    const runtime = this.resolvePluginRuntimePath(pluginId);
    if (runtime) {
      const p = path.join(runtime, "manifest.json");
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  readHostTierForPluginId(pluginId: string): PluginHostTier {
    const mp = this.getManifestPathForPluginId(pluginId);
    if (!mp) {
      return "user";
    }
    try {
      const manifest = JSON.parse(
        fs.readFileSync(mp, "utf8"),
      ) as PluginManifest;
      return this.effectiveHostTier(manifest, path.dirname(mp));
    } catch {
      return "user";
    }
  }

  protected readManifestVersionForPluginId(pluginId: string): string | null {
    const mp = this.getManifestPathForPluginId(pluginId);
    if (!mp) {
      return null;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(mp, "utf8")) as {
        version?: string;
      };
      return typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      return null;
    }
  }

  protected resolvePluginRuntimePath(installedFolderName: string): string | null {
    if (!isSafePluginName(installedFolderName)) {
      return null;
    }
    const binP = path.join(this.userBinRoot(), installedFolderName);
    if (fs.existsSync(path.join(binP, "manifest.json"))) {
      return binP;
    }
    return this.tryResolvePluginWorkspacePath(installedFolderName);
  }

  /** Folder with a production `manifest.json` (prefer `bin/<name>`). */
  protected resolveProductionPluginRoot(pluginName: string): string | null {
    if (!isSafePluginName(pluginName)) {
      return null;
    }
    const candidates = [
      path.join(this.userBinRoot(), pluginName),
      path.join(this.userPluginsDir, pluginName),
    ];
    for (const c of candidates) {
      const mp = path.join(c, "manifest.json");
      if (!fs.existsSync(mp)) {
        continue;
      }
      try {
        const m = JSON.parse(fs.readFileSync(mp, "utf8")) as PluginManifest;
        if (m.mode === "production") {
          return c;
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }

  protected assertPluginFilesExist(
    pluginPath: string,
    manifest: PluginManifest,
  ): void {
    const mainAbs = path.join(pluginPath, manifest.main);
    if (!fs.existsSync(mainAbs)) {
      throw new Error(`Main entry not found: ${manifest.main}`);
    }
    if (manifest.ui) {
      const uiAbs = path.join(pluginPath, manifest.ui);
      if (!fs.existsSync(uiAbs)) {
        throw new Error(`UI entry not found: ${manifest.ui}`);
      }
    }
    if (manifest.html) {
      const htmlAbs = path.join(pluginPath, manifest.html);
      if (!fs.existsSync(htmlAbs)) {
        throw new Error(`HTML entry not found: ${manifest.html}`);
      }
    }
  }

  /**
   * Node cannot require() raw `.ts`. Compile to a cached `.cjs` beside user plugins
   * when `manifest.main` ends with `.ts`.
   */
  protected resolvePluginMainRequirePath(
    pluginPath: string,
    manifest: PluginManifest,
  ): string {
    const mainAbs = path.join(pluginPath, manifest.main);
    if (!manifest.main.endsWith(".ts")) {
      return mainAbs;
    }

    const cacheRoot = path.join(this.userPluginsDir, ".plugin-main-cache");
    fs.mkdirSync(cacheRoot, { recursive: true });
    const st = fs.statSync(mainAbs);
    const id = crypto
      .createHash("sha256")
      .update(mainAbs)
      .digest("hex")
      .slice(0, 32);
    const outFile = path.join(cacheRoot, `${id}.cjs`);
    const metaFile = path.join(cacheRoot, `${id}.json`);
    let needBuild = true;
    if (fs.existsSync(metaFile) && fs.existsSync(outFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as {
          mtimeMs: number;
        };
        if (meta.mtimeMs === st.mtimeMs) {
          needBuild = false;
        }
      } catch {
        /* rebuild */
      }
    }
    if (needBuild) {
      const nodePaths: string[] = [];
      const localNm = path.join(pluginPath, "node_modules");
      if (fs.existsSync(localNm)) {
        nodePaths.push(localNm);
      }
      const cacheNm = pluginCacheManager.getNodeModulesPath(manifest.name);
      if (fs.existsSync(cacheNm)) {
        nodePaths.push(cacheNm);
      }
      try {
        esbuild.buildSync({
          absWorkingDir: pluginPath,
          entryPoints: [mainAbs],
          outfile: outFile,
          bundle: true,
          platform: "node",
          format: "cjs",
          target: ["node18"],
          logLevel: "silent",
          external: ["electron"],
          ...(nodePaths.length > 0 ? { nodePaths } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`[PluginLoader] Failed to compile ${manifest.main}: ${msg}`);
      }
      fs.writeFileSync(
        metaFile,
        JSON.stringify({ mtimeMs: st.mtimeMs }),
        "utf8",
      );
    }
    return outFile;
  }

  protected copyPluginProductionAssets(
    pluginPath: string,
    stagingPath: string,
    manifest: PluginManifest,
  ): void {
    for (const extra of ["README.md", "LICENSE"]) {
      const from = path.join(pluginPath, extra);
      if (fs.existsSync(from)) {
        fs.copyFileSync(from, path.join(stagingPath, extra));
      }
    }
    if (manifest.assets?.length) {
      for (const a of manifest.assets) {
        const from = path.join(pluginPath, a);
        if (!fs.existsSync(from)) {
          continue;
        }
        const to = path.join(stagingPath, a);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        const st = fs.statSync(from);
        if (st.isDirectory()) {
          fs.cpSync(from, to, { recursive: true });
        } else {
          fs.copyFileSync(from, to);
        }
      }
    }
  }
}
