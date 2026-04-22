/**
 * VFS link rewrite utilities for the sync API.
 *
 * These are thin re-exports of the shared pure-JS utilities from `src/shared/`.
 * We use dynamic import to avoid `verbatimModuleSyntax` issues with cross-boundary
 * ESM/CJS module resolution at type-check time (tsx handles it fine at runtime).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

let _mod: {
  vfsCanonicalPathsForTitleChange: (
    ctx: { workspace_name: string; project_name: string },
    oldTitle: string,
    newTitle: string,
  ) => { oldCanonical: string; newCanonical: string } | null;
  rewriteMarkdownForWpnNoteTitleChange: (
    content: string,
    rowProjectId: string,
    renamedProjectId: string,
    oldCanonical: string,
    newCanonical: string,
    oldTitleSeg: string,
    newTitleSeg: string,
  ) => string;
  rewriteVfsCanonicalLinksInMarkdown: (
    content: string,
    oldCanonical: string,
    newCanonical: string,
    oldTitle?: string,
    newTitle?: string,
  ) => string;
  normalizeVfsSegment: (raw: string, fallback: string) => string;
} | null = null;

async function load() {
  if (_mod) return _mod;
  const linkRewrite = await import("../../../src/shared/note-vfs-link-rewrite.js" as any);
  const vfsPath = await import("../../../src/shared/note-vfs-path.js" as any);
  _mod = {
    vfsCanonicalPathsForTitleChange: linkRewrite.vfsCanonicalPathsForTitleChange,
    rewriteMarkdownForWpnNoteTitleChange: linkRewrite.rewriteMarkdownForWpnNoteTitleChange,
    rewriteVfsCanonicalLinksInMarkdown: linkRewrite.rewriteVfsCanonicalLinksInMarkdown,
    normalizeVfsSegment: vfsPath.normalizeVfsSegment,
  };
  return _mod;
}

/**
 * Rewrite `#/w/<ws>/<proj>/<title>` refs inside markdown so they point at a
 * new canonical path. Used on import (PLAN-06 slice 4c) when a workspace is
 * renamed by the conflict policy — all refs from the bundle that named the
 * old workspace need to slide to the new name so in-bundle backlinks keep
 * resolving post-import.
 */
export async function rewriteVfsCanonicalLinksInMarkdown(
  content: string,
  oldCanonical: string,
  newCanonical: string,
): Promise<string> {
  const m = await load();
  return m.rewriteVfsCanonicalLinksInMarkdown(content, oldCanonical, newCanonical);
}

export async function vfsCanonicalPathsForTitleChange(
  ctx: { workspace_name: string; project_name: string },
  oldTitle: string,
  newTitle: string,
): Promise<{ oldCanonical: string; newCanonical: string } | null> {
  const m = await load();
  return m.vfsCanonicalPathsForTitleChange(ctx, oldTitle, newTitle);
}

export async function rewriteMarkdownForWpnNoteTitleChange(
  content: string,
  rowProjectId: string,
  renamedProjectId: string,
  oldCanonical: string,
  newCanonical: string,
  oldTitleSeg: string,
  newTitleSeg: string,
): Promise<string> {
  const m = await load();
  return m.rewriteMarkdownForWpnNoteTitleChange(
    content, rowProjectId, renamedProjectId,
    oldCanonical, newCanonical, oldTitleSeg, newTitleSeg,
  );
}

export async function normalizeVfsSegment(raw: string, fallback: string): Promise<string> {
  const m = await load();
  return m.normalizeVfsSegment(raw, fallback);
}
