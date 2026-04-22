import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import type { AppDispatch } from "../../../../store";
import { saveNoteContent } from "../../../../store/notesSlice";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import type { NoteTypeReactEditorProps } from "../../../archon-contribution-registry";
import { JsNotebookWorkspace } from "./JsNotebookWorkspace";
import { makeNotebookCellId, type NotebookCell, type NotebookCellsUpdate } from "./js-notebook-types";

function defaultCells(): NotebookCell[] {
  return [
    { id: makeNotebookCellId(), name: "x", inputs: [], body: "42", kind: "js" },
    { id: makeNotebookCellId(), name: "y", inputs: ["x"], body: "x + 1", kind: "js" },
    { id: makeNotebookCellId(), name: "view", inputs: ["y"], body: "'y = ' + y", kind: "js" },
  ];
}

function parseCellsFromContent(raw: string | undefined): NotebookCell[] {
  try {
    const v = raw?.trim() ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(v) && v.length > 0) {
      return v as NotebookCell[];
    }
  } catch {
    /* fall through */
  }
  return defaultCells();
}

function cellsToJson(cells: NotebookCell[]): string {
  return JSON.stringify(cells);
}

/**
 * JS notebook backed by `note.content` (JSON array of cells).
 */
export function JsNoteEditor({
  note,
  persistToNotesStore = true,
}: NoteTypeReactEditorProps): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const contrib = useArchonContributionRegistry();
  const persist = persistToNotesStore !== false;
  const [cells, setCells] = useState<NotebookCell[]>(() => parseCellsFromContent(note.content));
  const latestJsonRef = useRef(cellsToJson(cells));
  const rafRef = useRef(0);
  const persistRef = useRef(persist);
  const noteIdRef = useRef(note.id);

  persistRef.current = persist;
  noteIdRef.current = note.id;

  // Reset only when switching notes. Same issue as markdown: `saveNoteContent.fulfilled`
  // can apply an older payload while the user keeps typing, and syncing from `note.content`
  // would replace `cells` and clobber CodeMirror cell bodies.
  useEffect(() => {
    const next = parseCellsFromContent(note.content);
    setCells(next);
    latestJsonRef.current = cellsToJson(next);
  }, [note.id]);

  const flushNow = useCallback(() => {
    if (rafRef.current !== 0) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (!persistRef.current) return;
    void dispatch(
      saveNoteContent({ noteId: noteIdRef.current, content: latestJsonRef.current }),
    );
  }, [dispatch]);

  const scheduleBatchedFlush = useCallback(() => {
    if (!persistRef.current) return;
    if (rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!persistRef.current) return;
      void dispatch(
        saveNoteContent({ noteId: noteIdRef.current, content: latestJsonRef.current }),
      );
    });
  }, [dispatch]);

  useEffect(() => {
    const idWhenAttached = note.id;
    return () => {
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      if (persistRef.current) {
        void dispatch(
          saveNoteContent({ noteId: idWhenAttached, content: latestJsonRef.current }),
        );
      }
    };
  }, [note.id, dispatch]);

  const persistCells = useCallback(
    (nextOrUpdater: NotebookCellsUpdate) => {
      setCells((prev) => {
        const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
        latestJsonRef.current = cellsToJson(next);
        return next;
      });
      scheduleBatchedFlush();
    },
    [scheduleBatchedFlush],
  );

  const invokeCommand = useCallback(
    (commandId: string, args?: Record<string, unknown>) =>
      Promise.resolve(contrib.invokeCommand(commandId, args)).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[JsNotebook]", commandId, err);
      }),
    [contrib],
  );

  return (
    <JsNotebookWorkspace
      cells={cells}
      onCellsChange={persistCells}
      invokeCommand={invokeCommand}
      modeLineScopeId={note.id}
      executeWhenKeyChanges={note.id}
      showSaveNow={persist}
      onSaveNow={flushNow}
    />
  );
}

export function JsNoteEditorHost(props: NoteTypeReactEditorProps): React.ReactElement {
  return <JsNoteEditor note={props.note} persistToNotesStore={props.persistToNotesStore} />;
}
