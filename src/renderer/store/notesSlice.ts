import { createSlice, createAsyncThunk, PayloadAction } from "@reduxjs/toolkit";
import type { ArchonPlatformDeps } from "@archon/platform";
import {
  CreateNoteRelation,
  Note,
  NoteListItem,
  NoteMovePlacement,
  PasteSubtreePayload,
} from "@archon/ui-types";
import { PLUGIN_UI_METADATA_KEY } from "../../shared/plugin-state-protocol";
import { isNotePendingDelete } from "./pendingNoteDeletes";
import { isPlaceholderNoteId } from "../notes/placeholder-note-id";

type NotesThunkConfig = { extra: ArchonPlatformDeps };

/** Per-note monotonic save generation (dispatch order). Not in Redux so thunks can read it synchronously. */
const nextContentSaveSeqByNoteId = new Map<string, number>();

function takeNextContentSaveSeq(noteId: string): number {
  const n = (nextContentSaveSeqByNoteId.get(noteId) ?? 0) + 1;
  nextContentSaveSeqByNoteId.set(noteId, n);
  return n;
}

/** After loading note from server, ignore completions of older in-flight saves for that id. */
function bumpContentSaveSeqAfterExternalLoad(noteId: string): number {
  return takeNextContentSaveSeq(noteId);
}

interface NotesState {
  currentNote: Note | null;
  /** Background-warmed note details keyed by id. */
  notePrefetchById: Record<string, Note>;
  /** noteIds with an in-flight prefetchNote request. Hover guard de-dupes. */
  notePrefetchInFlight: Record<string, true>;
  notesList: NoteListItem[];
  /** Sidebar / tree list fetch */
  listLoading: boolean;
  /** Selected note body fetch */
  detailLoading: boolean;
  error: string | null;
  /**
   * Incremented on successful `renameNote` (IPC / API). WPN Notes explorer listens
   * and refetches the open project tree so titles stay in sync with the editor header.
   */
  noteRenameEpoch: number;
  /**
   * Last applied `saveNoteContent` generation per note. Prevents out-of-order async
   * completions from clobbering newer editor state in Redux (and controlled editors).
   */
  noteContentSaveAppliedSeq: Record<string, number>;
  /**
   * Ephemeral in-progress title text shared between WPN explorer inline rename and
   * {@link NoteViewer} header so both surfaces stay in sync while typing.
   */
  noteTitleDraftById: Record<string, string>;
}

const initialState: NotesState = {
  currentNote: null,
  notePrefetchById: {},
  notePrefetchInFlight: {},
  notesList: [],
  listLoading: false,
  detailLoading: false,
  error: null,
  noteRenameEpoch: 0,
  noteContentSaveAppliedSeq: {},
  noteTitleDraftById: {},
};

export const fetchNote = createAsyncThunk<
  Note | null,
  string | undefined,
  NotesThunkConfig
>("notes/fetchNote", async (noteId, { extra }) => {
  // Skip optimistic-create placeholders (`__pending_create__<uuid>`):
  // they aren't valid Postgres uuids, so the GET would 404 (after the
  // server-side defensive validator) or 500 (before it). Either way, the
  // request is wasted — the real id replaces the placeholder when the
  // create RPC resolves and the next dispatch fetches against that.
  if (noteId && isPlaceholderNoteId(noteId)) return null;
  return await extra.localStore.notes.getNote(noteId);
});

export const fetchAllNotes = createAsyncThunk<
  NoteListItem[],
  void,
  NotesThunkConfig
>("notes/fetchAllNotes", async (_, { extra }) => {
  return await extra.localStore.notes.getAllNotes();
});

export const prefetchNote = createAsyncThunk<
  Note | null,
  string,
  NotesThunkConfig
>(
  "notes/prefetchNote",
  async (noteId, { extra }) => {
    return await extra.localStore.notes.getNote(noteId);
  },
  {
    // Skip the dispatch entirely when:
    // - the id is an optimistic-create placeholder (would 404/500),
    // - we already have the note in the prefetch cache,
    // - or the same id is already in flight (hover sweep / re-hover de-dupe).
    condition: (noteId, { getState }) => {
      if (isPlaceholderNoteId(noteId)) return false;
      const s = (getState() as { notes: NotesState }).notes;
      if (s.notePrefetchById[noteId]) return false;
      if (s.notePrefetchInFlight[noteId]) return false;
      return true;
    },
  },
);

export const createNote = createAsyncThunk<
  { id: string },
  {
    anchorId?: string;
    relation: CreateNoteRelation;
    type: string;
    content?: string;
    title?: string;
  },
  NotesThunkConfig
