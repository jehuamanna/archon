import { moveProjectAsset } from "./assets-fs";
import {
  exportSerializedState,
  importSerializedState,
  type SerializedNotesState,
} from "./notes-store";

const MAX = 50;

export type AssetMoveRecord = {
  fromProject: string;
  fromRel: string;
  toProject: string;
  toRel: string;
};

type UndoEntry =
  | { kind: "notes"; snapshot: SerializedNotesState }
  | { kind: "asset"; rec: AssetMoveRecord };

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

function cloneState(s: SerializedNotesState): SerializedNotesState {
  return JSON.parse(JSON.stringify(s)) as SerializedNotesState;
}

export function clearArchonUndoRedo(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

/** Call immediately before a notes tree mutation (move, delete, paste, create, rename). */
export function pushNotesUndoSnapshot(): void {
  const snap = cloneState(exportSerializedState());
  undoStack.push({ kind: "notes", snapshot: snap });
  if (undoStack.length > MAX) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

/** After a successful asset move (fromRel → toRel under respective projects). */
export function recordAssetMoveForUndo(rec: AssetMoveRecord): void {
  undoStack.push({ kind: "asset", rec });
  if (undoStack.length > MAX) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

function posixDirname(rel: string): string {
  const s = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i === -1 ? "" : s.slice(0, i);
}

export function archonUndo(workspaceRoots: string[]): {
  ok: boolean;
  error?: string;
  touchedNotes?: boolean;
} {
  const entry = undoStack.pop();
  if (!entry) {
    return { ok: false, error: "Nothing to undo" };
  }

  if (entry.kind === "notes") {
    const cur = cloneState(exportSerializedState());
    redoStack.push({ kind: "notes", snapshot: cur });
    if (!importSerializedState(entry.snapshot)) {
      undoStack.push(entry);
      redoStack.pop();
      return { ok: false, error: "Could not restore notes state" };
    }
    return { ok: true, touchedNotes: true };
  }

  const { rec } = entry;
  const inv = moveProjectAsset(
    workspaceRoots,
    rec.toProject,
    rec.toRel,
    rec.fromProject,
    posixDirname(rec.fromRel),
  );
  if (!inv.ok) {
    undoStack.push(entry);
    return { ok: false, error: inv.error };
  }
  redoStack.push(entry);
  return { ok: true, touchedNotes: false };
}

export function archonRedo(workspaceRoots: string[]): {
  ok: boolean;
  error?: string;
  touchedNotes?: boolean;
} {
  const entry = redoStack.pop();
  if (!entry) {
    return { ok: false, error: "Nothing to redo" };
  }

  if (entry.kind === "notes") {
    const cur = cloneState(exportSerializedState());
    undoStack.push({ kind: "notes", snapshot: cur });
    if (!importSerializedState(entry.snapshot)) {
      redoStack.push(entry);
      undoStack.pop();
      return { ok: false, error: "Could not restore notes state" };
    }
    return { ok: true, touchedNotes: true };
  }

  const { rec } = entry;
  const again = moveProjectAsset(
    workspaceRoots,
    rec.fromProject,
    rec.fromRel,
    rec.toProject,
    posixDirname(rec.toRel),
  );
  if (!again.ok) {
    redoStack.push(entry);
    return { ok: false, error: again.error };
  }
  undoStack.push(entry);
  return { ok: true, touchedNotes: false };
}
