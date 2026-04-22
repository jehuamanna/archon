#!/usr/bin/env node
/**
 * After packaging, copy Next static export (`apps/archon-web/out`) next to `app.asar` under `resources/archon-web/`.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function copyArchonWebUi(buildPath) {
  const webOut = path.join(root, "apps", "archon-web", "out");
  if (!fs.existsSync(webOut)) {
    console.warn(
      "[forge] apps/archon-web/out missing — run `npm run build:web:static` before `electron-forge package`",
    );
    return;
  }
  const resourcesDir = path.resolve(buildPath, "..");
  if (!fs.existsSync(resourcesDir)) {
    console.warn("[forge] no resources directory at", resourcesDir);
    return;
  }
  const dest = path.join(resourcesDir, "archon-web");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(webOut, dest, { recursive: true });
  console.info("[forge] copied Next static UI to", dest);
}

module.exports = { copyArchonWebUi };