>("notes/createNote", async (payload, { extra }) => {
  return await extra.localStore.notes.createNote(payload);
});

export const renameNote = createAsyncThunk<
  { id: string; title: string },
  { id: string; title: string; updateVfsDependentLinks?: boolean },
  NotesThunkConfig
>("notes/renameNote", async ({ id, title, updateVfsDependentLinks }, { extra, getState, dispatch }) => {
  await extra.localStore.notes.renameNote(id, title, { updateVfsDependentLinks });
  // After VFS rewrites, re-fetch the current note so the editor picks up rewritten links
  // before auto-save overwrites them with stale content.
  if (updateVfsDependentLinks !== false) {
    const currentNoteId = (getState() as { notes: NotesState }).notes.currentNote?.id;
    if (currentNoteId && currentNoteId !== id) {
      void dispatch(fetchNote(currentNoteId));
    }
  }
  return { id, title };
});

export const moveNoteInTree = createAsyncThunk<
  void,
  {
    draggedId: string;
    targetId: string;
    placement: NoteMovePlacement;
  },
  NotesThunkConfig
>("notes/moveNote", async (payload, { extra }) => {
  await extra.localStore.notes.moveNote(
    payload.draggedId,
    payload.targetId,
    payload.placement,
  );
});

export const moveNotesBulkInTree = createAsyncThunk<
  void,
  {
    ids: string[];
    targetId: string;
    placement: NoteMovePlacement;
  },
  NotesThunkConfig
>("notes/moveNotesBulk", async (payload, { extra }) => {
  await extra.localStore.notes.moveNotesBulk(
    payload.ids,
    payload.targetId,
    payload.placement,
  );
});

export const deleteNotesInTree = createAsyncThunk<void, string[], NotesThunkConfig>(
  "notes/deleteNotes",
  async (ids, { extra }) => {
    await extra.localStore.notes.deleteNotes(ids);
  },
);

export const pasteSubtree = createAsyncThunk<
  unknown,
  PasteSubtreePayload,
  NotesThunkConfig
>("notes/pasteSubtree", async (payload, { extra }) => {
  return await extra.localStore.notes.pasteSubtree(payload);
});

export const saveNotePluginUiState = createAsyncThunk<
  { noteId: string; state: unknown },
  { noteId: string; state: unknown },
  NotesThunkConfig
>("notes/saveNotePluginUiState", async ({ noteId, state }, { extra }) => {
  await extra.localStore.notes.saveNotePluginUiState(noteId, state);
  return { noteId, state };
});

export const saveNoteContent = createAsyncThunk<
  { noteId: string; content: string; saveSeq: number },
  { noteId: string; content: string },
  NotesThunkConfig
>(
  "notes/saveNoteContent",
  async ({ noteId, content }, { extra }) => {
    const saveSeq = takeNextContentSaveSeq(noteId);
    await extra.localStore.notes.saveNoteContent(noteId, content);
    return { noteId, content, saveSeq };
  },
  { condition: ({ noteId }) => !isNotePendingDelete(noteId) },
);

export const patchNoteMetadata = createAsyncThunk<
  { noteId: string; patch: Record<string, unknown> },
  { noteId: string; patch: Record<string, unknown> },
  NotesThunkConfig
>("notes/patchNoteMetadata", async ({ noteId, patch }, { extra }) => {
  await extra.localStore.notes.patchNoteMetadata(noteId, patch);
  return { noteId, patch };
});

