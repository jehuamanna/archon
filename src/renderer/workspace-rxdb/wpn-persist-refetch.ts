import { store } from "../store";
import { fetchAllNotes, fetchNote } from "../store/notesSlice";
import { isNotePendingDelete } from "../store/pendingNoteDeletes";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 150;

/** Coalesce main-process WPN persist signals (IPC + RxDB mirror import) into one Redux refresh. */
export function scheduleDebouncedNotesRefetchAfterWpnPersist(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void store.dispatch(fetchAllNotes());
    const id = store.getState().notes.currentNote?.id;
    if (id && !isNotePendingDelete(id)) {
      void store.dispatch(fetchNote(id));
    }
  }, DEBOUNCE_MS);
}
