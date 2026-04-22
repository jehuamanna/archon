import * as fs from "fs";
import * as path from "path";
import type { AssetMediaCategory } from "../shared/asset-media";
import { extMatchesCategory } from "../shared/asset-media";
import { getProjectAssetsDir } from "./project-session";

export type AssetFileRef = {
  /** Path relative to `assets/` using forward slashes */
  relativePath: string;
  name: string;
};

export type AssetListEntry = {
  name: string;
  isDirectory: boolean;
};

/**
 * Normalize relative path under assets: reject `..`, absolute, and drive tricks.
 * Returns POSIX-style relative segments joined for display, or null if invalid.
 */
export function safeAssetsRelativePath(raw: string): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const norm = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm === "" || norm === ".") {
    return "";
  }
  const parts = norm.split("/").filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === ".." || p.startsWith(".")) {
      return null;
    }
  }
  return parts.join(path.sep);
}

/**
 * List direct children of `assets/<relativePath>`. Skips dotfiles/dotdirs.
 */
export function listProjectAssets(
  projectRoot: string,
  relativePath: string,
): { ok: true; entries: AssetListEntry[] } | { ok: false; error: string } {
  const rel = safeAssetsRelativePath(relativePath);
  if (rel === null) {
    return { ok: false, error: "Invalid path" };
  }
  const assetsRoot = path.resolve(getProjectAssetsDir(projectRoot));
  const dir = rel ? path.join(assetsRoot, rel) : assetsRoot;
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(assetsRoot + path.sep) && resolved !== assetsRoot) {
    return { ok: false, error: "Path escapes assets" };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: "Not found" };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: "Not a directory" };
  }
  const entries: AssetListEntry[] = [];
  for (const ent of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) {
      continue;
    }
    entries.push({
      name: ent.name,
      isDirectory: ent.isDirectory(),
    });
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return { ok: true, entries };
}

/** Resolved absolute path to a file under assets, or null if invalid / not a file. */
export function resolveAssetFilePath(
  projectRoot: string,
  relativePath: string,
): string | null {
  const rel = safeAssetsRelativePath(relativePath);
  if (rel === null) {
    return null;
  }
  const assetsRoot = path.resolve(getProjectAssetsDir(projectRoot));
  const full = path.resolve(path.join(assetsRoot, rel));
  if (!full.startsWith(assetsRoot + path.sep) && full !== assetsRoot) {
    return null;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return null;
  }
  return full;
}

function resolveInAssetsRoot(
  projectRoot: string,
  rel: string,
): { assetsRoot: string; full: string } | null {
  const norm = safeAssetsRelativePath(rel);
  if (norm === null) {
    return null;
  }
  const assetsRoot = path.resolve(getProjectAssetsDir(projectRoot));
  const full = path.resolve(
    norm ? path.join(assetsRoot, norm) : assetsRoot,
  );
  if (!full.startsWith(assetsRoot + path.sep) && full !== assetsRoot) {
    return null;
  }
  return { assetsRoot, full };
}

/** Existing file or directory under `assets/`, or the assets directory itself when `relativePath` is `""`. */
export function resolveExistingAssetEntryPath(
  projectRoot: string,
  relativePath: string,
): string | null {
  const r = resolveInAssetsRoot(projectRoot, relativePath);
  if (!r) {
    return null;
  }
  if (!fs.existsSync(r.full)) {
    return null;
  }
  return r.full;
}

function isAllowedProjectRoot(
  abs: string,
  workspaceRoots: string[],
): boolean {
  const r = path.resolve(abs);
  return workspaceRoots.some((w) => path.resolve(w) === r);
}

/**
 * Move a file or directory from `fromRel` under one project’s `assets/` to a directory
 * `toDirRel` under another (or same) project’s `assets/`. Stays strictly inside `assets/`;
 * never beside the project folder on disk.
 */
