"use strict";

const { spawnSync } = require("node:child_process");

/** Fast path for web + sync-api: skip root postinstall `electron-rebuild`. */
process.env.ARCHON_SKIP_ELECTRON_REBUILD = "1";

const useCi = process.argv[2] === "ci";
const npmArgs = useCi
  ? ["ci", ...process.argv.slice(3)]
  : ["install", ...process.argv.slice(2)];

const r = spawnSync("npm", npmArgs, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
process.exit(r.status === 0 ? 0 : (r.status ?? 1));
