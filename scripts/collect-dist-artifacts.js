#!/usr/bin/env node
/**
 * Copy final installers from Electron Forge staging (`out/make`) into `dist/`:
 *   dist/deb/*.deb, dist/appimage/*.AppImage, dist/dmg/*.dmg, dist/exe/*Setup*.exe
 * Filenames include the root package.json version (filesystem-safe).
 * Does not delete or modify `dist/plugins/`.
 *
 * After copying, removes Forge leftovers under `dist/` (`make/`, packaged app dirs like
 * `archon-linux-x64`) — final installers live in `deb/`, `appimage/`, etc.; use `out/` for full staging.
 *
 * Staging dir: `out/make` (forge outDir is `out`).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const SAFE_VER = String(PKG.version).replace(/[^a-zA-Z0-9._-]+/g, "-");

const STAGING_MAKE = path.join(ROOT, "out", "make");
const DIST = path.join(ROOT, "dist");

/** Keep these `dist/` subdirs (final artifacts + plugins). */
const DIST_KEEP = new Set(["deb", "appimage", "dmg", "exe", "plugins"]);

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

function clearAndEnsure(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyInto(src, destDir, destBase) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, destBase);
  fs.copyFileSync(src, dest);
  console.log(`[collect-dist] ${path.relative(ROOT, src)} → ${path.relative(ROOT, dest)}`);
}

/**
 * Remove intermediate Forge output accidentally left under `dist/` (e.g. if outDir was `dist`).
 */
function cleanupDistStaging() {
  if (!fs.existsSync(DIST)) return;
  const makePath = path.join(DIST, "make");
  if (fs.existsSync(makePath)) {
    fs.rmSync(makePath, { recursive: true, force: true });
    console.log(`[collect-dist] removed ${path.relative(ROOT, makePath)}`);
  }
  for (const ent of fs.readdirSync(DIST, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (DIST_KEEP.has(name)) continue;
    if (/^archon-/i.test(name)) {
      const p = path.join(DIST, name);
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`[collect-dist] removed ${path.relative(ROOT, p)}`);
    }
  }
}

function debArchFromPath(file) {
  const parts = file.split(path.sep);
  const i = parts.indexOf("deb");
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  if (file.includes("arm64")) return "arm64";
  return "amd64";
}

function main() {
  const files = walkFiles(STAGING_MAKE);
  const debs = files.filter((f) => f.endsWith(".deb"));
  const appimages = files.filter((f) => /\.AppImage$/i.test(f));
  const dmgs = files.filter((f) => f.endsWith(".dmg"));
  /** macOS zip from maker-zip (optional); exclude Squirrel / Windows artifacts */
  const macZips = files.filter(
    (f) =>
      f.endsWith(".zip") &&
      !/squirrel\.windows/i.test(f) &&
      !/\.nupkg$/i.test(f),
  );
  const setupExes = files.filter(
    (f) =>
      f.endsWith(".exe") &&
      /Setup\.exe$/i.test(path.basename(f)) &&
      !/Update\.exe$/i.test(path.basename(f)),
  );

  if (debs.length) {
    clearAndEnsure(path.join(DIST, "deb"));
    debs.forEach((src, idx) => {
      const arch = debArchFromPath(src);
      const name =
        debs.length > 1
          ? `archon-${SAFE_VER}-linux-${arch}-${idx}.deb`
          : `archon-${SAFE_VER}-linux-${arch}.deb`;
      copyInto(src, path.join(DIST, "deb"), name);
    });
  }

  if (appimages.length) {
    clearAndEnsure(path.join(DIST, "appimage"));
    appimages.forEach((src, idx) => {
      const base = path.basename(src);
      const m = base.match(/-([^-.]+)\.AppImage$/i);
      const arch = m ? m[1] : "x64";
      const name =
        appimages.length > 1
          ? `archon-${SAFE_VER}-linux-${arch}-${idx}.AppImage`
          : `archon-${SAFE_VER}-linux-${arch}.AppImage`;
      copyInto(src, path.join(DIST, "appimage"), name);
    });
  }

  if (dmgs.length) {
    clearAndEnsure(path.join(DIST, "dmg"));
    dmgs.forEach((src, idx) => {
      const name =
        dmgs.length > 1
          ? `archon-${SAFE_VER}-darwin-${idx}.dmg`
          : `archon-${SAFE_VER}-darwin.dmg`;
      copyInto(src, path.join(DIST, "dmg"), name);
    });
  } else if (macZips.length) {
    clearAndEnsure(path.join(DIST, "dmg"));
    macZips.forEach((src, idx) => {
      const name =
        macZips.length > 1
          ? `archon-${SAFE_VER}-darwin-${idx}.zip`
          : `archon-${SAFE_VER}-darwin.zip`;
      copyInto(src, path.join(DIST, "dmg"), name);
    });
  }

  if (setupExes.length) {
    clearAndEnsure(path.join(DIST, "exe"));
    setupExes.forEach((src, idx) => {
      const name =
        setupExes.length > 1
          ? `archon-${SAFE_VER}-windows-setup-${idx}.exe`
          : `archon-${SAFE_VER}-windows-setup.exe`;
      copyInto(src, path.join(DIST, "exe"), name);
    });
  }

  if (
    !debs.length &&
    !appimages.length &&
    !dmgs.length &&
    !macZips.length &&
    !setupExes.length
  ) {
    console.warn(
      `[collect-dist] No installers under ${path.relative(ROOT, STAGING_MAKE)} (run electron-forge make first).`,
    );
  }

  cleanupDistStaging();
}

main();