export function moveProjectAsset(
  workspaceRoots: string[],
  fromProjectRoot: string,
  fromRel: string,
  toProjectRoot: string,
  toDirRel: string,
): { ok: true; toRel: string } | { ok: false; error: string } {
  const roots = workspaceRoots.map((w) => path.resolve(w));
  const fp = path.resolve(fromProjectRoot);
  const tp = path.resolve(toProjectRoot);
  if (!isAllowedProjectRoot(fp, roots) || !isAllowedProjectRoot(tp, roots)) {
    return { ok: false, error: "Project not in workspace" };
  }

  const fromNorm = safeAssetsRelativePath(fromRel);
  if (fromNorm === null || fromNorm === "") {
    return { ok: false, error: "Invalid source path" };
  }
  const fromResolved = resolveInAssetsRoot(fromProjectRoot, fromNorm);
  if (!fromResolved) {
    return { ok: false, error: "Invalid source" };
  }
  if (!fs.existsSync(fromResolved.full)) {
    return { ok: false, error: "Source missing" };
  }

  const toDirNorm = safeAssetsRelativePath(toDirRel);
  if (toDirNorm === null) {
    return { ok: false, error: "Invalid destination folder" };
  }
  const toDirResolved = resolveInAssetsRoot(toProjectRoot, toDirNorm);
  if (!toDirResolved) {
    return { ok: false, error: "Invalid destination" };
  }
  if (!fs.existsSync(toDirResolved.full)) {
    return { ok: false, error: "Destination folder missing" };
  }
  if (!fs.statSync(toDirResolved.full).isDirectory()) {
    return { ok: false, error: "Destination is not a folder" };
  }

  const base = path.basename(fromResolved.full);
  const destFull = path.join(toDirResolved.full, base);
  if (fs.existsSync(destFull)) {
    return { ok: false, error: "A file or folder with that name already exists" };
  }

  try {
    fs.renameSync(fromResolved.full, destFull);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EXDEV") {
      try {
        fs.cpSync(fromResolved.full, destFull, { recursive: true });
        fs.rmSync(fromResolved.full, { recursive: true, force: true });
      } catch (e2) {
        return {
          ok: false,
          error: e2 instanceof Error ? e2.message : String(e2),
        };
      }
    } else {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(e),
      };
    }
  }

  const relToAssets = path.relative(toDirResolved.assetsRoot, destFull);
  const toRel = relToAssets.split(path.sep).join("/");
  return { ok: true, toRel };
}

function walkAssetFiles(
  assetsRoot: string,
  dirAbs: string,
  dirRelPosix: string,
  category: AssetMediaCategory,
  out: AssetFileRef[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dirAbs, ent.name);
    const relPosix = dirRelPosix
      ? `${dirRelPosix}/${ent.name}`
      : ent.name;
    if (ent.isDirectory()) {
      walkAssetFiles(assetsRoot, full, relPosix, category, out);
      continue;
    }
    if (!ent.isFile()) {
      continue;
    }
    const ext = path.extname(ent.name).slice(1).toLowerCase();
    if (!extMatchesCategory(ext, category)) {
      continue;
    }
    out.push({ relativePath: relPosix, name: ent.name });
  }
}

/**
 * Recursively list files under `assets/` whose extension matches the media category.
 */
export function listProjectAssetsByCategory(
  projectRoot: string,
  category: AssetMediaCategory,
):
  | { ok: true; files: AssetFileRef[] }
  | { ok: false; error: string } {
  const assetsRoot = path.resolve(getProjectAssetsDir(projectRoot));
  if (!fs.existsSync(assetsRoot) || !fs.statSync(assetsRoot).isDirectory()) {
    return { ok: false, error: "Assets folder missing" };
  }
  const out: AssetFileRef[] = [];
  walkAssetFiles(assetsRoot, assetsRoot, "", category, out);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { ok: true, files: out };
}

function isAllowedProjectRootForImport(
  abs: string,
  workspaceRoots: string[],
): boolean {
  const r = path.resolve(abs);
  return workspaceRoots.some((w) => path.resolve(w) === r);
}

function uniqueDestPath(dir: string, baseName: string): string {
  let dest = path.join(dir, baseName);
  if (!fs.existsSync(dest)) {
    return dest;
  }
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  for (let i = 1; i < 10_000; i++) {
    const name = `${stem} (${i})${ext}`;
    dest = path.join(dir, name);
    if (!fs.existsSync(dest)) {
      return dest;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

const IMPORTS_SUBDIR = "_imports";

/**
 * Copy an external file into `assets/_imports/` for the given project.
 */
export function importExternalFileIntoAssets(
  workspaceRoots: string[],
  projectRoot: string,
  sourceAbsPath: string,
):
  | { ok: true; assetRel: string }
  | { ok: false; error: string } {
  const roots = workspaceRoots.map((w) => path.resolve(w));
  const pr = path.resolve(projectRoot);
  if (!isAllowedProjectRootForImport(pr, roots)) {
    return { ok: false, error: "Project not in workspace" };
  }
  let src: string;
  try {
    src = path.resolve(sourceAbsPath);
  } catch {
    return { ok: false, error: "Invalid source path" };
  }
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    return { ok: false, error: "Source file not found" };
  }
  const assetsRoot = path.resolve(getProjectAssetsDir(pr));
  const importDir = path.join(assetsRoot, IMPORTS_SUBDIR);
  try {
    fs.mkdirSync(importDir, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const baseName = path.basename(src);
  const destAbs = uniqueDestPath(importDir, baseName);
  try {
    fs.copyFileSync(src, destAbs);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const relToAssets = path.relative(assetsRoot, destAbs);
  const assetRel = relToAssets.split(path.sep).join("/");
  return { ok: true, assetRel };
}
