/**
 * Copy bundled plugin authoring markdown into the web app so sync-api routes can read it on Vercel.
 * Source: repo `docs/bundled-plugin-authoring`. Safe no-op if missing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const src = path.join(repoRoot, "docs", "bundled-plugin-authoring");
const dest = path.join(webRoot, "bundled-plugin-authoring");

if (!fs.existsSync(src)) {
  process.stderr.write(
    `[copy-bundled-docs] Skip: missing source ${src}\n`,
  );
  process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
process.stderr.write(`[copy-bundled-docs] Copied → ${dest}\n`);
