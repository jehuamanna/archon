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
import { PluginLoaderSources } from "./plugin-loader-sources";

export class PluginLoaderSourcesExt extends PluginLoaderSources {
  /**
   * Create minimal hybrid plugin files when manifest.json is missing (empty folder).
   */
  scaffoldPluginWorkspace(installedFolderName: string): {
    success: boolean;
    error?: string;
  } {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      return { success: false, error: "Plugin workspace not found" };
    }
    const manifestPath = path.join(base, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      return {
        success: false,
        error: "manifest.json already exists — delete it first to re-scaffold",
      };
    }
    const pluginId = installedFolderName;
    writeHybridPluginScaffoldFiles(base, pluginId);
    this.invalidateDevUiCacheForWorkspace(base);
    return { success: true };
  }

  getPluginSourceFileMeta(
    installedFolderName: string,
    relativePath: string,
  ): { mtimeMs: number; size: number } | null {
    if (!isSafeRelativePluginSourcePath(relativePath)) {
      return null;
    }
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      return null;
    }
    const abs = path.resolve(base, relativePath);
    const rel = path.relative(base, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
      return null;
    }
    try {
      if (!fs.existsSync(abs)) {
        return null;
      }
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        return null;
      }
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  getPluginSourceEntryKind(
    installedFolderName: string,
    relativePath: string,
  ): "file" | "dir" | "missing" {
    if (!isSafeRelativePluginSourcePath(relativePath)) {
      return "missing";
    }
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      return "missing";
    }
    const abs = path.resolve(base, relativePath);
    const rel = path.relative(base, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
      return "missing";
    }
    if (!fs.existsSync(abs)) {
      return "missing";
    }
    return fs.statSync(abs).isDirectory() ? "dir" : "file";
  }

  renamePluginSourcePath(
    installedFolderName: string,
    fromRelative: string,
    toRelative: string,
  ): void {
    if (
      !isSafeRelativePluginSourcePath(fromRelative) ||
      !isSafeRelativePluginSourcePath(toRelative)
    ) {
      throw new Error("Invalid path");
    }
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      throw new Error("Plugin not found");
    }
    const fromAbs = path.resolve(base, fromRelative);
    const toAbs = path.resolve(base, toRelative);
    const relFrom = path.relative(base, fromAbs);
    const relTo = path.relative(base, toAbs);
    if (
      relFrom.startsWith("..") ||
      path.isAbsolute(relFrom) ||
      relFrom === "" ||
      relTo.startsWith("..") ||
      path.isAbsolute(relTo) ||
      relTo === ""
    ) {
      throw new Error("Invalid path");
    }
    if (!fs.existsSync(fromAbs)) {
      throw new Error("Source path not found");
    }
    if (fs.existsSync(toAbs)) {
      throw new Error("Destination already exists");
    }
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    this.invalidateDevUiCacheForWorkspace(base);
  }

  copyPluginSourceWithinWorkspace(
    installedFolderName: string,
    fromRelative: string,
    toRelative: string,
  ): void {
    if (
      !isSafeRelativePluginSourcePath(fromRelative) ||
      !isSafeRelativePluginSourcePath(toRelative)
    ) {
      throw new Error("Invalid path");
    }
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      throw new Error("Plugin not found");
    }
    const fromAbs = path.resolve(base, fromRelative);
    const toAbs = path.resolve(base, toRelative);
    const relFrom = path.relative(base, fromAbs);
    const relTo = path.relative(base, toAbs);
    if (
      relFrom.startsWith("..") ||
      path.isAbsolute(relFrom) ||
      relFrom === "" ||
      relTo.startsWith("..") ||
      path.isAbsolute(relTo) ||
      relTo === ""
    ) {
      throw new Error("Invalid path");
    }
    if (!fs.existsSync(fromAbs)) {
      throw new Error("Source path not found");
    }
    if (fs.existsSync(toAbs)) {
      throw new Error("Destination already exists");
    }
    const st = fs.statSync(fromAbs);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    if (st.isDirectory()) {
      fs.cpSync(fromAbs, toAbs, { recursive: true });
    } else {
      fs.copyFileSync(fromAbs, toAbs);
    }
    this.invalidateDevUiCacheForWorkspace(base);
  }

  /**
   * Copy a file or directory from one plugin workspace to another (or same workspace).
   */
  copyPluginSourceBetweenWorkspaces(
    fromPlugin: string,
    fromRelative: string,
    toPlugin: string,
    toRelative: string,
  ): void {
    if (!isSafePluginName(fromPlugin) || !isSafePluginName(toPlugin)) {
      throw new Error("Invalid plugin name");
    }
    if (
      !isSafeRelativePluginSourcePath(fromRelative) ||
      !isSafeRelativePluginSourcePath(toRelative)
    ) {
      throw new Error("Invalid path");
    }
    if (fromPlugin === toPlugin) {
      this.copyPluginSourceWithinWorkspace(
        fromPlugin,
        fromRelative,
        toRelative,
      );
      return;
    }
    const fromBase = this.tryResolvePluginWorkspacePath(fromPlugin);
    const toBase = this.tryResolvePluginWorkspacePath(toPlugin);
    if (!fromBase || !toBase) {
      throw new Error("Plugin not found");
    }
    const fromAbs = path.resolve(fromBase, fromRelative);
    const toAbs = path.resolve(toBase, toRelative);
    const relFrom = path.relative(fromBase, fromAbs);
    const relTo = path.relative(toBase, toAbs);
    if (
      relFrom.startsWith("..") ||
      path.isAbsolute(relFrom) ||
      relFrom === "" ||
      relTo.startsWith("..") ||
      path.isAbsolute(relTo) ||
      relTo === ""
    ) {
      throw new Error("Invalid path");
    }
    if (!fs.existsSync(fromAbs)) {
      throw new Error("Source path not found");
    }
    if (fs.existsSync(toAbs)) {
      throw new Error("Destination already exists");
    }
    const normFrom = path.resolve(fromBase);
    const normTo = path.resolve(toBase);
    if (toAbs === fromAbs || toAbs.startsWith(fromAbs + path.sep)) {
      throw new Error("Invalid copy destination");
    }
    if (fromAbs.startsWith(toAbs + path.sep)) {
      throw new Error("Cannot copy a parent into its descendant");
    }
    const st = fs.statSync(fromAbs);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    if (st.isDirectory()) {
      fs.cpSync(fromAbs, toAbs, { recursive: true });
    } else {
      fs.copyFileSync(fromAbs, toAbs);
    }
    this.invalidateDevUiCacheForWorkspace(normFrom);
    this.invalidateDevUiCacheForWorkspace(normTo);
  }

  /**
   * Move a file or directory between workspaces, or rename within one workspace.
   */
  movePluginSourceBetweenWorkspaces(
    fromPlugin: string,
    fromRelative: string,
    toPlugin: string,
    toRelative: string,
  ): void {
    if (!isSafePluginName(fromPlugin) || !isSafePluginName(toPlugin)) {
      throw new Error("Invalid plugin name");
    }
    if (
      !isSafeRelativePluginSourcePath(fromRelative) ||
      !isSafeRelativePluginSourcePath(toRelative)
    ) {
      throw new Error("Invalid path");
    }
    if (fromPlugin === toPlugin) {
      this.renamePluginSourcePath(fromPlugin, fromRelative, toRelative);
      return;
    }
    this.copyPluginSourceBetweenWorkspaces(
      fromPlugin,
      fromRelative,
      toPlugin,
      toRelative,
    );
    this.deletePluginSourcePath(fromPlugin, fromRelative);
  }
}
