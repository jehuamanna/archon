import { useSelector } from "react-redux";
import { RootState } from "../store";
import type { PluginUiEntry } from "../store/pluginUiSlice";

/**
 * Latest plugin UI snapshot received from the iframe for this note (host Redux cache).
 * Persisted copy lives on `Note.metadata.pluginUiState` after debounced save.
 */
export function usePluginNoteState(
  noteId: string | undefined,
): PluginUiEntry | undefined {
  return useSelector((s: RootState) =>
    noteId ? s.pluginUi.byNoteId[noteId] : undefined,
  );
}
