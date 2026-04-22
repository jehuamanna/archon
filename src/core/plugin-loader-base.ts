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

export class PluginLoaderBase {
  /** User-installed plugins (import, IDE edits, uninstall). */
  protected userPluginsDir: string;
  /**
   * Read-only roots scanned before userPluginsDir (e.g. shipped `plugins/system`, `plugins/user`, optional `plugins/core`).
   * Same note `type` registered later wins — user plugins override bundled.
   */
  protected bundledCoreRoots: string[];
  protected loadedPlugins: Set<string> = new Set();
  protected devUiBundleCache: Map<string, { mtime: number; code: string }> =
    new Map();
  protected loadIssues: { folder: string; error: string }[] = [];
  /** Used for plugin-disabled.json (user plugins only). */
  protected userDataPathForDisabled: string | null = null;

  constructor(userPluginsDir: string, bundledCoreRoots: string[] = []) {
    this.userPluginsDir = userPluginsDir;
    this.bundledCoreRoots = bundledCoreRoots.filter(
      (p) => typeof p === "string" && p.length > 0 && fs.existsSync(p),
    );
  }

  setUserDataPathForDisabled(p: string): void {
    this.userDataPathForDisabled = p;
  }

  protected getDisabledUserPluginIds(): Set<string> {
    if (!this.userDataPathForDisabled) {
      return new Set();
    }
    return readDisabledPluginIds(this.userDataPathForDisabled);
  }

  getDisabledUserPluginIdsForIpc(): string[] {
    return [...this.getDisabledUserPluginIds()].sort();
  }

  /**
   * Enable/disable loading of a **user** plugin (folder id). Bundled plugins cannot be disabled.
   */
  setUserPluginEnabled(pluginId: string, enabled: boolean): void {
    if (!isSafePluginName(pluginId)) {
      throw new Error("Invalid plugin id");
    }
    if (this.isBundledPluginFolder(pluginId)) {
      throw new Error("Bundled plugins cannot be disabled");
    }
    if (!this.userDataPathForDisabled) {
      throw new Error("User data path not configured");
    }
    const cur = readDisabledPluginIds(this.userDataPathForDisabled);
    if (enabled) {
      cur.delete(pluginId);
    } else {
      cur.add(pluginId);
    }
    writeDisabledPluginIds(this.userDataPathForDisabled, cur);
  }

  /** True if a manifest exists under any bundled core root for this folder name. */
  isBundledPluginFolder(folderName: string): boolean {
    for (const root of this.bundledCoreRoots) {
      const mp = path.join(root, folderName, "manifest.json");
      if (fs.existsSync(mp)) {
        return true;
      }
    }
    return false;
  }

