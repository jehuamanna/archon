import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import React, { useEffect, useMemo, useRef } from "react";
import { notebookEditorExtensions } from "./js-notebook-codemirror";

export type NotebookCellEditorProps = {
  value: string;
  onChange: (next: string) => void;
  /** Names of other cells (and inputs) to suggest; exclude current cell name if desired. */
  completionCellNames: string[];
  dark: boolean;
  onModEnter?: () => void;
};

export function NotebookCellEditor(props: NotebookCellEditorProps): React.ReactElement {
  const { value, onChange, completionCellNames, dark, onModEnter } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const rafRef = useRef(0);

  const namesKey = [...completionCellNames].sort().join("\0");
  const extensions = useMemo(
    () =>
      notebookEditorExtensions({
        cellNames: [...completionCellNames].sort(),
        dark,
        onModEnter,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- namesKey captures completion set
    [namesKey, dark, onModEnter],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      if (!viewRef.current) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        viewRef.current?.requestMeasure();
      });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, []);

  return (
    <div ref={hostRef} className="rounded-md border border-border text-[11px]">
      <CodeMirror
        value={value}
        height="120px"
        theme="none"
        basicSetup={false}
        extensions={extensions}
        className="rounded-md"
        onCreateEditor={(view) => {
          viewRef.current = view;
          // Ensure layout/cursor is correct on first paint.
          view.requestMeasure();
        }}
        onChange={(v) => onChange(v)}
      />
    </div>
  );
}
