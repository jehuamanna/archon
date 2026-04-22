import { getArchon } from "../../shared/archon-host-access";
import { platformDeps, store } from "../store";
import { createNote, fetchAllNotes } from "../store/notesSlice";
import {
  ensureScratchMarkdownProjectId,
  findFlatRootMarkdownNoteIdWithTitleCaseInsensitive,
  findRootMarkdownNoteIdWithTitleCaseInsensitive,
  nextScratchBufferTitle,
  nextScratchMarkdownTitleFromFlatList,
  scratchNotesUseWpnPath,
  SCRATCH_NOTE_BASE_TITLE,
} from "./wpnScratchProject";
import { dispatchWpnTreeChanged } from "./first-party/plugins/notes-explorer/wpnExplorerEvents";
import {
  NOTES_EXPLORER_VIEW_SIDEBAR,
  SHELL_TAB_SCRATCH_MARKDOWN,
} from "./first-party/shellWorkspaceIds";
import type { ShellNavigationDeps } from "./shellRailNavigation";

const LS_KEY = "archon.scratchMarkdown.noteId.v1";

/** IPC and RTK sometimes reject with plain `{ message }` objects, not `Error` instances. */
function messageFromCaught(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.name || "Error";
  if (typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
    const err = (e as { error?: unknown }).error;
    if (typeof err === "string" && err.length > 0) return err;
    try {
      const s = JSON.stringify(e);
      if (s && s !== "{}") return s;
    } catch {
      /* ignore */
    }
  }
  return String(e);
}

/** True if the id still exists in the notes backend (not only in a possibly stale Redux list). */
async function scratchStoredNoteIdStillValid(id: string): Promise<boolean> {
  try {
    if (await scratchNotesUseWpnPath()) {
      await getArchon().wpnGetNote(id);
      return true;
    }
    const note = await platformDeps.localStore.notes.getNote(id);
    return note != null;
  } catch {
    return false;
  }
}

/**
 * Opens or focuses the shell Scratch markdown tab (one reusable root markdown note per browser profile).
 */
export async function openScratchMarkdownTabInShell(deps: ShellNavigationDeps): Promise<void> {
  deps.layout.setVisible("menuRail", true);
  deps.layout.setVisible("sidebarPanel", true);
  deps.views.openView(NOTES_EXPLORER_VIEW_SIDEBAR, "primarySidebar");

  let noteId: string | undefined;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw?.trim()) {
      const id = raw.trim();
      if (await scratchStoredNoteIdStillValid(id)) {
        noteId = id;
      } else {
        try {
          localStorage.removeItem(LS_KEY);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }

  if (!noteId) {
    const useWpnPath = await scratchNotesUseWpnPath();
    try {
      let id: string;
      if (useWpnPath) {
        const projectId = await ensureScratchMarkdownProjectId();
        const existing = await findRootMarkdownNoteIdWithTitleCaseInsensitive(
          projectId,
          SCRATCH_NOTE_BASE_TITLE,
        );
        if (existing) {
          id = existing;
        } else {
          const title = await nextScratchBufferTitle(projectId);
          const created = await getArchon().wpnCreateNoteInProject(projectId, {
            relation: "root",
            type: "markdown",
            title,
            content: "",
          });
          id = created.id;
        }
      } else {
        const existing = await findFlatRootMarkdownNoteIdWithTitleCaseInsensitive(
          SCRATCH_NOTE_BASE_TITLE,
        );
        if (existing) {
          id = existing;
        } else {
          const title = await nextScratchMarkdownTitleFromFlatList();
          const r = await store
            .dispatch(
              createNote({
                relation: "root",
                type: "markdown",
                title,
                content: "",
              }),
            )
            .unwrap();
          id = r.id;
        }
      }
      noteId = id;
      try {
        localStorage.setItem(LS_KEY, id);
      } catch {
        /* ignore */
      }
      await store.dispatch(fetchAllNotes()).unwrap();
      dispatchWpnTreeChanged();
    } catch (e) {
      const msg = messageFromCaught(e);
      window.alert(`Could not open Scratch markdown: ${msg}`);
      return;
    }
  }

  const title =
    store.getState().notes.notesList.find((n) => n.id === noteId)?.title?.trim() ||
    SCRATCH_NOTE_BASE_TITLE;

  deps.tabs.openOrReuseTab(SHELL_TAB_SCRATCH_MARKDOWN, {
    title,
    reuseKey: "shell:scratch-markdown",
    state: { noteId },
  });
  const inst = deps.tabs.getActiveTab();
  if (inst) {
    const mainViewId = deps.tabs.resolveViewForInstance(inst.instanceId);
    if (mainViewId) deps.views.openView(mainViewId, "mainArea");
  }
}
