#!/usr/bin/env node
// Fan out <repo>/skills/<name>/SKILL.md into tool-specific folders.
//   Claude Code:      .claude/skills/<name>/          (symlink → skills/<name>/)
//   Cursor:           .cursor/rules/<name>.mdc        (rewritten frontmatter)
//   Windsurf:         .windsurf/rules/<name>.md       (verbatim)
//   GitHub Copilot:   .github/instructions/<name>.instructions.md  (rewritten)
//   Antigravity:      .agents/skills/<name>/          (symlink — same as Claude)
//   opencode:         .opencode/agents/<name>.md      (verbatim)
//   Pi:               no-op — reads skills/<name>/SKILL.md directly
//
// Usage:
//   node scripts/sync-skills.mjs [--clean]
//
// --clean removes stale files in each target dir whose source skill is gone.
// Runs are idempotent. Zero runtime deps.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, cpSync, lstatSync, existsSync, readlinkSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SRC_DIR = join(REPO_ROOT, "skills");

const TARGETS = {
  claude:      { dir: join(REPO_ROOT, ".claude", "skills") },
  cursor:      { dir: join(REPO_ROOT, ".cursor", "rules") },
  windsurf:    { dir: join(REPO_ROOT, ".windsurf", "rules") },
  copilot:     { dir: join(REPO_ROOT, ".github", "instructions") },
  antigravity: { dir: join(REPO_ROOT, ".agents", "skills") },
  opencode:    { dir: join(REPO_ROOT, ".opencode", "agents") },
};

const IS_WINDOWS = process.platform === "win32";
const FLAGS = new Set(process.argv.slice(2));
const CLEAN = FLAGS.has("--clean");

/** Parse a SKILL.md file into { name, description, body }. Body excludes frontmatter. */
function parseSkill(path) {
  const raw = readFileSync(path, "utf8");
  if (!raw.startsWith("---\n")) {
    throw new Error(`${path}: missing --- frontmatter opener`);
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error(`${path}: missing --- frontmatter closer`);
  }
  const fmBlock = raw.slice(4, end);
  const afterCloser = raw.indexOf("\n", end + 4);
  const body = afterCloser === -1 ? "" : raw.slice(afterCloser + 1);

  const meta = {};
  for (const line of fmBlock.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  if (!meta.name || !meta.description) {
    throw new Error(`${path}: frontmatter must define both 'name' and 'description'`);
  }
  return { meta, body };
}

/** YAML-safe single-line string: always JSON-quote (YAML is a JSON superset for flow scalars). */
function yamlStr(s) {
  return JSON.stringify(s);
}

/** Ensure `dir` exists. */
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/** Remove a file or dir/symlink if it exists. */
function rmIfExists(path) {
  if (!existsSync(path) && !isSymlinkSafe(path)) return;
  rmSync(path, { recursive: true, force: true });
}

/** lstat-safe existence check that returns true for broken symlinks too. */
function isSymlinkSafe(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** List skill names = direct subdirs of SRC_DIR that contain SKILL.md. */
function listSkills() {
  if (!existsSync(SRC_DIR)) return [];
  const out = [];
  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(SRC_DIR, entry.name, "SKILL.md");
    if (existsSync(skillFile)) out.push(entry.name);
  }
  return out.sort();
}

/** Generic dir-symlink target (Claude, Antigravity). Windows falls back to copy. */
function writeDirSymlinkTarget(skillName, targetDir) {
  const src = join(SRC_DIR, skillName);
  const dst = join(targetDir, skillName);
  ensureDir(targetDir);

  if (isSymlinkSafe(dst)) rmSync(dst, { recursive: true, force: true });

  if (IS_WINDOWS) {
    cpSync(src, dst, { recursive: true });
  } else {
    // Relative symlink so the repo stays portable when moved.
    const relSrc = relative(dirname(dst), src);
    symlinkSync(relSrc, dst, "dir");
  }
}

function writeClaudeTarget(skillName) {
  writeDirSymlinkTarget(skillName, TARGETS.claude.dir);
}

function writeAntigravityTarget(skillName) {
  writeDirSymlinkTarget(skillName, TARGETS.antigravity.dir);
}

/** opencode: copy the verbatim SKILL.md contents to .opencode/agents/<name>.md. */
function writeOpencodeTarget(skillName, skill, srcPath) {
  ensureDir(TARGETS.opencode.dir);
  const raw = readFileSync(srcPath, "utf8");
  writeFileSync(join(TARGETS.opencode.dir, `${skillName}.md`), raw);
}

/** Cursor — .mdc with Cursor's own frontmatter. */
function writeCursorTarget(skillName, skill) {
  ensureDir(TARGETS.cursor.dir);
  const out = [
    "---",
    `description: ${yamlStr(skill.meta.description)}`,
    `globs: "**/*"`,
    `alwaysApply: false`,
    "---",
    "",
    skill.body.trimStart(),
  ].join("\n");
  writeFileSync(join(TARGETS.cursor.dir, `${skillName}.mdc`), out);
}

/** Windsurf — copy frontmatter verbatim, rename file only. */
function writeWindsurfTarget(skillName, skill, srcPath) {
  ensureDir(TARGETS.windsurf.dir);
  // Windsurf tolerates extra frontmatter keys; keep source as-is.
  const raw = readFileSync(srcPath, "utf8");
  writeFileSync(join(TARGETS.windsurf.dir, `${skillName}.md`), raw);
}

/** Copilot — .instructions.md with applyTo + description frontmatter. */
function writeCopilotTarget(skillName, skill) {
  ensureDir(TARGETS.copilot.dir);
  const out = [
    "---",
    `applyTo: "**/*"`,
    `description: ${yamlStr(skill.meta.description)}`,
    "---",
    "",
    skill.body.trimStart(),
  ].join("\n");
  writeFileSync(join(TARGETS.copilot.dir, `${skillName}.instructions.md`), out);
}

function clean(skillNames) {
  const keep = new Set(skillNames);
  const cleanDir = (dir, matcher) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const m = matcher(entry);
      if (!m) continue;
      if (keep.has(m)) continue;
      rmIfExists(join(dir, entry.name));
      console.log(`  - removed stale ${join(dir, entry.name)}`);
    }
  };
  // Claude: subdir per skill
  cleanDir(TARGETS.claude.dir, (e) => (e.isDirectory() || e.isSymbolicLink() ? e.name : null));
  // Cursor: <name>.mdc
  cleanDir(TARGETS.cursor.dir, (e) => {
    if (!e.isFile()) return null;
    return e.name.endsWith(".mdc") ? e.name.slice(0, -4) : null;
  });
  // Windsurf: <name>.md
  cleanDir(TARGETS.windsurf.dir, (e) => {
    if (!e.isFile()) return null;
    return e.name.endsWith(".md") ? e.name.slice(0, -3) : null;
  });
  // Copilot: <name>.instructions.md
  cleanDir(TARGETS.copilot.dir, (e) => {
    if (!e.isFile()) return null;
    return e.name.endsWith(".instructions.md") ? e.name.slice(0, -".instructions.md".length) : null;
  });
  // Antigravity: subdir per skill (same as Claude)
  cleanDir(TARGETS.antigravity.dir, (e) =>
    e.isDirectory() || e.isSymbolicLink() ? e.name : null,
  );
  // opencode: <name>.md
  cleanDir(TARGETS.opencode.dir, (e) => {
    if (!e.isFile()) return null;
    return e.name.endsWith(".md") ? e.name.slice(0, -3) : null;
  });
}

