import { normalizeVfsSegment } from "../../shared/note-vfs-path";
import type { WorkspaceStore } from "../workspace-store";
import {
  rewriteMarkdownForWpnNoteTitleChange,
  rewriteVfsCanonicalLinksInMarkdown,
  rewriteRelativeSameProjectTitleLinksInMarkdown,
  vfsCanonicalPathsForProjectChange,
  vfsCanonicalPathsForTitleChange,
} from "../../shared/note-vfs-link-rewrite";
import { canonicalVfsPathFromLinkRow } from "../../shared/note-vfs-path";
import {
  wpnJsonGetNoteWithContextById,
  wpnJsonListAllNoteContentsForOwner,
  wpnJsonUpdateNote,
} from "./wpn-json-notes";

export type WpnVfsRewriteResult = { updatedNoteCount: number };

export type WpnVfsPreviewTitleChangeResult = {
  dependentNoteCount: number;
  dependentNoteIds: string[];
};

/**
 * Notes that would gain updated markdown if the given note's title changed (canonical `#/w/...` and same-project `./...` links).
 */
export function wpnJsonPreviewVfsRewritesAfterTitleChange(
  store: WorkspaceStore,
  ownerId: string,
  renamedNoteId: string,
  oldTitle: string,
  newTitle: string,
): WpnVfsPreviewTitleChangeResult {
  const ctx = wpnJsonGetNoteWithContextById(store, ownerId, renamedNoteId);
  if (!ctx) {
    return { dependentNoteCount: 0, dependentNoteIds: [] };
  }
  const paths = vfsCanonicalPathsForTitleChange(ctx, oldTitle, newTitle);
  if (!paths) {
    return { dependentNoteCount: 0, dependentNoteIds: [] };
  }
  const { oldCanonical, newCanonical } = paths;
  const oldSeg = normalizeVfsSegment(oldTitle, "Untitled");
  const newSeg = normalizeVfsSegment(newTitle, "Untitled");
  const rows = wpnJsonListAllNoteContentsForOwner(store, ownerId);
  const dependentNoteIds: string[] = [];
  for (const row of rows) {
    const content = row.content ?? "";
    const next = rewriteMarkdownForWpnNoteTitleChange(
      content,
      row.project_id,
      ctx.project_id,
      oldCanonical,
      newCanonical,
      oldSeg,
      newSeg,
    );
    if (next !== content) {
      dependentNoteIds.push(row.id);
    }
  }
  return { dependentNoteCount: dependentNoteIds.length, dependentNoteIds };
}

/**
 * After a note title change, rewrite `#/w/...` and `w/...` links across all notes for this owner.
 */
export function wpnJsonApplyVfsRewritesAfterTitleChange(
  store: WorkspaceStore,
  ownerId: string,
  renamedNoteId: string,
  oldTitle: string,
  newTitle: string,
): WpnVfsRewriteResult {
  const ctx = wpnJsonGetNoteWithContextById(store, ownerId, renamedNoteId);
  if (!ctx) {
    return { updatedNoteCount: 0 };
  }
  const paths = vfsCanonicalPathsForTitleChange(ctx, oldTitle, newTitle);
  if (!paths) {
    return { updatedNoteCount: 0 };
  }
  const { oldCanonical, newCanonical } = paths;
  const oldSeg = normalizeVfsSegment(oldTitle, "Untitled");
  const newSeg = normalizeVfsSegment(newTitle, "Untitled");
  const rows = wpnJsonListAllNoteContentsForOwner(store, ownerId);
  let updatedNoteCount = 0;
  for (const row of rows) {
    const content = row.content ?? "";
    const next = rewriteMarkdownForWpnNoteTitleChange(
      content,
      row.project_id,
      ctx.project_id,
      oldCanonical,
      newCanonical,
      oldSeg,
      newSeg,
    );
    if (next !== content) {
      wpnJsonUpdateNote(store, ownerId, row.id, { content: next });
      updatedNoteCount++;
    }
  }
  if (updatedNoteCount > 0) {
    console.info(
      `[wpn] VFS link rewrite (JSON): updated ${updatedNoteCount} note(s) after title change`,
    );
  }
  return { updatedNoteCount };
}

