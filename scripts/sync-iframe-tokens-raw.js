#!/usr/bin/env node
/**
 * Embeds `tokens.css` as a TS string for plugin iframe injection (Next.js has no stable ?raw CSS).
 */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "../src/renderer/styles/tokens.css");
const out = path.join(__dirname, "../src/renderer/styles/tokens-raw.generated.ts");
const body = fs.readFileSync(src, "utf8");
const escaped = body
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");
const header = `/**\n * AUTO-GENERATED from styles/tokens.css — do not edit.\n * Regenerate: node scripts/sync-iframe-tokens-raw.js\n */\n`;
fs.writeFileSync(out, `${header}export const TOKENS_CSS_FOR_IFRAME = \`${escaped}\`;\n`);
console.info("[archon] wrote", out);
