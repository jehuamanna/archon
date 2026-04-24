import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type WpnClipboardItem = {
  kind: "note" | "project" | "workspace";
  id: string;
  /** For notes: the project the note currently lives in. */
  sourceProjectId?: string;
  /** For projects: the workspace the project currently lives in. */
  sourceWorkspaceId?: string;
  /** For workspaces: the space the workspace currently lives in. */
  sourceSpaceId?: string;
  /** Captured at cut/copy time so we can reject cross-org pastes. */
  sourceOrgId?: string | null;
  /** For notes: the note's parent at the time it was put on the clipboard. */
  sourceParentId?: string | null;
};

export type WpnClipboardState = {
  items: WpnClipboardItem[];
  mode: "cut" | "copy" | null;
};

const initialState: WpnClipboardState = {
  items: [],
  mode: null,
};

const slice = createSlice({
  name: "wpnClipboard",
  initialState,
  reducers: {
    setClipboard(
      state,
      action: PayloadAction<{
        items: WpnClipboardItem[];
        mode: "cut" | "copy";
      }>,
    ): void {
      state.items = action.payload.items;
      state.mode = action.payload.mode;
    },
    clearClipboard(state): void {
      state.items = [];
      state.mode = null;
    },
  },
});

export const { setClipboard, clearClipboard } = slice.actions;
export default slice.reducer;