/**
 * Preview which notes would gain updated markdown if the given note
 * moves from one workspace/project to another (canonical `#/w/...` links
 * and same-project `./...` relative links in the old project).
 */
export function wpnJsonPreviewVfsRewritesAfterMove(
  store: WorkspaceStore,
  ownerId: string,
  noteId: string,
  oldWorkspace: string,
  oldProject: string,
  newWorkspace: string,
  newProject: string,
): WpnVfsPreviewTitleChangeResult {
  const ctx = wpnJsonGetNoteWithContextById(store, ownerId, noteId);
  if (!ctx) {
    return { dependentNoteCount: 0, dependentNoteIds: [] };
  }
  // The shared note-vfs path scheme is now 2-segment Project/Title; the
  // workspace prefix is gone. The file vault still tracks workspaces on
  // disk, but VFS hyperlinks across notes don't carry the workspace
  // segment any more. Drop the old/newWorkspace args here.
  void oldWorkspace;
  void newWorkspace;
  const paths = vfsCanonicalPathsForProjectChange(
    oldProject,
    newProject,
    ctx.title,
  );
  if (!paths) {
    return { dependentNoteCount: 0, dependentNoteIds: [] };
  }
  const { oldCanonical, newCanonical } = paths;
  const titleSeg = normalizeVfsSegment(ctx.title, "Untitled");
  const rows = wpnJsonListAllNoteContentsForOwner(store, ownerId);
  const dependentNoteIds: string[] = [];
  for (const row of rows) {
    const content = row.content ?? "";
    let next = rewriteVfsCanonicalLinksInMarkdown(content, oldCanonical, newCanonical);
    // Same-project relative `./Title` links in the OLD project need to become full canonical
    if (row.project_id === ctx.project_id) {
      const newFullCanonical = canonicalVfsPathFromLinkRow({
        projectName: newProject,
        title: ctx.title,
      });
      next = rewriteRelativeSameProjectTitleLinksInMarkdown(
        next,
        titleSeg,
        newFullCanonical,
      );
    }
    if (next !== content) {
      dependentNoteIds.push(row.id);
    }
  }
  return { dependentNoteCount: dependentNoteIds.length, dependentNoteIds };
}

/**
 * After a note moves to a different workspace/project, rewrite `#/w/...`
 * canonical links across all notes and convert `./Title` relative links
 * in the old project to full canonical paths pointing at the new location.
 *
 * `oldProjectId` and `noteTitle` must be captured **before** the move is
 * applied (since the note's `project_id` will already reflect the target).
 */
export function wpnJsonApplyVfsRewritesAfterMove(
  store: WorkspaceStore,
  ownerId: string,
  oldProjectId: string,
  noteTitle: string,
  oldWorkspace: string,
  oldProject: string,
  newWorkspace: string,
  newProject: string,
): WpnVfsRewriteResult {
  void oldWorkspace;
  void newWorkspace;
  const paths = vfsCanonicalPathsForProjectChange(
    oldProject,
    newProject,
    noteTitle,
  );
  if (!paths) {
    return { updatedNoteCount: 0 };
  }
  const { oldCanonical, newCanonical } = paths;
  const titleSeg = normalizeVfsSegment(noteTitle, "Untitled");
  const rows = wpnJsonListAllNoteContentsForOwner(store, ownerId);
  let updatedNoteCount = 0;
  for (const row of rows) {
    const content = row.content ?? "";
    let next = rewriteVfsCanonicalLinksInMarkdown(content, oldCanonical, newCanonical);
    // Same-project relative `./Title` links in the OLD project need to become full canonical
    if (row.project_id === oldProjectId) {
      const newFullCanonical = canonicalVfsPathFromLinkRow({
        projectName: newProject,
        title: noteTitle,
      });
      next = rewriteRelativeSameProjectTitleLinksInMarkdown(
        next,
        titleSeg,
        newFullCanonical,
      );
    }
    if (next !== content) {
      wpnJsonUpdateNote(store, ownerId, row.id, { content: next });
      updatedNoteCount++;
    }
  }
  if (updatedNoteCount > 0) {
    console.info(
      `[wpn] VFS link rewrite (JSON): updated ${updatedNoteCount} note(s) after cross-project move`,
    );
  }
  return { updatedNoteCount };
}
