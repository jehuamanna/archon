#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = path.join(
  root,
  "node_modules",
  "video.js",
  "dist",
  "video-js.css",
);
const out = path.join(root, "src/shared/video-js-iframe-css.generated.ts");
if (!fs.existsSync(src)) {
  console.warn("[archon] video-js.css not found at", src);
  process.exit(0);
}
const body = fs.readFileSync(src, "utf8");
const escaped = body
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");
const header = `/**\n * AUTO-GENERATED from video.js/dist/video-js.css — do not edit.\n * Regenerate: node scripts/sync-video-js-iframe-css.js\n */\n`;
fs.writeFileSync(
  out,
  `${header}export const VIDEO_JS_IFRAME_CSS = \`${escaped}\`;\n`,
);
console.info("[archon] wrote", out);
