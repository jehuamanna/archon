#!/usr/bin/env node
// One-shot: for each canonical skills/<name>/SKILL.md on disk, regenerate the
// non-symlink provider targets (cursor, copilot, windsurf, opencode). Symlink
// targets (.claude/skills, .agents/skills) auto-reflect canonical, so they're
// skipped. Call this after the canonical files are updated.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/niveus/srv/archon";
const SKILLS_DIR = join(REPO, "skills");

function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: raw };
  const fm = raw.slice(4, end);
  const afterCloser = raw.indexOf("\n", end + 4);
  const body = afterCloser === -1 ? "" : raw.slice(afterCloser + 1);
  const meta = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body };
}

function stripFrontmatter(body) {
  if (!body.startsWith("---\n")) return body;
  const end = body.indexOf("\n---", 4);
  if (end === -1) return body;
  const afterCloser = body.indexOf("\n", end + 4);
  return afterCloser === -1 ? "" : body.slice(afterCloser + 1).replace(/^\n+/, "");
}

const yamlStr = (s) => JSON.stringify(s);

function regenerate(name) {
  const canonical = join(SKILLS_DIR, name, "SKILL.md");
  const src = readFileSync(canonical, "utf8");
  const { meta } = parseFrontmatter(src);
  if (!meta.name || !meta.description) {
    throw new Error(`${name}: frontmatter missing name/description`);
  }
  const stripped = stripFrontmatter(src);

  // cursor → .cursor/rules/<name>.mdc
  const cursorDir = join(REPO, ".cursor", "rules");
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(
    join(cursorDir, `${name}.mdc`),
    [
      "---",
      `description: ${yamlStr(meta.description)}`,
      `globs: "**/*"`,
      `alwaysApply: false`,
      "---",
      "",
      stripped,
    ].join("\n"),
  );

  // windsurf → .windsurf/rules/<name>.md (verbatim)
  const wsDir = join(REPO, ".windsurf", "rules");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, `${name}.md`), src);

  // copilot → .github/instructions/<name>.instructions.md
  const coDir = join(REPO, ".github", "instructions");
  mkdirSync(coDir, { recursive: true });
  writeFileSync(
    join(coDir, `${name}.instructions.md`),
    [
      "---",
      `applyTo: "**/*"`,
      `description: ${yamlStr(meta.description)}`,
      "---",
      "",
      stripped,
    ].join("\n"),
  );

  // opencode → .opencode/agents/<name>.md (verbatim)
  const ocDir = join(REPO, ".opencode", "agents");
  mkdirSync(ocDir, { recursive: true });
  writeFileSync(join(ocDir, `${name}.md`), src);
}

function main() {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  let ok = 0;
  for (const name of dirs) {
    try {
      regenerate(name);
      console.log(`ok   ${name}`);
      ok++;
    } catch (e) {
      console.log(`FAIL ${name}: ${e.message || e}`);
    }
  }
  console.log(`\n${ok}/${dirs.length} regenerated`);
}

main();
