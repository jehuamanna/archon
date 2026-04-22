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
import { PluginLoaderBundle } from "./plugin-loader-bundle";

export class PluginLoaderDeps extends PluginLoaderBundle {
  protected ensureWorkspacePackageJsonForInstall(
    pluginPath: string,
    manifest: PluginManifest,
  ): void {
    const dest = path.join(pluginPath, "package.json");
    if (fs.existsSync(dest)) {
      return;
    }
    const deps = { ...(manifest.dependencies ?? {}) };
    const devDeps = { ...(manifest.devDependencies ?? {}) };
    if (
      Object.keys(deps).length === 0 &&
      Object.keys(devDeps).length === 0
    ) {
      throw new Error(
        "No package.json in plugin and no manifest dependencies or devDependencies",
      );
    }
    const pkg: Record<string, unknown> = {
      name: `@archon-plugin/${manifest.name}`,
      version: manifest.version,
      private: true,
    };
    if (Object.keys(deps).length > 0) {
      pkg.dependencies = deps;
    }
    if (Object.keys(devDeps).length > 0) {
      pkg.devDependencies = devDeps;
    }
    fs.writeFileSync(dest, JSON.stringify(pkg, null, 2), "utf8");
  }

  /** Install npm deps into the plugin workspace; copy host `@archon/*` into `node_modules`. */
  async installPluginDependencies(pluginName: string): Promise<{
    success: boolean;
    error?: string;
    log?: string;
  }> {
    if (!isSafePluginName(pluginName)) {
      return { success: false, error: "Invalid plugin name" };
    }

    const pluginPath = this.tryResolvePluginWorkspacePath(pluginName);
    if (!pluginPath) {
      return { success: false, error: `Plugin ${pluginName} not found` };
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(path.join(pluginPath, "manifest.json"), "utf8"),
    );

    if (!isSafePluginName(manifest.name)) {
      return { success: false, error: "Invalid manifest name" };
    }

    const lines: string[] = [];

    emitPluginProgress({
      op: "npm",
      phase: "start",
      message: `npm install (${manifest.name})`,
      pluginName: manifest.name,
    });

    try {
      this.ensureWorkspacePackageJsonForInstall(pluginPath, manifest);
    } catch (e) {
      emitPluginProgress({
        op: "npm",
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
        pluginName: manifest.name,
      });
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const result = await pluginCacheManager.runNpmInstallInDir(
      pluginPath,
      (line) => {
        lines.push(line);
        emitPluginProgress({
          op: "npm",
          phase: "log",
          message: line,
          pluginName: manifest.name,
        });
      },
    );

    if (result.ok) {
      try {
        syncHostArchonScopedPackagesIntoWorkspace(pluginPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emitPluginProgress({
          op: "npm",
          phase: "error",
          message: `npm ok but @archon sync failed: ${msg}`,
          pluginName: manifest.name,
        });
        return {
          success: false,
          error: `@archon package sync failed: ${msg}`,
          log: lines.join("\n"),
        };
      }
      for (const key of [...this.devUiBundleCache.keys()]) {
        if (key.startsWith(`${pluginPath}:`)) {
          this.devUiBundleCache.delete(key);
        }
      }
      this.writeDepsSnapshot(pluginPath, manifest);
      emitPluginProgress({
        op: "npm",
        phase: "done",
        message: `npm install finished (${manifest.name})`,
        pluginName: manifest.name,
      });
    } else {
      emitPluginProgress({
        op: "npm",
        phase: "error",
        message: result.error ?? "npm install failed",
        pluginName: manifest.name,
      });
    }

    return {
      success: result.ok,
      error: result.error,
      log: lines.join("\n"),
    };
  }

  protected getDepsSnapshotPath(pluginPath: string): string {
    return path.join(pluginPath, ".archon-deps-snapshot.json");
  }

  protected computeDepsIntentHash(
    pluginPath: string,
    manifest: PluginManifest,
  ): string {
    const pj = path.join(pluginPath, "package.json");
    const pkg = fs.existsSync(pj) ? fs.readFileSync(pj, "utf8") : "";
    return crypto
      .createHash("sha256")
      .update(pkg)
      .update("|")
      .update(JSON.stringify(manifest.dependencies ?? {}))
      .digest("hex");
  }

  protected readDepsSnapshotHash(pluginPath: string): string | null {
    const p = this.getDepsSnapshotPath(pluginPath);
    if (!fs.existsSync(p)) {
      return null;
    }
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8")) as { hash?: string };
      return j.hash ?? null;
    } catch {
      return null;
    }
  }

  protected writeDepsSnapshot(
    pluginPath: string,
    manifest: PluginManifest,
  ): void {
    const hash = this.computeDepsIntentHash(pluginPath, manifest);
    fs.writeFileSync(
      this.getDepsSnapshotPath(pluginPath),
      JSON.stringify({ hash, updated: Date.now() }, null, 2),
      "utf8",
    );
  }

  async getPluginInstallPlan(installedFolderName: string): Promise<{
    manifestName: string;
    cacheDir: string;
    dependencies: Record<string, string>;
    dependencyCount: number;
    warnManyDeps: boolean;
    warnLargePackageJson: boolean;
    depsChangedSinceLastInstall: boolean;
    hadSnapshot: boolean;
    registryNotes: string[];
  }> {
    if (!isSafePluginName(installedFolderName)) {
      throw new Error("Invalid plugin name");
    }

    const pluginPath = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!pluginPath) {
      throw new Error("Plugin not found");
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(path.join(pluginPath, "manifest.json"), "utf8"),
    );

    if (!isSafePluginName(manifest.name)) {
      throw new Error("Invalid manifest name");
    }

    const pj = path.join(pluginPath, "package.json");
    let dependencies: Record<string, string> = {
      ...(manifest.dependencies ?? {}),
    };

    if (fs.existsSync(pj)) {
      const pkg = JSON.parse(fs.readFileSync(pj, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      dependencies = { ...dependencies, ...(pkg.dependencies ?? {}) };
    }

    const dependencyCount = Object.keys(dependencies).length;
    const pkgLen = fs.existsSync(pj) ? fs.readFileSync(pj, "utf8").length : 0;
    const warnLargePackageJson = pkgLen > 50_000;

    const prev = this.readDepsSnapshotHash(pluginPath);
    const cur = this.computeDepsIntentHash(pluginPath, manifest);
    const hadSnapshot = prev !== null;

    const registryNotes: string[] = [];
    const probe = Object.keys(dependencies).slice(0, 6);
    for (const name of probe) {
      const ok = await npmPackageExistsOnRegistry(name);
      if (!ok) {
        registryNotes.push(
          `${name}: registry HEAD did not return 200 (offline, private scope, or typo)`,
        );
      }
    }

    return {
      manifestName: manifest.name,
      cacheDir: pluginPath,
      dependencies,
      dependencyCount,
      warnManyDeps: dependencyCount > 25,
      warnLargePackageJson,
      depsChangedSinceLastInstall: hadSnapshot ? prev !== cur : true,
      hadSnapshot,
      registryNotes,
    };
  }

  getPluginResolvedDeps(installedFolderName: string): {
    declared: Record<string, string>;
    resolved: Record<string, string>;
    error?: string;
  } {
    if (!isSafePluginName(installedFolderName)) {
      return { declared: {}, resolved: {}, error: "Invalid plugin name" };
    }

    const pluginPath = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!pluginPath) {
      return { declared: {}, resolved: {}, error: "Plugin not found" };
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(path.join(pluginPath, "manifest.json"), "utf8"),
    );

    const wsPkg = path.join(pluginPath, "package.json");

    let declared: Record<string, string> = {
      ...(manifest.dependencies ?? {}),
    };
    if (fs.existsSync(wsPkg)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(wsPkg, "utf8")) as {
          dependencies?: Record<string, string>;
        };
        declared = { ...declared, ...(pkg.dependencies ?? {}) };
      } catch {
        /* ignore */
      }
    }

