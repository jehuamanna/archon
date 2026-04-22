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
import { PluginLoaderSourcesExt } from "./plugin-loader-sources-ext";

export class PluginLoaderImportTree extends PluginLoaderSourcesExt {

  copyPluginDistContentsToDirectory(
    installedFolderName: string,
    destDirAbsolute: string,
  ): { success: boolean; error?: string } {
    if (typeof destDirAbsolute !== "string" || !path.isAbsolute(destDirAbsolute)) {
      return { success: false, error: "Destination must be an absolute directory path" };
    }
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      return { success: false, error: "Plugin not found" };
    }
    const distDir = path.join(base, "dist");
    if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
      return { success: false, error: "No dist/ folder — bundle the plugin first" };
    }
    const resolvedDest = path.resolve(destDirAbsolute);
    if (!fs.existsSync(resolvedDest) || !fs.statSync(resolvedDest).isDirectory()) {
      return { success: false, error: "Destination is not an existing directory" };
    }
    const normBase = path.resolve(base);
    if (
      resolvedDest === normBase ||
      resolvedDest.startsWith(normBase + path.sep)
    ) {
      return {
        success: false,
        error: "Cannot copy dist into the plugin workspace",
      };
    }
    try {
      for (const ent of fs.readdirSync(distDir)) {
        const src = path.join(distDir, ent);
        const dest = path.join(resolvedDest, ent);
        if (fs.existsSync(dest)) {
          return {
            success: false,
            error: `Destination already has an entry named "${ent}"`,
          };
        }
        fs.cpSync(src, dest, { recursive: true });
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    return { success: true };
  }


  /**
   * Copy user-selected files from disk into the plugin workspace (e.g. after a file dialog).
   */
  importExternalFilesIntoWorkspace(
    installedFolderName: string,
    absoluteFilePaths: string[],
    destRelativeBase = "",
  ): { success: boolean; imported?: string[]; error?: string } {
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      return { success: false, error: "Plugin not found" };
    }
    const normBase = destRelativeBase
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    if (normBase && !isSafeRelativePluginSourcePath(normBase)) {
      return { success: false, error: "Invalid destination base" };
    }
    const imported: string[] = [];
    for (const fp of absoluteFilePaths) {
      if (typeof fp !== "string" || !path.isAbsolute(fp)) {
        return { success: false, error: "Invalid source path" };
      }
      const resolved = path.resolve(fp);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { success: false, error: `Not a file: ${fp}` };
      }
      const bn = path.basename(resolved);
      const rel = normBase ? `${normBase}/${bn}` : bn;
      if (!isSafeRelativePluginSourcePath(rel)) {
        return { success: false, error: `Invalid path: ${rel}` };
      }
      const destAbs = path.join(base, rel);
      const relCheck = path.relative(base, destAbs);
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
        return { success: false, error: "Path escapes workspace" };
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(resolved, destAbs);
      imported.push(rel.split(path.sep).join("/"));
    }
    this.invalidateDevUiCacheForWorkspace(base);
    return { success: true, imported };
  }

  /**
   * Recursively copy a directory tree into the workspace (skips node_modules, dist, .git, bin).
   */
  importExternalDirectoryIntoWorkspace(
    installedFolderName: string,
    absoluteDir: string,
    destRelativeBase = "",
  ): { success: boolean; imported?: string[]; error?: string } {
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      return { success: false, error: "Plugin not found" };
    }
    if (typeof absoluteDir !== "string" || !path.isAbsolute(absoluteDir)) {
      return { success: false, error: "Invalid directory path" };
    }
    const rootDir = path.resolve(absoluteDir);
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return { success: false, error: "Not a directory" };
    }
    const normBase = destRelativeBase
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    if (normBase && !isSafeRelativePluginSourcePath(normBase)) {
      return { success: false, error: "Invalid destination base" };
    }
    const copied = this.copyExternalDirectoryTreeIntoBase(base, rootDir, normBase);
    if (!copied.success) {
      return copied;
    }
    this.invalidateDevUiCacheForWorkspace(base);
    return { success: true, imported: copied.imported };
  }

  /**
   * Register an external plugin folder in place (same as IDE “load parent” entries): no copy into
   * `sources/`. Resolution uses `manifest.name` as id; `npm install` and edits happen on disk there.
   */
  importDirectoryAsNewWorkspace(
    absoluteDir: string,
  ): {
    success: boolean;
    folderName?: string;
    imported?: string[];
    error?: string;
  } {
    if (typeof absoluteDir !== "string" || !path.isAbsolute(absoluteDir)) {
      return { success: false, error: "Invalid directory path" };
    }
    const rootDir = path.resolve(absoluteDir);
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return { success: false, error: "Not a directory" };
    }
    const manifestPath = path.join(rootDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return {
        success: false,
        error:
          "Selected folder must contain manifest.json at its root (Archon plugin layout).",
      };
    }
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf8"),
      ) as PluginManifest;
    } catch {
      return { success: false, error: "Invalid manifest.json" };
    }
    if (
      typeof manifest.name !== "string" ||
      !isSafePluginName(manifest.name)
    ) {
      return {
        success: false,
        error:
          "manifest.json must declare a valid `name` (plugin id) for registration.",
      };
    }
    const id = manifest.name;
    const fromSources = path.join(this.userSourcesRoot(), id);
    if (fs.existsSync(path.join(fromSources, "manifest.json"))) {
      return {
        success: false,
        error: `Plugin "${id}" already exists under sources/. Remove or rename it first, or open that copy instead.`,
      };
    }
    try {
      fs.mkdirSync(this.userPluginsDir, { recursive: true });
    } catch (e) {
      return {
        success: false,
        error: `Could not create plugin data dir (${this.userPluginsDir}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
    const map = new Map(
      this.readExternalPluginEntries().map((e) => [e.id, e]),
    );
    map.set(id, { id, path: rootDir });
    this.writeExternalPluginEntries([...map.values()].sort((a, b) => a.id.localeCompare(b.id)));
    this.invalidateDevUiCacheForWorkspace(rootDir);
    return {
      success: true,
      folderName: id,
      imported: [],
    };
  }

  protected copyExternalDirectoryTreeIntoBase(
    base: string,
    rootDir: string,
    normBase: string,
  ): { success: true; imported: string[] } | { success: false; error: string } {
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return { success: false, error: "Not a directory" };
    }
    const imported: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (this.sourceSkipDirs.has(ent.name)) {
          continue;
        }
        const full = path.join(dir, ent.name);
        const relFromRoot = path.relative(rootDir, full);
        const relDest = normBase
          ? path.join(normBase, relFromRoot)
          : relFromRoot;
        const relPosix = relDest.split(path.sep).join("/");
        if (!isSafeRelativePluginSourcePath(relPosix)) {
          throw new Error(`Invalid path in tree: ${relPosix}`);
        }
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          const destAbs = path.join(base, relPosix);
          const relCheck = path.relative(base, destAbs);
          if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
            throw new Error("Path escapes workspace");
          }
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.copyFileSync(full, destAbs);
          imported.push(relPosix);
        }
      }
    };
    try {
      walk(rootDir);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    return { success: true, imported };
  }
}
