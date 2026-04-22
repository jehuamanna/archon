export type {
  NoteRecord,
  NoteListRow,
  NoteMovePlacement,
} from "./notes-store-core";
export {
  ROOT_KEY,
  isWorkspaceMountNoteId,
  noteDataWorkspaceSlot,
  WORKSPACE_MOUNT_SENTINEL,
} from "./notes-store-core";

export { resetNotesStore } from "./notes-store-core";

export {
  setSeedSampleNotesPreference,
  getSeedSampleNotesPreference,
  ensureNotesSeeded,
} from "./notes-store-seed";

export {
  isDescendantOf,
  mergeMultipleRootsIfNeeded,
  getNotesFlat,
  getNoteById,
  getFirstNote,
} from "./notes-store-query";

export {
  deleteNoteSubtree,
  deleteNoteSubtrees,
  moveNotesBulk,
  moveNote,
} from "./notes-store-move-delete";

export { swapWorkspaceRootBlock } from "./notes-store-workspace-order";

export {
  duplicateSubtreeAt,
  createNote,
  renameNote,
  setNoteContent,
  setNotePluginUiState,
  patchNoteMetadata,
} from "./notes-store-duplicate-create";

export type { SerializedNotesState } from "./notes-store-serialize";
export {
  mergeAttachedSerializedIntoStore,
  seedAttachedWorkspaceIfEmpty,
  exportSerializedState,
  importSerializedState,
} from "./notes-store-serialize";
