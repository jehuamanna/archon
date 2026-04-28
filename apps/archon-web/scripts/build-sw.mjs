/**
 * Stamps the current git short SHA into `public/sw.js` from
 * `public/sw.template.js` at build time. Each deploy then ships a unique
 * SW byte sequence — without that, browsers can't detect that there's a
 * new app version to offer, and the in-app "Reload to update" banner
 * never fires.
 *
 * Outside a git checkout (e.g. published tarballs) we fall back to a
 * timestamp so the SW still differs across deploys.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const templatePath = path.join(publicDir, "sw.template.js");
const outPath = path.join(publicDir, "sw.js");

function resolveBuildId() {
  if (process.env.ARCHON_SW_BUILD_ID?.trim()) {
    return process.env.ARCHON_SW_BUILD_ID.trim();
  }
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return `nogit-${Date.now()}`;
  }
}

const buildId = resolveBuildId();
const template = readFileSync(templatePath, "utf8");
const stamped = template.replace(/__ARCHON_BUILD_ID__/g, buildId);
writeFileSync(outPath, stamped);
// eslint-disable-next-line no-console
console.log(`[archon-web/sw] wrote public/sw.js with BUILD_ID=${buildId}`);
