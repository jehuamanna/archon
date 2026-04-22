#!/usr/bin/env node
/**
 * Runs `npm install` in each immediate child of `plugins/core` that has a package.json.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const coreRoot = path.join(repoRoot, "plugins", "core");

if (!fs.existsSync(coreRoot)) {
  console.warn("[core:npm-install] plugins/core not found, skipping.");
  process.exit(0);
}

const entries = fs.readdirSync(coreRoot, { withFileTypes: true });
let ran = 0;
for (const ent of entries) {
  if (!ent.isDirectory() || ent.name.startsWith(".")) {
    continue;
  }
  const dir = path.join(coreRoot, ent.name);
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    continue;
  }
  const rel = path.relative(repoRoot, dir);
  console.log(`[core:npm-install] npm install in ${rel}`);
  execSync("npm install", { cwd: dir, stdio: "inherit", env: process.env });
  ran += 1;
}

if (ran === 0) {
  console.log("[core:npm-install] No package.json under plugins/core/*, nothing to do.");
}
