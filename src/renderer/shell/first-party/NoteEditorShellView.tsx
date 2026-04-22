import React, { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import NoteViewer from "../../components/NoteViewer";
import { workspaceFolderPathForNote } from "../../../shared/note-workspace";
import type { AppDispatch, RootState } from "../../store";
import { clearNoteTitleDraft, fetchAllNotes, fetchNote, renameNote } from "../../store/notesSlice";
import {
  runWpnNoteTitleRenameWithVfsDependentsFlow,
  useVfsDependentTitleRenameChoice,
} from "../wpn/vfsDependentTitleRenameChoice";
import { useShellRegistries } from "../registries/ShellRegistriesContext";
import { useShellActiveMainTab } from "../ShellActiveTabContext";
import { useShellProjectWorkspace } from "../useShellProjectWorkspace";
import type { ShellViewComponentProps } from "../views/ShellViewRegistry";
import { SHELL_TAB_NOTE, SHELL_TAB_SCRATCH_MARKDOWN } from "./shellWorkspaceIds";

type NoteTabState = { noteId?: string };

export function NoteEditorShellView(_props: ShellViewComponentProps): React.ReactElement {
  const tab = useShellActiveMainTab();
  const { tabs } = useShellRegistries();
  const dispatch = useDispatch<AppDispatch>();
  const vfsRenameChoice = useVfsDependentTitleRenameChoice();
  const currentNote = useSelector((s: RootState) => s.notes.currentNote);
  const detailLoading = useSelector((s: RootState) => s.notes.detailLoading);
  const error = useSelector((s: RootState) => s.notes.error);
  const { workspaceRoots } = useShellProjectWorkspace();

  const noteId =
    tab && typeof tab.state === "object" && tab.state !== null
      ? (tab.state as NoteTabState).noteId
      : undefined;

  const prevNoteIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (noteId) {
      void dispatch(fetchNote(noteId));
    }
  }, [dispatch, noteId]);

  useEffect(() => {
    const prev = prevNoteIdRef.current;
    if (prev && prev !== noteId) {
      dispatch(clearNoteTitleDraft(prev));
    }
    prevNoteIdRef.current = noteId;
  }, [dispatch, noteId]);

  const assetProjectRoot =
    noteId && workspaceRoots.length > 0
      ? workspaceFolderPathForNote(noteId, workspaceRoots)
      : null;

  if (!noteId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[12px] text-muted-foreground">
        No note selected.
      </div>
    );
  }

  if (error && !detailLoading && currentNote?.id !== noteId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[12px] text-destructive">
        {error}
      </div>
    );
  }

  if (detailLoading && !currentNote) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[12px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (currentNote?.id === noteId) {
    return (
      <>
        {vfsRenameChoice.portal}
        <NoteViewer
          note={currentNote}
          assetProjectRoot={assetProjectRoot}
          onTitleCommit={(title) => {
            return (async () => {
              const id = currentNote.id;
              const outcome = await runWpnNoteTitleRenameWithVfsDependentsFlow({
                noteId: id,
                currentTitle: currentNote.title ?? "",
                newTitle: title,
                prompt: vfsRenameChoice.prompt,
                rename: async (updateVfsDependentLinks) => {
                  await dispatch(renameNote({ id, title, updateVfsDependentLinks })).unwrap();
                },
              });
              if (outcome === "cancelled") {
                throw new DOMException("Rename cancelled", "AbortError");
              }
              await dispatch(fetchAllNotes());
              const tabInst =
                tabs.findNoteTabByNoteId(id, SHELL_TAB_NOTE) ??
                tabs.findNoteTabByNoteId(id, SHELL_TAB_SCRATCH_MARKDOWN);
              if (tabInst) {
                const label = title.replace(/\s+/g, " ").trim() || "Untitled";
                tabs.updateTabPresentation(tabInst.instanceId, { title: label });
              }
            })();
          }}
        />
      </>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-6 text-[12px] text-muted-foreground">
      Loading…
    </div>
  );
}
