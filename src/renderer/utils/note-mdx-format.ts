import type { Note } from "@archon/ui-types";
import type { ArchonMdxTrustMode } from "./remark-archon-mdx-trust";

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

/**
 * MDX mini-app notes (`type: "mdx"`) — expressions allowed, persistent state
 * components from `@archon/mdx-sdk`. Bundled takes precedence.
 */
export function isMdxMiniApp(note: Note): boolean {
  if (isMdxBundledTrust(note)) return false;
  return note.type === "mdx";
}

/** Pick the trust tier for the remark-archon-mdx-trust plugin. */
export function pickMdxTrustMode(note: Note): ArchonMdxTrustMode {
  if (isMdxBundledTrust(note)) return "bundled";
  if (isMdxMiniApp(note)) return "mini-app";
  return "user";
}
