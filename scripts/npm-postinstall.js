"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** Allow repo root `.env` to set this without exporting in the shell (only this key is read). */
function applySkipFromRootDotenv() {
  if (process.env.ARCHON_SKIP_ELECTRON_REBUILD !== undefined) {
    return;
  }
  const envPath = path.join(__dirname, "..", ".env");
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (let line of raw.split(/\r?\n/)) {
    const hash = line.indexOf("#");
    if (hash >= 0) {
      line = line.slice(0, hash);
    }
    const m = line.match(/^\s*ARCHON_SKIP_ELECTRON_REBUILD\s*=\s*(.*)$/);
    if (!m) {
      continue;
    }
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v === "1" || /^true$/i.test(v)) {
      process.env.ARCHON_SKIP_ELECTRON_REBUILD = "1";
      return;
    }
  }
}

applySkipFromRootDotenv();

console.log("[archon] Building @archon/sync-api...");
const buildSyncApi = spawnSync("npm", ["run", "build:lib", "-w", "@archon/sync-api"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
  cwd: path.join(__dirname, ".."),
});

if (buildSyncApi.status !== 0) {
  console.error("[archon] Failed to build @archon/sync-api");
  process.exit(buildSyncApi.status ?? 1);
}

if (process.env.ARCHON_SKIP_ELECTRON_REBUILD === "1") {
  console.log(
    "[archon] Skipping electron-rebuild (ARCHON_SKIP_ELECTRON_REBUILD=1). Run `npm run rebuild:electron` before Electron.",
  );
  process.exit(0);
}

const r = spawnSync("npx", ["electron-rebuild", "-f"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
process.exit(r.status === 0 ? 0 : (r.status ?? 1));
