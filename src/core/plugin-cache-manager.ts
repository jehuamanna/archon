import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isSafePluginName } from "../shared/validators";

export interface PackageJsonSource {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

/**
 * Per-plugin dependency install root under Electron `app.getPath("cache")/archon/plugin-cache/<name>/`.
 * Call `setRoot()` from main after `app` is ready (cross-platform).
 */
export class PluginCacheManager {
  private root: string;

  constructor(initialRoot: string) {
    this.root = initialRoot;
  }

  /** Must be called before `ensureRoot` / installs when overriding the default. */
  setRoot(absPath: string): void {
    this.root = absPath;
  }

  getRoot(): string {
    return this.root;
  }

  getPluginCacheDir(pluginName: string): string {
    if (!isSafePluginName(pluginName)) {
      throw new Error("Invalid plugin name");
    }
    return path.join(this.root, pluginName);
  }

  getNodeModulesPath(pluginName: string): string {
    return path.join(this.getPluginCacheDir(pluginName), "node_modules");
  }

  ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /**
   * Copy plugin package.json into cache, or synthesize one from manifest.dependencies.
   * Returns the cache directory (contains package.json).
   */
  syncPackageJsonToCache(
    pluginSourcePath: string,
    meta: PackageJsonSource,
  ): string {
    if (!isSafePluginName(meta.name)) {
      throw new Error("Invalid plugin name");
    }

    const dir = this.getPluginCacheDir(meta.name);
    fs.mkdirSync(dir, { recursive: true });

    const dest = path.join(dir, "package.json");
    const src = path.join(pluginSourcePath, "package.json");

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      return dir;
    }

    const deps = meta.dependencies;
    if (deps && Object.keys(deps).length > 0) {
      const pkg = {
        name: `@archon-plugin/${meta.name}`,
        version: meta.version,
        private: true,
        dependencies: { ...deps },
      };
      fs.writeFileSync(dest, JSON.stringify(pkg, null, 2));
      return dir;
    }

    throw new Error(
      "No package.json in plugin and no manifest.dependencies to install",
    );
  }

  /**
   * Epic 3.5: install with --ignore-scripts to reduce supply-chain script risk.
   */
  runNpmInstall(
    pluginName: string,
    onLog?: (line: string) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    const dir = this.getPluginCacheDir(pluginName);
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = [
      "install",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      "--loglevel",
      "warn",
    ];

    return new Promise((resolve) => {
      const child = spawn(npmCmd, args, {
        cwd: dir,
        env: process.env,
        shell: process.platform === "win32",
      });

      const drain = (chunk: Buffer, isErr: boolean) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            onLog?.(isErr ? `[stderr] ${line}` : line);
          }
        }
      };

      child.stdout?.on("data", (c: Buffer) => drain(c, false));
      child.stderr?.on("data", (c: Buffer) => drain(c, true));
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ ok: true });
        } else {
          resolve({
            ok: false,
            error: `npm install exited with code ${code}`,
          });
        }
      });
    });
  }

  /**
   * Run `npm install` in an arbitrary directory (plugin workspace).
   */
  runNpmInstallInDir(
    cwd: string,
    onLog?: (line: string) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    fs.mkdirSync(cwd, { recursive: true });
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = [
      "install",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      "--loglevel",
      "warn",
    ];

    return new Promise((resolve) => {
      const child = spawn(npmCmd, args, {
        cwd,
        env: process.env,
        shell: process.platform === "win32",
      });

      const drain = (chunk: Buffer, isErr: boolean) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            onLog?.(isErr ? `[stderr] ${line}` : line);
          }
        }
      };

      child.stdout?.on("data", (c: Buffer) => drain(c, false));
      child.stderr?.on("data", (c: Buffer) => drain(c, true));
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ ok: true });
        } else {
          resolve({
            ok: false,
            error: `npm install exited with code ${code}`,
          });
        }
      });
    });
  }

  directorySizeBytes(dir: string): number {
    if (!fs.existsSync(dir)) {
      return 0;
    }
    let total = 0;
    const walk = (d: string) => {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (e.isFile()) {
          try {
            total += fs.statSync(p).size;
          } catch {
            /* skip */
          }
        }
      }
    };
    walk(dir);
    return total;
  }

  getPluginCacheSizeBytes(pluginName: string): number {
    return this.directorySizeBytes(this.getPluginCacheDir(pluginName));
  }

  getTotalCacheSizeBytes(): number {
    if (!fs.existsSync(this.root)) {
      return 0;
    }
    let total = 0;
    for (const name of fs.readdirSync(this.root)) {
      const p = path.join(this.root, name);
      if (fs.statSync(p).isDirectory()) {
        total += this.directorySizeBytes(p);
      }
    }
    return total;
  }

  clearPlugin(pluginName: string): void {
    const dir = this.getPluginCacheDir(pluginName);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  clearAll(): void {
    if (!fs.existsSync(this.root)) {
      return;
    }
    for (const name of fs.readdirSync(this.root)) {
      const p = path.join(this.root, name);
      if (fs.statSync(p).isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  }
}

export const pluginCacheManager = new PluginCacheManager(
  path.join(os.homedir(), ".archon", "plugin-cache"),
);
