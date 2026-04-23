"use client";

import * as React from "react";
import {
  newNodeId,
  type BuilderDoc,
  type BuilderNode,
  type EditableNode,
} from "./ast.js";
import { parseMdxToBuilderDoc } from "./parse.js";
import { serializeBuilderDoc } from "./serialize.js";
import { Palette } from "./palette.js";
import { Canvas } from "./canvas.js";
import { Inspector } from "./inspector.js";
import { newHistory, pushState, redo, undo } from "./history.js";

export interface BuilderAppProps {
  initialSource: string;
  /** Called when the user clicks Save — host persists via existing note PATCH. */
  onSave: (mdx: string) => Promise<void> | void;
  /** Used for state-key collision lint in the inspector. */
  fetchUsedKeys: () => Promise<Array<{ key: string; noteTitle: string }>>;
  /** If true, renders only the Code view — for read-only-on-import. */
  readOnly?: boolean;
}

export function BuilderApp(props: BuilderAppProps): React.ReactElement {
  const [doc, setDoc] = React.useState<BuilderDoc>(() =>
    parseMdxToBuilderDoc(props.initialSource),
  );
  const [history, setHistory] = React.useState(newHistory);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [usedKeys, setUsedKeys] = React.useState<
    Array<{ key: string; noteTitle: string }>
  >([]);
  const [mode, setMode] = React.useState<"builder" | "code">(
    doc.rawFallback ? "code" : "builder",
  );
  const [codeDraft, setCodeDraft] = React.useState<string>(() =>
    serializeBuilderDoc(doc),
  );
  const [codeError, setCodeError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const keys = await props.fetchUsedKeys();
        setUsedKeys(keys);
      } catch {
        /* swallow */
      }
    })();
  }, [props.fetchUsedKeys]);

  const updateDoc = React.useCallback(
    (next: BuilderDoc): void => {
      setHistory((h) => pushState(h, doc));
      setDoc(next);
      setCodeDraft(serializeBuilderDoc(next));
    },
    [doc],
  );

  const selected = React.useMemo<BuilderNode | null>(() => {
    if (!selectedId) return null;
    return doc.body.find((n) => n.id === selectedId) ?? null;
  }, [doc, selectedId]);

  const onPickFromPalette = React.useCallback(
    (component: string) => {
      if (props.readOnly) return;
      const newNode: EditableNode = {
        kind: "editable",
        id: newNodeId("edit"),
        component,
        props: {},
      };
      // Ensure the import exists.
      const nextImports = Array.from(
        new Set([...doc.imports.names, component]),
      );
      updateDoc({
        ...doc,
        imports: { ...doc.imports, names: nextImports },
        body: [...doc.body, newNode],
      });
    },
    [doc, props.readOnly, updateDoc],
  );

  const onUpdateProps = React.useCallback(
    (id: string, nextProps: EditableNode["props"]) => {
      const body = doc.body.map((n) =>
        n.id === id && n.kind === "editable" ? { ...n, props: nextProps } : n,
      );
      updateDoc({ ...doc, body });
    },
    [doc, updateDoc],
  );

  const onDelete = React.useCallback(
    (id: string) => {
      const body = doc.body.filter((n) => n.id !== id);
      updateDoc({ ...doc, body });
      setSelectedId(null);
    },
    [doc, updateDoc],
  );

  const onReorder = React.useCallback(
    (fromIdx: number, toIdx: number) => {
      const body = [...doc.body];
      const [moved] = body.splice(fromIdx, 1);
      body.splice(toIdx, 0, moved);
      updateDoc({ ...doc, body });
    },
    [doc, updateDoc],
  );

  const onUndo = React.useCallback(() => {
    const r = undo(history, doc);
    if (r) {
      setHistory(r.history);
      setDoc(r.restored);
      setCodeDraft(serializeBuilderDoc(r.restored));
    }
  }, [history, doc]);

  const onRedo = React.useCallback(() => {
    const r = redo(history, doc);
    if (r) {
      setHistory(r.history);
      setDoc(r.restored);
      setCodeDraft(serializeBuilderDoc(r.restored));
    }
  }, [history, doc]);

  const applyCode = React.useCallback(() => {
    const parsed = parseMdxToBuilderDoc(codeDraft);
    if (parsed.rawFallback) {
      setCodeError(
        parsed.parseError ??
          "MDX contained constructs the builder can't represent.",
      );
      return;
    }
    setCodeError(null);
    setHistory((h) => pushState(h, doc));
    setDoc(parsed);
    setMode("builder");
  }, [codeDraft, doc]);

  const onSaveClick = React.useCallback(async () => {
    const mdx = mode === "code" ? codeDraft : serializeBuilderDoc(doc);
    await props.onSave(mdx);
  }, [mode, codeDraft, doc, props]);

  const handleKey = React.useCallback(
    (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        onUndo();
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        (e.key.toLowerCase() === "y" ||
          (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        e.preventDefault();
        onRedo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setMode((m) => (m === "builder" ? "code" : "builder"));
      }
    },
    [onUndo, onRedo],
  );

  React.useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  if (props.readOnly) {
    return (
      <div style={{ padding: 12 }}>
        <div
          role="alert"
          style={{
            padding: 8,
            border: "1px solid #f59e0b",
            background: "#fffbeb",
            marginBottom: 12,
          }}
        >
          Imported — editable only by the workspace owner.
        </div>
        <pre
          style={{
            padding: 8,
            border: "1px solid #e4e4e7",
            background: "#fafafa",
            whiteSpace: "pre-wrap",
            fontFamily: "ui-monospace,monospace",
          }}
        >
          {props.initialSource}
        </pre>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: 8,
          borderBottom: "1px solid #e4e4e7",
          alignItems: "center",
        }}
      >
        <button type="button" onClick={() => setMode("builder")} disabled={mode === "builder"}>
          Builder
        </button>
        <button type="button" onClick={() => setMode("code")} disabled={mode === "code"}>
          Code
        </button>
        <button type="button" onClick={onUndo} disabled={history.past.length === 0}>
          Undo
        </button>
        <button type="button" onClick={onRedo} disabled={history.future.length === 0}>
          Redo
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onSaveClick}>
          Save
        </button>
      </div>

      {mode === "builder" ? (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <Palette onPick={onPickFromPalette} />
          <Canvas
            nodes={doc.body}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDelete={onDelete}
            onReorder={onReorder}
          />
          <Inspector
            selected={selected}
            onUpdateProps={onUpdateProps}
            usedKeys={usedKeys}
          />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: 12 }}>
          {codeError && (
            <div
              role="alert"
              style={{
                padding: 8,
                border: "1px solid #dc2626",
                background: "#fef2f2",
                color: "#991b1b",
                marginBottom: 8,
              }}
            >
              {codeError}
            </div>
          )}
          <textarea
            value={codeDraft}
            onChange={(e) => setCodeDraft(e.target.value)}
            style={{
              flex: 1,
              width: "100%",
              minHeight: 320,
              fontFamily: "ui-monospace,monospace",
              fontSize: 13,
              padding: 8,
              border: "1px solid #e4e4e7",
            }}
          />
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button type="button" onClick={applyCode}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
