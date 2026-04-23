/**
 * Builder AST — "UI model" over MDX source.
 *
 * Two node kinds:
 *   - `editable` — JSX for a known `@archon/mdx-sdk` component with a PropSpec
 *     we understand. The inspector edits props; serializer rebuilds the tag.
 *   - `advanced` — everything else. Source text is preserved byte-for-byte and
 *     never re-synthesized.
 *
 * Top-level imports from `@archon/mdx-sdk` are always editable in a separate
 * "imports" region (auto-managed).
 */

export type NodeId = string;

export interface ImportDecl {
  kind: "import";
  /** Named specifiers imported from @archon/mdx-sdk. */
  names: string[];
}

export interface EditableNode {
  kind: "editable";
  id: NodeId;
  component: string; // "Input" | "Button" | …
  props: Record<string, string | number | boolean | null>;
  children?: BuilderNode[];
}

export interface AdvancedNode {
  kind: "advanced";
  id: NodeId;
  /** Raw MDX text preserved verbatim. */
  source: string;
  /** Displayed on the canvas as a greyed chip. */
  preview: string;
}

export interface MarkdownNode {
  kind: "markdown";
  id: NodeId;
  /** Raw markdown text between JSX blocks. */
  source: string;
}

export type BuilderNode = EditableNode | AdvancedNode | MarkdownNode;

export interface BuilderDoc {
  imports: ImportDecl;
  body: BuilderNode[];
  /** Original source if we failed to parse fully — builder goes read-only. */
  rawFallback?: string;
  /** Parse error, if any. */
  parseError?: string;
}

/** The set of component tags the builder knows how to edit. */
export const EDITABLE_TAGS = new Set<string>([
  "Input",
  "Select",
  "Checkbox",
  "Button",
  "Form",
  "List",
  "Table",
  "Chart",
  "NoteEmbed",
  "Markdown",
  "Value",
  "PushButton",
]);

let counter = 0;
export function newNodeId(prefix = "n"): NodeId {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}
