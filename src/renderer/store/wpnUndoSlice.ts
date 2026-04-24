import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * Undo entries are plain runnables; the inverse rewinds the forward mutation.
 * Kept outside of Redux-persisted state (functions aren't serializable), so the
 * registry lives only for the current session.
 */
export type WpnUndoEntry = {
  label: string;
  forward: () => Promise<void>;
  inverse: () => Promise<void>;
  at: number;
};

type UndoState = {
  /** Monotonic counter that bumps whenever the stacks change, so selectors can cheaply subscribe. */
  version: number;
};

const initialState: UndoState = { version: 0 };

const MAX_DEPTH = 50;

const undoStack: WpnUndoEntry[] = [];
const redoStack: WpnUndoEntry[] = [];

const slice = createSlice({
  name: "wpnUndo",
  initialState,
  reducers: {
    bumpUndoVersion(state): void {
      state.version += 1;
    },
    resetUndo(state): void {
      undoStack.length = 0;
      redoStack.length = 0;
      state.version += 1;
    },
    // PayloadAction kept for devtools labelling even though storage is out-of-band.
    noteUndoPush(_state, _action: PayloadAction<{ label: string }>): void {
      /* no-op; the slice just records the event for devtools */
    },
    noteUndoPop(_state, _action: PayloadAction<{ label: string }>): void {
      /* no-op */
    },
    noteRedoPop(_state, _action: PayloadAction<{ label: string }>): void {
      /* no-op */
    },
  },
});

export const { bumpUndoVersion, resetUndo, noteUndoPush, noteUndoPop, noteRedoPop } = slice.actions;
export default slice.reducer;

/** Push a new forward action onto the undo stack. Clears the redo stack (standard behaviour). */
export function pushUndoEntry(entry: Omit<WpnUndoEntry, "at">): void {
  undoStack.push({ ...entry, at: Date.now() });
  if (undoStack.length > MAX_DEPTH) undoStack.shift();
  redoStack.length = 0;
}

export function popUndoEntry(): WpnUndoEntry | null {
  return undoStack.pop() ?? null;
}

export function pushRedoEntry(entry: WpnUndoEntry): void {
  redoStack.push(entry);
  if (redoStack.length > MAX_DEPTH) redoStack.shift();
}

export function popRedoEntry(): WpnUndoEntry | null {
  return redoStack.pop() ?? null;
}

export function peekUndoLabel(): string | null {
  return undoStack[undoStack.length - 1]?.label ?? null;
}

export function peekRedoLabel(): string | null {
  return redoStack[redoStack.length - 1]?.label ?? null;
}
