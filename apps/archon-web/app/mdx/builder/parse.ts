import {
  EDITABLE_TAGS,
  newNodeId,
  type AdvancedNode,
  type BuilderDoc,
  type BuilderNode,
  type EditableNode,
  type ImportDecl,
  type MarkdownNode,
} from "./ast.js";

/**
 * Low-rigor MDX → BuilderDoc parser.
 *
 * Design: We scan top-to-bottom, extracting the import block, then splitting
 * the body into JSX blocks and markdown regions. JSX blocks that match a
 * known SDK component with simple literal props become EditableNodes;
 * everything else (expressions, nested children the builder can't classify,
 * unknown tags) becomes an AdvancedNode that preserves the original source
 * byte-for-byte. If any stage fails, the whole doc goes `rawFallback` and
 * the builder renders read-only.
 *
 * This is intentionally strict on round-trip: the serializer only rewrites
 * what this parser marks editable; every other byte survives unchanged.
 */
export function parseMdxToBuilderDoc(source: string): BuilderDoc {
  try {
    const { imports, remainingSource } = extractImports(source);
    const body = splitIntoNodes(remainingSource);
    return { imports, body };
  } catch (err) {
    return {
      imports: { kind: "import", names: [] },
      body: [],
      rawFallback: source,
      parseError: (err as Error).message,
    };
  }
}

const IMPORT_LINE_RE =
  /^\s*import\s*\{\s*([^}]+)\s*\}\s*from\s*["']@archon\/mdx-sdk["'];?\s*\n?/m;

function extractImports(source: string): {
  imports: ImportDecl;
  remainingSource: string;
} {
  const match = source.match(IMPORT_LINE_RE);
  if (!match) {
    return { imports: { kind: "import", names: [] }, remainingSource: source };
  }
  const names = match[1]
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim())
    .filter((s): s is string => !!s);
  const remainingSource = source.replace(IMPORT_LINE_RE, "");
  return { imports: { kind: "import", names }, remainingSource };
}

/**
 * Split the body into markdown / editable / advanced chunks.
 *
 * Heuristic JSX detection:
 *   - A line starting with `<Tag[ />` where `Tag` is in EDITABLE_TAGS and
 *     the element ends on the same line or closes with `/>` / `</Tag>`
 *     cleanly, is a candidate editable node.
 *   - Any `<`-starting JSX block the heuristic can't simplify becomes
 *     advanced, preserved verbatim including whitespace.
 *   - Runs of plain text become MarkdownNodes.
 */
function splitIntoNodes(src: string): BuilderNode[] {
  const nodes: BuilderNode[] = [];
  let i = 0;
  const len = src.length;
  let buffer = "";

  const flushMarkdown = (): void => {
    if (buffer.length > 0) {
      nodes.push({
        kind: "markdown",
        id: newNodeId("md"),
        source: buffer,
      });
      buffer = "";
    }
  };

  while (i < len) {
    const ch = src[i];
    if (ch === "<") {
      // Look ahead for a JSX element we can handle.
      const end = findJsxElementEnd(src, i);
      if (end === null) {
        buffer += ch;
        i += 1;
        continue;
      }
      const block = src.slice(i, end);
      const editable = tryParseEditable(block);
      flushMarkdown();
      if (editable) {
        nodes.push(editable);
      } else {
        const preview = block.replace(/\s+/g, " ").slice(0, 80);
        nodes.push({
          kind: "advanced",
          id: newNodeId("adv"),
          source: block,
          preview,
        } satisfies AdvancedNode);
      }
      i = end;
      continue;
    }
    if (ch === "{") {
      // Inline expression — always advanced.
      const end = findBalanced(src, i, "{", "}");
      if (end === null) {
        buffer += ch;
        i += 1;
        continue;
      }
      const block = src.slice(i, end);
      flushMarkdown();
      const preview = block.replace(/\s+/g, " ").slice(0, 80);
      nodes.push({
        kind: "advanced",
        id: newNodeId("expr"),
        source: block,
        preview,
      });
      i = end;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flushMarkdown();
  return nodes;
}

function findJsxElementEnd(src: string, start: number): number | null {
  // Self-closing or open+close tag. We're forgiving — we accept whatever
  // is between the `<` and a matching top-level `/>` or `</Tag>`.
  const m = src.slice(start).match(/^<\s*([A-Za-z][A-Za-z0-9]*)/);
  if (!m) return null;
  const tag = m[1];
  // Self-closing search.
  let depth = 0;
  let i = start;
  while (i < src.length) {
    if (src[i] === "<") {
      const selfClose = src.slice(i).match(/^<\s*[A-Za-z][A-Za-z0-9]*[^<>]*\/>/);
      if (selfClose && depth === 0 && i === start) {
        return i + selfClose[0].length;
      }
      const openMatch = src.slice(i).match(/^<\s*([A-Za-z][A-Za-z0-9]*)[^<>]*>/);
      const closeMatch = src.slice(i).match(/^<\s*\/\s*([A-Za-z][A-Za-z0-9]*)\s*>/);
      if (closeMatch && closeMatch[1] === tag) {
        depth -= 1;
        if (depth === 0) return i + closeMatch[0].length;
        i += closeMatch[0].length;
        continue;
      }
      if (openMatch && openMatch[1] === tag) {
        depth += 1;
        i += openMatch[0].length;
        continue;
      }
    }
    i += 1;
  }
  return null;
}

function findBalanced(
  src: string,
  start: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

const SELF_CLOSING_RE =
  /^<\s*([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_][A-Za-z0-9_-]*\s*(?:=\s*(?:"[^"]*"|'[^']*'|\{(?:true|false|\d+(?:\.\d+)?)\}))?)*)\s*\/>\s*$/;

function tryParseEditable(block: string): EditableNode | null {
  const m = block.match(SELF_CLOSING_RE);
  if (!m) return null;
  const tag = m[1];
  if (!EDITABLE_TAGS.has(tag)) return null;
  const props: EditableNode["props"] = {};
  const propsSrc = m[2] ?? "";
  const propRe =
    /\s+([A-Za-z_][A-Za-z0-9_-]*)(?:=\s*("[^"]*"|'[^']*'|\{(true|false|\d+(?:\.\d+)?)\}))?/g;
  let pm: RegExpExecArray | null;
  while ((pm = propRe.exec(propsSrc)) !== null) {
    const name = pm[1];
    const raw = pm[2];
    if (raw === undefined) {
      props[name] = true;
      continue;
    }
    if (raw.startsWith('"') || raw.startsWith("'")) {
      props[name] = raw.slice(1, -1);
      continue;
    }
    if (raw.startsWith("{")) {
      const inside = pm[3] ?? "";
      if (inside === "true") props[name] = true;
      else if (inside === "false") props[name] = false;
      else if (/^\d/.test(inside)) props[name] = Number(inside);
      else return null; // expression — treat whole block as advanced
    }
  }
  return {
    kind: "editable",
    id: newNodeId("edit"),
    component: tag,
    props,
  };
}
