import type { Note } from "@archon/ui-types";

/** True when this note should be rendered with the MDX pipeline (vs plain react-markdown). */
export function shouldRenderMdx(note: Note): boolean {
  if (note.type === "mdx") return true;
  const meta = note.metadata as Record<string, unknown> | undefined;
  if (meta?.contentFormat === "mdx") return true;
  if (meta?.bundledDoc === true) {
    const sf = meta.sourceFile;
    if (typeof sf === "string" && sf.toLowerCase().endsWith(".mdx")) return true;
  }
  return false;
}

/** Bundled documentation from the repo seed — may use MDX expressions. */
export function isMdxBundledTrust(note: Note): boolean {
  return (note.metadata as { bundledDoc?: boolean } | undefined)?.bundledDoc === true;
}
