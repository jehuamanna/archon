#!/usr/bin/env node
/**
 * Copy pdf.js worker into the Next app `public/` folder (same relative URL plugins expect).
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pdfPkgRoot = path.dirname(
  require.resolve("pdfjs-dist/package.json", { paths: [root] }),
);
const from = path.join(pdfPkgRoot, "build", "pdf.worker.min.mjs");
const toDir = path.join(root, "apps", "archon-web", "public");
const to = path.join(toDir, "pdf.worker.min.mjs");

if (!fs.existsSync(from)) {
  console.warn("[archon-web] pdf.worker.min.mjs not found at", from);
  process.exit(0);
}
fs.mkdirSync(toDir, { recursive: true });
fs.copyFileSync(from, to);
console.info("[archon-web] synced pdf.worker.min.mjs →", to);
