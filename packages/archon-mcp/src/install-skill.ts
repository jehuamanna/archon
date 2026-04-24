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
//
// Zero runtime deps; stdlib only.

import {
  cpSync,
  lstatSync,
  mkdirSync,
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
  | "pi";

export const ALL_PROVIDERS: Provider[] = [
  "claude",
  "cursor",
  "windsurf",
  "copilot",
  "antigravity",
  "opencode",
  "pi",
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