  listBundledPluginFolderNames(): string[] {
    const names = new Set<string>();
    for (const root of this.bundledCoreRoots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) {
          continue;
        }
        if (fs.existsSync(path.join(root, ent.name, "manifest.json"))) {
          names.add(ent.name);
        }
      }
    }
    return [...names].sort();
  }

  getPluginInventory(): {
    id: string;
    isBundled: boolean;
    canToggle: boolean;
    enabled: boolean;
    loaded: boolean;
  }[] {
    const disabled = this.getDisabledUserPluginIds();
    const bundled = this.listBundledPluginFolderNames();
    const user = this.collectUserPluginIds();
    const ids = new Set<string>([...bundled, ...user]);
    const list = [...ids].sort();
    return list.map((id) => {
      const isBundled = this.isBundledPluginFolder(id);
      const canToggle = !isBundled;
      const enabled = isBundled || !disabled.has(id);
      const loaded = this.loadedPlugins.has(id);
      return { id, isBundled, canToggle, enabled, loaded };
    });
  }

  protected static readonly RESERVED_TOP_LEVEL = new Set(["sources", "bin"]);

  protected userSourcesRoot(): string {
    return path.join(this.userPluginsDir, "sources");
  }

  protected userBinRoot(): string {
    return path.join(this.userPluginsDir, "bin");
  }

  protected ideExternalPluginsJsonPath(): string {
    return path.join(this.userPluginsDir, "ide-external-plugins.json");
  }

  /** Optional JSON: `{ "entries": [ { "id": "foo", "path": "/abs/..." } ] }` */
  readExternalPluginEntries(): { id: string; path: string }[] {
    const p = this.ideExternalPluginsJsonPath();
    if (!fs.existsSync(p)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(p, "utf8");
      const j = JSON.parse(raw) as { entries?: { id: string; path: string }[] };
      if (!Array.isArray(j.entries)) {
        return [];
      }
      return j.entries.filter(
        (e) =>
          e &&
          typeof e.id === "string" &&
          typeof e.path === "string" &&
          isSafePluginName(e.id) &&
          path.isAbsolute(e.path),
      );
    } catch {
      return [];
    }
  }

  protected writeExternalPluginEntries(entries: { id: string; path: string }[]): void {
    fs.mkdirSync(this.userPluginsDir, { recursive: true });
    fs.writeFileSync(
      this.ideExternalPluginsJsonPath(),
      JSON.stringify({ entries }, null, 2),
      "utf8",
    );
  }

  protected resolveExternalWorkspacePath(
    installedFolderName: string,
  ): string | null {
    if (!isSafePluginName(installedFolderName)) {
      return null;
    }
    for (const e of this.readExternalPluginEntries()) {
      if (e.id !== installedFolderName) {
        continue;
      }
      const mp = path.join(e.path, "manifest.json");
      if (fs.existsSync(mp)) {
        return path.resolve(e.path);
      }
    }
    return null;
  }

  /**
   * Scan a parent directory's immediate subfolders for `.archonplugin` + `manifest.json`.
   * Persists roots in ide-external-plugins.json (sources/ wins on id conflict).
   */
  loadArchonPluginsFromParentDir(parentAbs: string): {
    added: string[];
    warnings: string[];
    errors: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const added: string[] = [];
    const resolved = path.resolve(parentAbs);
    if (!fs.existsSync(resolved)) {
      errors.push("Path does not exist");
      return { added, warnings, errors };
    }
    if (!fs.statSync(resolved).isDirectory()) {
      errors.push("Not a directory");
      return { added, warnings, errors };
    }

    const map = new Map(
      this.readExternalPluginEntries().map((e) => [e.id, e]),
    );

    for (const ent of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) {
        continue;
      }
      const childPath = path.resolve(path.join(resolved, ent.name));
      const marker = path.join(childPath, ".archonplugin");
      if (!fs.existsSync(marker)) {
        continue;
      }
      if (!fs.existsSync(path.join(childPath, "manifest.json"))) {
        warnings.push(
          `${ent.name}: .archonplugin present but manifest.json missing — skipped`,
        );
        continue;
      }

      let id = ent.name;
      try {
        const raw = fs.readFileSync(marker, "utf8").trim();
        if (raw.length > 0) {
          const j = JSON.parse(raw) as { id?: string };
          if (typeof j.id === "string" && isSafePluginName(j.id)) {
            id = j.id;
          }
        }
      } catch {
        warnings.push(`${ent.name}: .archonplugin is not valid JSON — using folder name as id`);
      }

      if (!isSafePluginName(id)) {
        warnings.push(`${ent.name}: invalid plugin id — skipped`);
        continue;
      }

      const fromSources = path.join(this.userSourcesRoot(), id);
      if (fs.existsSync(path.join(fromSources, "manifest.json"))) {
        warnings.push(
          `${id}: already in sources/ — external entry not added`,
        );
        continue;
      }

      const prev = map.get(id);
      map.set(id, { id, path: childPath });
      if (!prev || prev.path !== childPath) {
        added.push(id);
      }
    }

    this.writeExternalPluginEntries([...map.values()].sort((a, b) => a.id.localeCompare(b.id)));
    return { added, warnings, errors };
  }

  removeExternalPluginWorkspace(id: string): boolean {
    if (!isSafePluginName(id)) {
      return false;
    }
    const cur = this.readExternalPluginEntries();
    const next = cur.filter((e) => e.id !== id);
    if (next.length === cur.length) {
      return false;
    }
    this.writeExternalPluginEntries(next);
    return true;
  }

  /**
   * Editable plugin tree: IDE-registered external folder first (the folder you opened
   * in the Plugin IDE), then `sources/<name>`, then legacy flat `userData/plugins/<name>`.
   * External wins so `npm install`, bundle, and file ops run where you are actually
   * editing — not under `sources/` unless there is no external entry.
   */
  protected tryResolvePluginWorkspacePath(
    installedFolderName: string,
  ): string | null {
    if (!isSafePluginName(installedFolderName)) {
      return null;
    }
    const ext = this.resolveExternalWorkspacePath(installedFolderName);
    if (ext) {
      return ext;
    }
    const fromSources = path.join(this.userSourcesRoot(), installedFolderName);
    if (fs.existsSync(path.join(fromSources, "manifest.json"))) {
      return fromSources;
    }
    if (PluginLoaderBase.RESERVED_TOP_LEVEL.has(installedFolderName)) {
      return null;
    }
    const legacy = path.join(this.userPluginsDir, installedFolderName);
    if (fs.existsSync(path.join(legacy, "manifest.json"))) {
      return legacy;
    }
    return null;
  }
  protected collectUserPluginIds(): string[] {
    const names = new Set<string>();
    const addFromDir = (root: string): void => {
      if (!fs.existsSync(root)) {
        return;
      }
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) {
          continue;
        }
        const p = path.join(root, ent.name);
        if (fs.existsSync(path.join(p, "manifest.json"))) {
          names.add(ent.name);
        }
      }
    };
    addFromDir(this.userSourcesRoot());
    addFromDir(this.userBinRoot());
    if (fs.existsSync(this.userPluginsDir)) {
      for (const ent of fs.readdirSync(this.userPluginsDir, {
        withFileTypes: true,
      })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) {
          continue;
        }
        if (PluginLoaderBase.RESERVED_TOP_LEVEL.has(ent.name)) {
          continue;
        }
        const p = path.join(this.userPluginsDir, ent.name);
        if (fs.existsSync(path.join(p, "manifest.json"))) {
          names.add(ent.name);
        }
      }
    }
    for (const e of this.readExternalPluginEntries()) {
      if (
        isSafePluginName(e.id) &&
        fs.existsSync(path.join(e.path, "manifest.json"))
      ) {
        names.add(e.id);
      }
    }
    return Array.from(names).sort();
  }
  protected invalidateDevUiCacheForWorkspace(workspaceRoot: string): void {
    for (const key of [...this.devUiBundleCache.keys()]) {
      if (key.startsWith(`${workspaceRoot}:`)) {
        this.devUiBundleCache.delete(key);
      }
    }
  }
}
