import { store } from "../store";
import {
  NOTES_EXPLORER_VIEW_SIDEBAR,
  SHELL_TAB_NOTE,
} from "./first-party/shellWorkspaceIds";
import { getCachedCanonicalVfsPathForNoteId } from "./noteIdVfsPathCache";
import type { ShellNavigationDeps } from "./shellRailNavigation";
import type { ShellNoteTabState } from "./shellTabUrlSync";

export type OpenNoteInShellOptions = {
  markdownHeadingSlug?: string;
  /** Always add a new note tab instead of focusing an existing tab for this note. */
  newTab?: boolean;
  /** Workspace/Project/Title or ./Title — used for `#/w/...` in the address bar. */
  canonicalVfsPath?: string;
};

function buildShellNoteTabState(
  noteId: string,
  options: OpenNoteInShellOptions | undefined,
  previous: ShellNoteTabState | undefined,
): ShellNoteTabState {
  const hasSlug =
    options?.markdownHeadingSlug !== undefined && options.markdownHeadingSlug !== "";
  const explicitPath = options?.canonicalVfsPath?.trim();
  const vfs =
    explicitPath ||
    getCachedCanonicalVfsPathForNoteId(noteId) ||
    previous?.canonicalVfsPath;
  const st: ShellNoteTabState = { noteId };
  if (hasSlug) {
    st.markdownHeadingSlug = options!.markdownHeadingSlug;
  }
  if (vfs) {
    st.canonicalVfsPath = vfs;
  }
  return st;
}

export function openNoteInShell(
  noteId: string,
  deps: ShellNavigationDeps,
  options?: OpenNoteInShellOptions,
): void {
  const notesList = store.getState().notes.notesList;
  const row = notesList.find((n) => n.id === noteId);
  const title = row?.title?.trim() || "Note";
  deps.layout.setVisible("menuRail", true);
  deps.layout.setVisible("sidebarPanel", true);
  deps.views.openView(NOTES_EXPLORER_VIEW_SIDEBAR, "primarySidebar");
  if (options?.newTab) {
    const state = buildShellNoteTabState(noteId, options, undefined);
    deps.tabs.openTab(SHELL_TAB_NOTE, title, state);
    return;
  }
  const existing = deps.tabs.findNoteTabByNoteId(noteId, SHELL_TAB_NOTE);
  const prevSt = existing?.state as ShellNoteTabState | undefined;
  const state = buildShellNoteTabState(noteId, options, prevSt);
  if (existing) {
    deps.tabs.setActiveTab(existing.instanceId);
    deps.tabs.updateTabPresentation(existing.instanceId, { title, state });
  } else {
    deps.tabs.openOrReuseTab(SHELL_TAB_NOTE, {
      title,
      reuseKey: "note:preview",
      state,
    });
  }
}
