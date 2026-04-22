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
import { PluginLoaderImportTree } from "./plugin-loader-import-tree";

export class PluginLoaderIdeTypings extends PluginLoaderImportTree {

  /**
   * Monaco cannot see global plugin-cache deps when the workspace has no
   * local node_modules. Register virtual file:// entries under
   * `<workspace>/node_modules/...` backed by cache (or local) package files.
   */
  getIdePluginVirtualTypings(installedFolderName: string): {
    workspaceRootFileUri: string;
    libs: { fileName: string; content: string }[];
  } | null {
    if (!isSafePluginName(installedFolderName)) {
      return null;
    }
    const workspaceRoot = this.tryResolvePluginWorkspacePath(installedFolderName);
    if (!workspaceRoot) {
      return null;
    }

    let manifest: PluginManifest;
    try {
      const raw = fs.readFileSync(
        path.join(workspaceRoot, "manifest.json"),
        "utf8",
      );
      manifest = JSON.parse(raw) as PluginManifest;
    } catch {
      return {
        workspaceRootFileUri: toFileUri(workspaceRoot),
        libs: [],
      };
    }

    const cacheNm = pluginCacheManager.getNodeModulesPath(manifest.name);
    const localNm = path.join(workspaceRoot, "node_modules");

    const seed = new Set<string>();
    try {
      const pkgJsonPath = path.join(workspaceRoot, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(
          fs.readFileSync(pkgJsonPath, "utf8"),
        ) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        for (const k of Object.keys(pkg.dependencies ?? {})) {
          seed.add(k);
        }
        for (const k of Object.keys(pkg.devDependencies ?? {})) {
          seed.add(k);
        }
      }
    } catch {
      /* optional */
    }
    for (const k of Object.keys(manifest.dependencies ?? {})) {
      seed.add(k);
    }

    let needsHostReactTypings = Boolean(manifest.ui);
    if (!needsHostReactTypings) {
      try {
        const files = this.listPluginSourceFiles(installedFolderName);
        needsHostReactTypings = files.some((f) => {
          const lower = f.toLowerCase();
          return lower.endsWith(".tsx") || lower.endsWith(".jsx");
        });
      } catch {
        /* ignore */
      }
    }
    if (needsHostReactTypings) {
      seed.add("react");
      seed.add("react-dom");
    }

    const pkgNames = this.collectTransitiveNpmPackageNames(
      seed,
      localNm,
      cacheNm,
      96,
    );
    const libs: { fileName: string; content: string }[] = [];
    const seenUri = new Set<string>();

    for (const name of pkgNames) {
      const physicalRoot = this.resolveNpmPackageRoot(name, localNm, cacheNm);
      if (!physicalRoot) {
        continue;
      }
      const virtualBase = path.join(workspaceRoot, "node_modules", ...name.split("/"));
      const pkgJsonReal = path.join(physicalRoot, "package.json");
      if (fs.existsSync(pkgJsonReal)) {
        const v = path.join(virtualBase, "package.json");
        const u = toFileUri(v);
        if (!seenUri.has(u)) {
          seenUri.add(u);
          libs.push({
            fileName: u,
            content: fs.readFileSync(pkgJsonReal, "utf8"),
          });
        }
      }
      const dtsFiles = new Map<string, string>();
      this.collectDeclarationFilesUnderDir(physicalRoot, dtsFiles, 200);
      for (const [abs, content] of dtsFiles) {
        const rel = path.relative(physicalRoot, abs);
        const virt = path.join(virtualBase, rel);
        const uri = toFileUri(virt);
        if (seenUri.has(uri)) {
          continue;
        }
        seenUri.add(uri);
        libs.push({ fileName: uri, content });
      }
    }

    return {
      workspaceRootFileUri: toFileUri(workspaceRoot),
      libs,
    };
  }

  protected resolveNpmPackageRoot(
    name: string,
    localNm: string,
    cacheNm: string,
  ): string | null {
    const parts = name.split("/");
    const tryNm = (nmRoot: string) => {
      const p = path.join(nmRoot, ...parts);
      return fs.existsSync(path.join(p, "package.json")) ? p : null;
    };
    return tryNm(localNm) ?? tryNm(cacheNm);
  }

  protected collectTransitiveNpmPackageNames(
    seed: Set<string>,
    localNm: string,
    cacheNm: string,
    maxPackages: number,
  ): string[] {
    const seen = new Set<string>();
    const queue: string[] = [...seed];
    while (queue.length > 0 && seen.size < maxPackages) {
      const name = queue.shift()!;
      if (seen.has(name)) {
        continue;
      }
      const root = this.resolveNpmPackageRoot(name, localNm, cacheNm);
      if (!root) {
        continue;
      }
      seen.add(name);
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(root, "package.json"), "utf8"),
        ) as {
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        const next = {
          ...pkg.dependencies,
          ...pkg.peerDependencies,
        };
        for (const dep of Object.keys(next)) {
          if (!seen.has(dep)) {
            queue.push(dep);
          }
        }
      } catch {
        /* skip */
      }
    }
    return [...seen];
  }

  protected collectDeclarationFilesUnderDir(
    dir: string,
    out: Map<string, string>,
    maxFiles: number,
  ): void {
    const walk = (d: string): void => {
      if (out.size >= maxFiles) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (out.size >= maxFiles) {
          return;
        }
        if (ent.name === "node_modules") {
          continue;
        }
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (/\.d\.(ts|mts|cts)$/.test(ent.name)) {
          try {
            out.set(full, fs.readFileSync(full, "utf8"));
          } catch {
            /* skip */
          }
        }
      }
    };
    walk(dir);
  }
}
