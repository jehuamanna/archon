#!/usr/bin/env node
/**
 * Next static export for packaged Electron (`out/` → copied to `resources/archon-web/`).
 * Dynamic Route Handlers (`app/api/*`, `app/health`) are not compatible with `output: "export"`;
 * they are temporarily moved aside for this build only.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

process.env.ARCHON_NEXT_STATIC_EXPORT = "1";
const webDir = path.join(__dirname, "..", "apps", "archon-web");
const appDir = path.join(webDir, "app");
const stashRoot = path.join(webDir, ".static-export-stash");
const apiDir = path.join(appDir, "api");
const healthDir = path.join(appDir, "health");
const apiAside = path.join(stashRoot, "api");
const healthAside = path.join(stashRoot, "health");

function moveAside(from, to) {
  if (!fs.existsSync(from)) {
    return false;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) {
    fs.rmSync(to, { recursive: true, force: true });
  }
  fs.renameSync(from, to);
  return true;
}

function moveBack(from, to) {
  if (fs.existsSync(to) && !fs.existsSync(from)) {
    fs.renameSync(to, from);
  }
}

const movedApi = moveAside(apiDir, apiAside);
const movedHealth = moveAside(healthDir, healthAside);

try {
  // Keep release/static builds deterministic on clean runners by preparing the sync-api package types.
  execSync("npm run build:lib -w @archon/sync-api", {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
    env: process.env,
  });

  execSync("npx next build", {
    stdio: "inherit",
    cwd: webDir,
    env: process.env,
  });
} finally {
  if (movedApi) {
    moveBack(apiDir, apiAside);
  }
  if (movedHealth) {
    moveBack(healthDir, healthAside);
  }
}
