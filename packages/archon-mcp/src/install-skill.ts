// Install a SKILL.md extracted from an Archon note into the local repo.
//
// Writes the canonical source at <repo>/skills/<name>/SKILL.md, then fans out
// to each AI-provider target with the right format / frontmatter.
//
// Providers:
//   claude      — .claude/skills/<name>/            (symlink → ../../skills/<name>/ ; copy on Windows)
//   cursor      — .cursor/rules/<name>.mdc          (Cursor frontmatter: description / globs / alwaysApply)
//   windsurf    — .windsurf/rules/<name>.md         (verbatim source)
//   copilot     — .github/instructions/<name>.instructions.md  (Copilot frontmatter: applyTo / description)
//   antigravity — .agents/skills/<name>/            (symlink — same format as Claude)
//   opencode    — .opencode/agents/<name>.md        (verbatim source)
//   pi          — skipped (Pi reads canonical + AGENTS.md natively)
//   codex       — skipped (OpenAI Codex reads AGENTS.md natively — no dot-dir)
//
// AGENTS.md at repo root is written by writeAgentsMd() as a post-loop step by
// the caller, so Codex / Antigravity / opencode / Pi / Copilot coding agent
// all know the skills exist.
//
// Zero runtime deps; stdlib only.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type Provider =
  | "claude"
  | "cursor"
  | "windsurf"
  | "copilot"
  | "antigravity"
  | "opencode"
  | "pi"
  | "codex";

export const ALL_PROVIDERS: Provider[] = [
  "claude",
  "cursor",
  "windsurf",
  "copilot",
  "antigravity",
  "opencode",
  "pi",
  "codex",
];

export type InstallWrite = {
  provider: Provider;
  path: string;
  mode: "symlink" | "copy" | "generate";
};

export type InstallSkip = {
  provider: Provider;
  reason: string;
};

export type InstallSkillReport = {
  skillName: string;
  description: string;
  canonicalPath: string;
  wrote: InstallWrite[];
  skipped: InstallSkip[];
};

export type InstallSkillOptions = {
  /** Raw `content` field from an Archon note — may be a wrapped ` ```markdown ` fence or raw SKILL.md. */
  noteContent: string;
  /** Repo root where skills/, .claude/, .cursor/, .windsurf/, .github/, .agents/, .opencode/ live. */
  repoPath: string;
  /** Subset of providers. Default: all 7. */
  providers?: Provider[];
};

const IS_WINDOWS = process.platform === "win32";

/** Extract `{ name, description, body }` from note content. Handles two cases:
 *  (a) content is raw SKILL.md starting with `---\nname: …`,
 *  (b) content is a wrapped note whose first ` ```markdown ` fence contains the SKILL.md.
 */
export function extractSkillFromNoteContent(noteContent: string): {
  name: string;
  description: string;
  body: string;
} {
  // Case (a): raw SKILL.md
  if (noteContent.startsWith("---\n")) {
    const parsed = parseFrontmatter(noteContent);
    if (parsed.meta.name && parsed.meta.description) {
      return {
        name: parsed.meta.name,
        description: parsed.meta.description,
        body: noteContent,
      };
    }
  }

  // Case (b): find the first fenced markdown block whose inner content starts with a frontmatter block.
  // The opening fence may be ≥3 backticks; the closing fence must be exactly the same count
  // (so a SKILL body wrapped in 4 backticks can safely nest 3-backtick code blocks inside).
  const fenceRe = /(`{3,})markdown\n([\s\S]*?)\n\1(?!`)/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(noteContent)) !== null) {
    const inner = m[2];
    if (!inner.startsWith("---\n")) continue;
    const parsed = parseFrontmatter(inner);
    if (parsed.meta.name && parsed.meta.description) {
      return {
        name: parsed.meta.name,
        description: parsed.meta.description,
        body: inner,
      };
    }
  }

  throw new Error(
    "install-skill: note content does not contain a SKILL.md block with both 'name' and 'description' in its frontmatter",
  );
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: raw };
  const fmBlock = raw.slice(4, end);
  const afterCloser = raw.indexOf("\n", end + 4);
  const body = afterCloser === -1 ? "" : raw.slice(afterCloser + 1);
  const meta: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim();
  }
  return { meta, body };
}

