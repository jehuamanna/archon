/**
 * AI-facing system-prompt fragment for generating Archon MDX. Derived from
 * `PROP_SPECS` so this stays in lockstep with the runtime contract — when a
 * component prop changes, the prompt regenerates automatically.
 *
 * Embed this string in the system prompt of an LLM call (Claude, GPT, …)
 * before asking it to author MDX, or serve it from
 * `GET /api/v1/mdx-sdk/spec`.
 */
import { PROP_SPECS, type PropSpec } from "./prop-specs.js";
import {
  ALLOWED_FACADE_IMPORTS,
  LOCAL_KEY_PREFIX,
  STATE_KEY_RE,
  STATE_LIMITS,
} from "./validation.js";

function describeProp(name: string, spec: PropSpec): string {
  const parts: string[] = [name];
  if (spec.required) parts.push("(required)");
  parts.push(`— type=${spec.type}`);
  if (spec.enum) parts.push(`enum={${spec.enum.join("|")}}`);
  if (spec.default !== undefined) parts.push(`default=${JSON.stringify(spec.default)}`);
  if (spec.semantic) parts.push(`— ${spec.semantic}`);
  return `    - ${parts.join(" ")}`;
}

export function buildArchonMdxSystemPrompt(sdkVersion: string): string {
  const lines: string[] = [
    `# Archon MDX authoring (sdk v${sdkVersion})`,
    "",
    "You are generating MDX for an Archon mini-app note. The renderer is strict.",
    "Follow these rules; the host will reject MDX that violates any of them.",
    "",
    "## Imports",
    "",
    `Only these specifiers are allowed: ${ALLOWED_FACADE_IMPORTS.map((s) => "`" + s + "`").join(", ")}.`,
    "Imports are stripped at compile time — components resolve through a host-provided",
    "MDXProvider map. Authors still write `import { … } from \"@archon/mdx-sdk\";` so",
    "the symbols are visibly declared and the renderer's import-validator passes.",
    "",
    "Do NOT use:",
    "- `export …` (any kind — mini-app notes have no public symbols)",
    "- `import \"…\"` (side-effect-only imports)",
    "- `import('…')` (dynamic imports — sandbox escape)",
    "- Imports from any specifier outside the allow-list",
    "",
    "## State keys",
    "",
    "Several props (typed `stateKey` below) are NOT React values — they are",
    "**string identifiers** naming a server-stored state slot. Two components",
    "wired to the same key share the same value across tabs and reloads.",
    "",
    `- Must match the regex \`${STATE_KEY_RE.source}\``,
    `- Max ${STATE_LIMITS.KEY_MAX_BYTES} bytes per key name`,
    `- Max ${STATE_LIMITS.MAX_KEYS_PER_PROJECT} keys per project`,
    `- Max ${STATE_LIMITS.VALUE_MAX_BYTES} bytes per stored value (server returns 413 above)`,
    `- Keys starting with \`${LOCAL_KEY_PREFIX}\` are **local-only** — never persisted to the server.`,
    "  Use these for transient drafts (e.g. the input field of a PushButton flow).",
    "",
    "Choose unique, descriptive keys per note (e.g. `inbox_todos`, `weekly_score`).",
    "Avoid generic names that may collide with other notes in the project (`x`, `value`, `data`).",
    "",
    "## Available components",
    "",
  ];

  for (const [tag, spec] of Object.entries(PROP_SPECS)) {
    lines.push(`### \`<${tag}>\``);
    lines.push("Props:");
    for (const [name, propSpec] of Object.entries(spec)) {
      lines.push(describeProp(name, propSpec));
    }
    lines.push("");
  }

  lines.push("## Output format");
  lines.push("");
  lines.push("Return ONLY valid MDX, no surrounding prose or fences.");
  lines.push("Begin with the import line declaring every component you use, e.g.:");
  lines.push("");
  lines.push("```mdx");
  lines.push('import { Input, PushButton, List } from "@archon/mdx-sdk";');
  lines.push("");
  lines.push("## My todo list");
  lines.push("");
  lines.push('<Input value="todo_draft" onChange="todo_draft" placeholder="Add a task…" />');
  lines.push('<PushButton label="Add" fromKey="todo_draft" toKey="todos" clearFrom="true" />');
  lines.push('<List stateKey="todos" item="- {.}" />');
  lines.push("```");

  return lines.join("\n");
}
