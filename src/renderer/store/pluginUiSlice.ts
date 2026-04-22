import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { PLUGIN_UI_PROTOCOL_VERSION } from "../../shared/plugin-state-protocol";

export type PluginUiEntry = {
  state: unknown;
  v: number;
  updatedAt: number;
};

interface PluginUiState {
  byNoteId: Record<string, PluginUiEntry>;
}

const initialState: PluginUiState = {
  byNoteId: {},
};

const pluginUiSlice = createSlice({
  name: "pluginUi",
  initialState,
  reducers: {
    receiveSnapshot: (
      state,
      action: PayloadAction<{ noteId: string; state: unknown }>,
    ) => {
      const { noteId, state: snap } = action.payload;
      state.byNoteId[noteId] = {
        state: snap,
        v: PLUGIN_UI_PROTOCOL_VERSION,
        updatedAt: Date.now(),
      };
    },
    clearNote: (state, action: PayloadAction<string>) => {
      delete state.byNoteId[action.payload];
    },
  },
});

export const { receiveSnapshot, clearNote } = pluginUiSlice.actions;
export default pluginUiSlice.reducer;
