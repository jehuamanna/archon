import type { BuilderDoc, BuilderNode } from "./ast.js";

/**
 * Serialize a BuilderDoc back to human-readable MDX.
 *
 * - Imports line is rebuilt from `imports.names` (sorted, deterministic).
 * - Editable nodes become self-closing JSX with alphabetized props; strings
 *   quoted, numbers/booleans unquoted via `{…}`.
 * - Advanced and markdown nodes emit `source` verbatim.
 * - A single trailing newline.
 */
export function serializeBuilderDoc(doc: BuilderDoc): string {
  if (doc.rawFallback !== undefined) return doc.rawFallback;

  const lines: string[] = [];
  if (doc.imports.names.length > 0) {
    const sorted = Array.from(new Set(doc.imports.names)).sort();
    lines.push(
      `import { ${sorted.join(", ")} } from "@archon/mdx-sdk";`,
      "",
    );
  }
  const out = lines.join("\n") + doc.body.map(serializeNode).join("");
  return out.endsWith("\n") ? out : `${out}\n`;
}

function serializeNode(node: BuilderNode): string {
  switch (node.kind) {
    case "markdown":
      return node.source;
    case "advanced":
      return node.source;
    case "editable":
      return serializeEditable(node);
  }
}

function serializeEditable(node: Extract<BuilderNode, { kind: "editable" }>): string {
  const propsPart = serializeProps(node.props);
  return `<${node.component}${propsPart ? " " + propsPart : ""} />`;
}

function serializeProps(props: Record<string, string | number | boolean | null>): string {
  const keys = Object.keys(props).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = props[key];
    if (v === null || v === undefined) continue;
    if (v === true) {
      parts.push(key);
      continue;
    }
    if (v === false) {
      parts.push(`${key}={false}`);
      continue;
    }
    if (typeof v === "number") {
      parts.push(`${key}={${v}}`);
      continue;
    }
    if (typeof v === "string") {
      parts.push(`${key}=${JSON.stringify(v)}`);
      continue;
    }
  }
  return parts.join(" ");
}
