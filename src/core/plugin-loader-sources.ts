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
import { PluginLoaderDeps } from "./plugin-loader-deps";

export class PluginLoaderSources extends PluginLoaderDeps {
  getPluginCacheStats(): {
    root: string;
    totalBytes: number;
    plugins: { name: string; bytes: number }[];
  } {
    pluginCacheManager.ensureRoot();
    const root = pluginCacheManager.getRoot();
    const plugins: { name: string; bytes: number }[] = [];

    if (!fs.existsSync(root)) {
      return { root, totalBytes: 0, plugins: [] };
    }

    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      if (fs.statSync(p).isDirectory()) {
        plugins.push({
          name,
          bytes: pluginCacheManager.getPluginCacheSizeBytes(name),
        });
      }
    }

    const totalBytes = plugins.reduce((acc, x) => acc + x.bytes, 0);
    return { root, totalBytes, plugins };
  }

  clearAllPluginDependencyCaches(): void {
    pluginCacheManager.clearAll();
  }

  /** Plugin IDs that have editable sources (`sources/<id>` or legacy flat). */
  listPluginWorkspaceFolders(): string[] {
    return this.collectUserPluginIds().filter(
      (id) => this.tryResolvePluginWorkspacePath(id) !== null,
    );
  }
  protected readonly sourceSkipDirs = new Set([
    "node_modules",
    "dist",
    ".git",
    "bin",
  ]);

  protected resolvePluginSourceFile(
    installedFolderName: string,
    relativePath: string,
  ): string {
    if (!isSafePluginName(installedFolderName)) {
      throw new Error("Invalid plugin name");
    }
    if (!isSafeRelativePluginSourcePath(relativePath)) {
      throw new Error("Invalid file path");
    }
    const pluginPath = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!pluginPath) {
      throw new Error("Plugin not found");
    }
    const abs = path.resolve(pluginPath, relativePath);
    const relToPlugin = path.relative(pluginPath, abs);
    if (relToPlugin.startsWith("..") || path.isAbsolute(relToPlugin)) {
      throw new Error("Path escapes plugin directory");
    }
    return abs;
  }

  /**
   * Epic 4 — list editable source files (skips walking node_modules, dist, .git).
   * If `node_modules/` exists, a single placeholder path `node_modules/` is included
   * so the IDE shows that dependencies are present without listing every file.
   */
  listPluginSourceFiles(installedFolderName: string): string[] {
    if (!isSafePluginName(installedFolderName)) {
      throw new Error("Invalid plugin name");
    }
    const pluginPath = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!pluginPath) {
      throw new Error("Plugin not found");
    }
    const NODE_MODULES_MARKER = "node_modules/";
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (this.sourceSkipDirs.has(ent.name)) {
          continue;
        }
        const full = path.join(dir, ent.name);
        const rel = path.relative(pluginPath, full);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          continue;
        }
        const relPosix = rel.split(path.sep).join("/");
        if (ent.isDirectory()) {
          out.push(`${relPosix}/`);
          walk(full);
        } else if (ent.isFile()) {
          out.push(relPosix);
        }
      }
    };
    walk(pluginPath);
    const nm = path.join(pluginPath, "node_modules");
    try {
      if (fs.existsSync(nm) && fs.statSync(nm).isDirectory()) {
        out.push(NODE_MODULES_MARKER);
      }
    } catch {
      /* ignore */
    }
    out.sort();
    return out;
  }

  readPluginSourceFile(
    installedFolderName: string,
    relativePath: string,
  ): string {
    const abs = this.resolvePluginSourceFile(installedFolderName, relativePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error("File not found");
    }
    return fs.readFileSync(abs, "utf8");
  }

  writePluginSourceFile(
    installedFolderName: string,
    relativePath: string,
    content: string,
  ): void {
    if (typeof content !== "string") {
      throw new Error("Invalid content");
    }
    if (content.length > 5_000_000) {
      throw new Error("File too large");
    }
    const abs = this.resolvePluginSourceFile(installedFolderName, relativePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");

    const pluginPath = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (pluginPath) {
      for (const key of [...this.devUiBundleCache.keys()]) {
        if (key.startsWith(`${pluginPath}:`)) {
          this.devUiBundleCache.delete(key);
        }
      }
    }
  }

  mkdirPluginSourceDir(
    installedFolderName: string,
    relativeDir: string,
  ): void {
    if (!isSafeRelativePluginSourcePath(relativeDir)) {
      throw new Error("Invalid directory path");
    }
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      throw new Error("Plugin not found");
    }
    const abs = path.resolve(base, relativeDir);
    const rel = path.relative(base, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Path escapes plugin directory");
    }
    fs.mkdirSync(abs, { recursive: true });
  }

  createPluginSourceFile(
    installedFolderName: string,
    relativePath: string,
    content = "",
  ): void {
    if (!isSafeRelativePluginSourcePath(relativePath)) {
      throw new Error("Invalid file path");
    }
    const abs = this.resolvePluginSourceFile(installedFolderName, relativePath);
    if (fs.existsSync(abs)) {
      throw new Error("File already exists");
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");

    const pluginPath = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (pluginPath) {
      for (const key of [...this.devUiBundleCache.keys()]) {
        if (key.startsWith(`${pluginPath}:`)) {
          this.devUiBundleCache.delete(key);
        }
      }
    }
  }

  deletePluginSourcePath(
    installedFolderName: string,
    relativePath: string,
  ): void {
    if (!isSafeRelativePluginSourcePath(relativePath)) {
      throw new Error("Invalid path");
    }
    const base = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!base) {
      throw new Error("Plugin not found");
    }
    const abs = path.resolve(base, relativePath);
    const rel = path.relative(base, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
      throw new Error("Invalid path");
    }
    if (!fs.existsSync(abs)) {
      throw new Error("Path not found");
    }
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      fs.rmSync(abs, { recursive: true, force: true });
    } else {
      fs.unlinkSync(abs);
    }
    const pluginPath = base;
    for (const key of [...this.devUiBundleCache.keys()]) {
      if (key.startsWith(`${pluginPath}:`)) {
        this.devUiBundleCache.delete(key);
      }
    }
  }

  getPluginWorkspaceAbsolutePath(installedFolderName: string): string | null {
    return this.tryResolvePluginWorkspacePath(installedFolderName);
  }
}