/** Strip the leading `---\n…\n---\n` frontmatter off a SKILL.md body.
 *  Used for providers that reject the source frontmatter (Cursor, Copilot). */
function stripFrontmatter(body: string): string {
  if (!body.startsWith("---\n")) return body;
  const end = body.indexOf("\n---", 4);
  if (end === -1) return body;
  const afterCloser = body.indexOf("\n", end + 4);
  return afterCloser === -1 ? "" : body.slice(afterCloser + 1).replace(/^\n+/, "");
}

/** YAML-safe string: always JSON-quote. YAML is a JSON superset for flow scalars. */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function rmIfExists(path: string): void {
  try {
    lstatSync(path);
    rmSync(path, { recursive: true, force: true });
  } catch {
    // not there; nothing to do
  }
}

function writeDirTarget(
  repo: string,
  relDirPath: string[],
  skillName: string,
  canonicalDir: string,
): InstallWrite {
  const dstParent = join(repo, ...relDirPath);
  const dst = join(dstParent, skillName);
  ensureDir(dstParent);
  rmIfExists(dst);
  if (IS_WINDOWS) {
    cpSync(canonicalDir, dst, { recursive: true });
    return { provider: "claude" as Provider, path: dst, mode: "copy" };
  }
  const relSrc = relative(dirname(dst), canonicalDir);
  symlinkSync(relSrc, dst, "dir");
  return { provider: "claude" as Provider, path: dst, mode: "symlink" };
}

export function installSkill(opts: InstallSkillOptions): InstallSkillReport {
  const { name, description, body } = extractSkillFromNoteContent(opts.noteContent);
  const repo = resolve(opts.repoPath);
  const providers = opts.providers ?? ALL_PROVIDERS;

  // 1. Canonical source — always written, regardless of which providers are selected.
  const canonicalDir = join(repo, "skills", name);
  const canonicalPath = join(canonicalDir, "SKILL.md");
  ensureDir(canonicalDir);
  writeFileSync(canonicalPath, body);

  const wrote: InstallWrite[] = [];
  const skipped: InstallSkip[] = [];

  for (const provider of providers) {
    switch (provider) {
      case "claude": {
        const w = writeDirTarget(repo, [".claude", "skills"], name, canonicalDir);
        wrote.push({ ...w, provider: "claude" });
        break;
      }
      case "antigravity": {
        const w = writeDirTarget(repo, [".agents", "skills"], name, canonicalDir);
        wrote.push({ ...w, provider: "antigravity" });
        break;
      }
      case "cursor": {
        const dstDir = join(repo, ".cursor", "rules");
        ensureDir(dstDir);
        const dst = join(dstDir, `${name}.mdc`);
        const out = [
          "---",
          `description: ${yamlStr(description)}`,
          `globs: "**/*"`,
          `alwaysApply: false`,
          "---",
          "",
          stripFrontmatter(body),
        ].join("\n");
        writeFileSync(dst, out);
        wrote.push({ provider, path: dst, mode: "generate" });
        break;
      }
      case "windsurf": {
        const dstDir = join(repo, ".windsurf", "rules");
        ensureDir(dstDir);
        const dst = join(dstDir, `${name}.md`);
        writeFileSync(dst, body);
        wrote.push({ provider, path: dst, mode: "copy" });
        break;
      }
      case "copilot": {
        const dstDir = join(repo, ".github", "instructions");
        ensureDir(dstDir);
        const dst = join(dstDir, `${name}.instructions.md`);
        const out = [
          "---",
          `applyTo: "**/*"`,
          `description: ${yamlStr(description)}`,
          "---",
          "",
          stripFrontmatter(body),
        ].join("\n");
        writeFileSync(dst, out);
        wrote.push({ provider, path: dst, mode: "generate" });
        break;
      }
      case "opencode": {
        const dstDir = join(repo, ".opencode", "agents");
        ensureDir(dstDir);
        const dst = join(dstDir, `${name}.md`);
        writeFileSync(dst, body);
        wrote.push({ provider, path: dst, mode: "copy" });
        break;
      }
      case "pi": {
        skipped.push({
          provider,
          reason:
            "Pi reads the canonical skills/<name>/SKILL.md and repo-root AGENTS.md natively — no per-provider install needed",
        });
        break;
      }
      case "codex": {
        skipped.push({
          provider,
          reason:
            "Codex reads the repo-root AGENTS.md natively — no dot-directory needed. Covered by writeAgentsMd().",
        });
        break;
      }
    }
  }

  return {
    skillName: name,
    description,
    canonicalPath: relative(repo, canonicalPath),
    wrote: wrote.map((w) => ({ ...w, path: relative(repo, w.path) })),
    skipped,
  };
}