function main() {
  const skills = listSkills();
  if (skills.length === 0) {
    console.error(`No skills found under ${SRC_DIR}. Did you copy them in yet?`);
    process.exit(1);
  }

  console.log(`sync-skills: ${skills.length} skill(s) from ${relative(REPO_ROOT, SRC_DIR)}/`);
  for (const name of skills) {
    const srcFile = join(SRC_DIR, name, "SKILL.md");
    const skill = parseSkill(srcFile);
    writeClaudeTarget(name);
    writeCursorTarget(name, skill);
    writeWindsurfTarget(name, skill, srcFile);
    writeCopilotTarget(name, skill);
    writeAntigravityTarget(name);
    writeOpencodeTarget(name, skill, srcFile);
    console.log(`  ✓ ${name}`);
  }

  if (CLEAN) {
    console.log("sync-skills: --clean removing stale target files");
    clean(skills);
  }

  console.log(`sync-skills: done`);
  console.log(`  claude      → ${relative(REPO_ROOT, TARGETS.claude.dir)}/`);
  console.log(`  cursor      → ${relative(REPO_ROOT, TARGETS.cursor.dir)}/`);
  console.log(`  windsurf    → ${relative(REPO_ROOT, TARGETS.windsurf.dir)}/`);
  console.log(`  copilot     → ${relative(REPO_ROOT, TARGETS.copilot.dir)}/`);
  console.log(`  antigravity → ${relative(REPO_ROOT, TARGETS.antigravity.dir)}/`);
  console.log(`  opencode    → ${relative(REPO_ROOT, TARGETS.opencode.dir)}/`);
  console.log(`  pi          → reads ${relative(REPO_ROOT, SRC_DIR)}/ directly (no fan-out)`);
}

main();
