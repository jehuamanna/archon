#!/usr/bin/env node
/**
 * Uninstalls any existing `archon` Debian package, then installs a .deb with `dpkg -i`
 * (and `apt-get install -f` if dependencies need resolving).
 * Multiple .deb files → interactive list (arrow keys + Enter). Linux only.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEB_PKG = "archon";
const ROOT = path.resolve(__dirname, "..");
const DEB_DIR = path.join(ROOT, "dist", "deb");

function run(cmd, args, inherit = true) {
  const r = spawnSync(cmd, args, {
    stdio: inherit ? "inherit" : "pipe",
    encoding: "utf8",
  });
  return r.status ?? 1;
}

async function main() {
  if (process.platform !== "linux") {
    console.error("install:linux only runs on Linux.");
    process.exit(1);
  }

  if (!fs.existsSync(DEB_DIR)) {
    console.error("Missing dist/deb — build a .deb first (e.g. npm run build:linux).");
    process.exit(1);
  }

  const debs = fs
    .readdirSync(DEB_DIR)
    .filter((f) => f.endsWith(".deb"))
    .sort();

  if (debs.length === 0) {
    console.error("No .deb files in dist/deb.");
    process.exit(1);
  }

  let choice;
  if (debs.length === 1) {
    choice = debs[0];
    console.log(`Using ${choice}`);
  } else {
    const prompts = require("prompts");
    const res = await prompts({
      type: "select",
      name: "deb",
      message: "Which release to install?",
      choices: debs.map((d) => ({ title: d, value: d })),
    });
    if (res.deb === undefined) {
      process.exit(1);
    }
    choice = res.deb;
  }

  const debPath = path.resolve(DEB_DIR, choice);

  /**
   * Stage in /tmp so paths under $HOME don’t hit permission quirks with some tools.
   */
  const stagedDeb = path.join(
    "/tmp",
    `archon-install-${process.pid}-${Date.now()}.deb`,
  );
  fs.copyFileSync(debPath, stagedDeb);
  fs.chmodSync(stagedDeb, 0o644);

  console.log("\nRemoving existing Archon package (if installed)…");
  run("sudo", ["apt-get", "remove", "-y", DEB_PKG]);
  /* apt-get remove exits 100 if package not installed — ignore */
  console.log("\nInstalling…");
  let code;
  try {
    code = run("sudo", ["dpkg", "-i", stagedDeb]);
    if (code !== 0) {
      console.log("\nResolving dependencies (if needed)…");
      code = run("sudo", ["apt-get", "install", "-f", "-y"]);
    }
  } finally {
    try {
      fs.unlinkSync(stagedDeb);
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