/** Marker pair used to delimit the Archon-managed block inside AGENTS.md.
 *  HTML comments so every markdown renderer hides them. */
const AGENTS_MD_BEGIN = "<!-- archon:skills:begin -->";
const AGENTS_MD_END = "<!-- archon:skills:end -->";

export type AgentsMdEntry = {
  name: string;
  description: string;
};

export type AgentsMdWriteReport = {
  path: string;
  action: "created" | "block-replaced" | "block-appended" | "unchanged";
};

/** Render the marker-bracketed Archon block. The content between the markers is
 *  what future runs replace; everything outside stays exactly as the user wrote it. */
function renderAgentsMdBlock(skills: AgentsMdEntry[]): string {
  const rows = skills
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `| \`${s.name}\` | ${s.description.replace(/\|/g, "\\|")} |`)
    .join("\n");
  const table = rows.length > 0
    ? `| Skill | When to invoke |\n|---|---|\n${rows}`
    : "_No skills installed yet._";
  return [
    AGENTS_MD_BEGIN,
    "",
    "## Archon skills",
    "",
    "Canonical source: `skills/<name>/SKILL.md`. Each skill below is discoverable",
    "by every AGENTS.md-aware agent (Codex, Antigravity, opencode, Pi, Copilot).",
    "Tools with dot-directory support (Claude, Cursor, Windsurf, Copilot,",
    "Antigravity, opencode) also get their own provider-specific file layout.",
    "",
    "**Edit rule:** change `skills/<name>/SKILL.md` only. Re-run `archon_install_skill`",
    "(or `npm run sync-skills` if your repo is Node-based) to regenerate the provider",
    "dot-directories and this table. Do not hand-edit anything inside the marker block.",
    "",
    table,
    "",
    AGENTS_MD_END,
  ].join("\n");
}

/** Template used when AGENTS.md does not yet exist. Deliberately minimal — the
 *  user may expand it later; we only own the marker block. */
function renderAgentsMdTemplate(skills: AgentsMdEntry[]): string {
  return [
    "# AGENTS.md",
    "",
    "Standing instructions for AI coding agents (Claude, Cursor, Windsurf,",
    "Copilot, Antigravity, opencode, Pi, Codex, etc.) working in this repo.",
    "",
    renderAgentsMdBlock(skills),
    "",
  ].join("\n");
}

/** Write or update the Archon-managed block inside `<repoPath>/AGENTS.md`.
 *
 *  - File absent → create from template seeded with the skill list.
 *  - File present with markers → replace the block between markers.
 *  - File present without markers → append a new marker-bracketed block at EOF.
 *
 *  Idempotent: writing with the same inputs twice produces no disk delta the
 *  second time (the content hash matches; we skip the write).
 */
export function writeAgentsMd(
  repoPath: string,
  skills: AgentsMdEntry[],
): AgentsMdWriteReport {
  const repo = resolve(repoPath);
  const path = join(repo, "AGENTS.md");
  const desired = renderAgentsMdBlock(skills);

  if (!existsSync(path)) {
    writeFileSync(path, renderAgentsMdTemplate(skills));
    return { path: relative(repo, path), action: "created" };
  }

  const current = readFileSync(path, "utf8");
  const begin = current.indexOf(AGENTS_MD_BEGIN);
  const end = current.indexOf(AGENTS_MD_END);

  if (begin !== -1 && end !== -1 && end > begin) {
    const before = current.slice(0, begin);
    const afterStart = end + AGENTS_MD_END.length;
    const after = current.slice(afterStart);
    const next = `${before}${desired}${after}`;
    if (next === current) {
      return { path: relative(repo, path), action: "unchanged" };
    }
    writeFileSync(path, next);
    return { path: relative(repo, path), action: "block-replaced" };
  }

  // No markers — append a fresh block at EOF, preserving existing content.
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  const next = `${current}${sep}${desired}\n`;
  writeFileSync(path, next);
  return { path: relative(repo, path), action: "block-appended" };
}