    const resolved: Record<string, string> = {};
    if (!fs.existsSync(path.join(pluginPath, "node_modules"))) {
      return { declared, resolved };
    }

    try {
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const out = execFileSync(npmCmd, ["ls", "--json", "--depth=0"], {
        cwd: pluginPath,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      const j = JSON.parse(out) as {
        dependencies?: Record<string, { version?: string }>;
      };
      const depTree = j.dependencies ?? {};
      for (const k of Object.keys(depTree)) {
        const v = depTree[k]?.version;
        if (v) {
          resolved[k] = v;
        }
      }
    } catch (e) {
      return {
        declared,
        resolved,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    return { declared, resolved };
  }

  async runNpmOnPluginCache(
    installedFolderName: string,
    npmArgs: string[],
  ): Promise<{ success: boolean; error?: string; log?: string }> {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }

    const pluginPath = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!pluginPath) {
      return { success: false, error: "Plugin not found" };
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(path.join(pluginPath, "manifest.json"), "utf8"),
    );

    try {
      this.ensureWorkspacePackageJsonForInstall(pluginPath, manifest);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const cwd = pluginPath;
    const lines: string[] = [];
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = [...npmArgs, "--ignore-scripts", "--no-fund", "--no-audit"];

    return await new Promise((resolve) => {
      const child = spawn(npmCmd, args, {
        cwd,
        env: process.env,
        shell: process.platform === "win32",
      });

      const drain = (chunk: Buffer, isErr: boolean) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }
          const msg = isErr ? `[stderr] ${line}` : line;
          lines.push(msg);
          emitPluginProgress({
            op: "npm",
            phase: "log",
            message: msg,
            pluginName: manifest.name,
          });
        }
      };

      child.stdout?.on("data", (c: Buffer) => drain(c, false));
      child.stderr?.on("data", (c: Buffer) => drain(c, true));
      child.on("error", (err: Error) => {
        resolve({ success: false, error: err.message, log: lines.join("\n") });
      });
      child.on("close", (code: number) => {
        if (code === 0) {
          try {
            syncHostArchonScopedPackagesIntoWorkspace(pluginPath);
          } catch (e) {
            resolve({
              success: false,
              error:
                e instanceof Error ? e.message : String(e),
              log: lines.join("\n"),
            });
            return;
          }
          this.writeDepsSnapshot(pluginPath, manifest);
          resolve({ success: true, log: lines.join("\n") });
        } else {
          resolve({
            success: false,
            error: `npm exited with code ${code}`,
            log: lines.join("\n"),
          });
        }
      });
    });
  }

  clearPluginDependencyCache(installedFolderName: string): {
    success: boolean;
    error?: string;
  } {
    if (!isSafePluginName(installedFolderName)) {
      return { success: false, error: "Invalid plugin name" };
    }

    const pluginPath = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!pluginPath) {
      return { success: false, error: "Plugin not found" };
    }

    try {
      const manifest: PluginManifest = JSON.parse(
        fs.readFileSync(path.join(pluginPath, "manifest.json"), "utf8"),
      );
      if (isSafePluginName(manifest.name)) {
        pluginCacheManager.clearPlugin(manifest.name);
      }
      const nm = path.join(pluginPath, "node_modules");
      if (fs.existsSync(nm)) {
        fs.rmSync(nm, { recursive: true, force: true });
      }
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