const notesSlice = createSlice({
  name: "notes",
  initialState,
  reducers: {
    setCurrentNote: (state, action: PayloadAction<Note>) => {
      state.currentNote = action.payload;
    },
    clearCurrentNote: (state) => {
      state.currentNote = null;
      state.detailLoading = false;
    },
    clearError: (state) => {
      state.error = null;
    },
    setNoteTitleDraft: (state, action: PayloadAction<{ id: string; text: string }>) => {
      const { id, text } = action.payload;
      if (!id) return;
      state.noteTitleDraftById[id] = text;
    },
    clearNoteTitleDraft: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      if (!id) return;
      delete state.noteTitleDraftById[id];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchNote.pending, (state, action) => {
        state.detailLoading = true;
        state.error = null;
        const requestedId = action.meta.arg;
        if (requestedId) {
          const cached = state.notePrefetchById[requestedId];
          if (cached) {
            state.currentNote = cached;
          }
        }
      })
      .addCase(fetchNote.fulfilled, (state, action) => {
        state.detailLoading = false;
        const note = action.payload ?? null;
        const requestedId = action.meta.arg;
        state.currentNote = note;
        if (typeof requestedId === "string" && requestedId.length > 0 && note === null) {
          state.error = "This note no longer exists or could not be loaded.";
        } else if (note) {
          state.error = null;
        }
        if (note?.id) {
          state.notePrefetchById[note.id] = note;
          const bar = bumpContentSaveSeqAfterExternalLoad(note.id);
          state.noteContentSaveAppliedSeq[note.id] = bar;
        }
      })
      .addCase(fetchNote.rejected, (state, action) => {
        state.detailLoading = false;
        state.error = action.error.message || "Failed to fetch note";
      })
      .addCase(fetchAllNotes.pending, (state) => {
        state.listLoading = true;
        state.error = null;
      })
      .addCase(fetchAllNotes.fulfilled, (state, action) => {
        state.listLoading = false;
        state.notesList = Array.isArray(action.payload) ? action.payload : [];
      })
      .addCase(fetchAllNotes.rejected, (state, action) => {
        state.listLoading = false;
        state.error = action.error.message || "Failed to fetch notes list";
      })
      .addCase(prefetchNote.pending, (state, action) => {
        state.notePrefetchInFlight[action.meta.arg] = true;
      })
      .addCase(prefetchNote.fulfilled, (state, action) => {
        delete state.notePrefetchInFlight[action.meta.arg];
        const note = action.payload;
        if (!note?.id) return;
        state.notePrefetchById[note.id] = note;
      })
      .addCase(prefetchNote.rejected, (state, action) => {
        delete state.notePrefetchInFlight[action.meta.arg];
      })
      .addCase(createNote.fulfilled, (state) => {
        state.error = null;
      })
      .addCase(createNote.rejected, (state, action) => {
        state.error = action.error.message || "Failed to create note";
      })
      .addCase(renameNote.fulfilled, (state, action) => {
        state.error = null;
        state.noteRenameEpoch += 1;
        delete state.noteTitleDraftById[action.payload.id];
        if (state.currentNote?.id === action.payload.id) {
          state.currentNote = {
            ...state.currentNote,
            title: action.payload.title.trim(),
          };
        }
      })
      .addCase(renameNote.rejected, (state, action) => {
        state.error = action.error.message || "Failed to rename note";
      })
      .addCase(moveNoteInTree.rejected, (state, action) => {
        state.error = action.error.message || "Failed to move note";
      })
      .addCase(moveNotesBulkInTree.rejected, (state, action) => {
        state.error = action.error.message || "Failed to move notes";
      })
      .addCase(deleteNotesInTree.rejected, (state, action) => {
        state.error = action.error.message || "Failed to delete notes";
      })
      .addCase(pasteSubtree.rejected, (state, action) => {
        state.error = action.error.message || "Failed to paste";
      })
      .addCase(saveNotePluginUiState.fulfilled, (state, action) => {
        const { noteId, state: snap } = action.payload;
        if (state.currentNote?.id === noteId) {
          state.currentNote = {
            ...state.currentNote,
            metadata: {
              ...(state.currentNote.metadata ?? {}),
              [PLUGIN_UI_METADATA_KEY]: snap,
            },
          };
        }
      })
      .addCase(saveNotePluginUiState.rejected, (state, action) => {
        state.error =
          action.error.message || "Failed to save plugin UI state";
      })
      .addCase(saveNoteContent.fulfilled, (state, action) => {
        const { noteId, content, saveSeq } = action.payload;
        const last = state.noteContentSaveAppliedSeq[noteId] ?? 0;
        if (saveSeq < last) return;
        state.noteContentSaveAppliedSeq[noteId] = saveSeq;
        if (state.currentNote?.id === noteId) {
          state.currentNote = { ...state.currentNote, content };
        }
      })
      .addCase(saveNoteContent.rejected, (state, action) => {
        state.error =
          action.error.message || "Failed to save note content";
      });
    builder
      .addCase(patchNoteMetadata.fulfilled, (state, action) => {
        const { noteId, patch } = action.payload;
        if (state.currentNote?.id === noteId) {
          state.currentNote = {
            ...state.currentNote,
            metadata: { ...(state.currentNote.metadata ?? {}), ...patch },
          };
        }
      })
      .addCase(patchNoteMetadata.rejected, (state, action) => {
        state.error =
          action.error.message || "Failed to save note metadata";
      });
  },
});

export const { setCurrentNote, clearCurrentNote, clearError, setNoteTitleDraft, clearNoteTitleDraft } =
  notesSlice.actions;
export default notesSlice.reducer;
