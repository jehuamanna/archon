import { getArchon } from "../../../../../shared/archon-host-access";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { NotebookCellEditor } from "./NotebookCellEditor";
import {
  createNotebookArchonHost,
  ARCHON_NOTEBOOK_DOCUMENTED_COMMANDS,
} from "./js-notebook-archon-api";
import { validateNotebookJsDependencies } from "./js-notebook-deps-validation";
import { runJsNotebookTrusted } from "./js-notebook-run-trusted";
import {
  makeNotebookCellId,
  type NotebookCell,
  type NotebookCellsUpdate,
  normalizeNotebookCells,
} from "./js-notebook-types";
import { useTheme } from "../../../../theme/ThemeContext";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { useArchonNoteModeLine } from "../../../useArchonNoteModeLine";
import { useShellLayoutStore } from "../../../layout/ShellLayoutContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { useShellViewRegistry } from "../../../views/ShellViewContext";

const mdPreviewClass =
  "mt-2 rounded border border-border bg-muted/20 p-2 text-[11px] text-foreground [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4";

const NOTEBOOK_VAR_TITLE =
  "Variable this cell defines in the notebook graph. The editor below is the expression for its value (like name x with code 42 defines x as 42).";
const NOTEBOOK_INPUTS_TITLE =
  "Other cell variable names this cell depends on, comma-separated (not the current cell’s name).";

export type JsNotebookWorkspaceProps = {
  cells: NotebookCell[];
  onCellsChange: (next: NotebookCellsUpdate) => void;
  invokeCommand: (commandId: string, args?: Record<string, unknown>) => void | Promise<void>;
  /** Scopes mode-line contributions (note id, scratch key, etc.). */
  modeLineScopeId: string;
  /** Shown on the right of the toolbar (e.g. scratch vs project note). */
  toolbarHint?: React.ReactNode;
  showSaveNow?: boolean;
  onSaveNow?: () => void;
  /** Scratch notebook: run once when the workspace mounts. */
  executeOnMount?: boolean;
  /** Note editor: re-run when this key changes (e.g. note id). */
  executeWhenKeyChanges?: string;
};

export function JsNotebookWorkspace(props: JsNotebookWorkspaceProps): React.ReactElement {
  const {
    cells,
    onCellsChange,
    invokeCommand,
    modeLineScopeId,
    toolbarHint,
    showSaveNow,
    onSaveNow,
    executeOnMount = false,
    executeWhenKeyChanges,
  } = props;
  const { resolvedDark } = useTheme();
  const registry = useArchonContributionRegistry();
  const registries = useShellRegistries();
  const layout = useShellLayoutStore();
  const views = useShellViewRegistry();

  const [err, setErr] = useState<string | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const [lastRunLabel, setLastRunLabel] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);

  const notebookModeLinePrimary = useMemo(() => {
    const n = cells.length;
    return `JS notebook · ${n} cell${n === 1 ? "" : "s"}`;
  }, [cells.length]);

  const notebookModeLineSecondary = useMemo(() => {
    if (runBusy) return "Running…";
    if (err) return err.length > 52 ? `${err.slice(0, 49)}…` : err;
    if (lastRunLabel) return lastRunLabel;
    if (autoRun) return "Auto-run on";
    return null;
  }, [autoRun, err, lastRunLabel, runBusy]);

  useArchonNoteModeLine({
    scopeId: modeLineScopeId,
    primaryLine: notebookModeLinePrimary,
    secondaryLine: notebookModeLineSecondary,
    sourcePluginId: "archon.js-notebook",
  });

  const cellOutputSlotRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const trustedDisposeRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const executeKeySeenRef = useRef<string | undefined>(undefined);

  const archon = useMemo(
    () =>
      createNotebookArchonHost({
        invoke: invokeCommand,
        registry,
        registries,
        layout,
        views,
      }),
    [invokeCommand, registry, registries, layout, views],
  );

  const clearPerCellOutputDom = useCallback(() => {
    cellOutputSlotRef.current.forEach((el) => {
      el.innerHTML = "";
    });
  }, []);

  const clearOutputs = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    trustedDisposeRef.current?.();
    trustedDisposeRef.current = null;
    clearPerCellOutputDom();
    setLastRunLabel(null);
  }, [clearPerCellOutputDom]);

  const stopRun = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    trustedDisposeRef.current?.();
    trustedDisposeRef.current = null;
    setRunBusy(false);
  }, []);

  const clearTrustedSlotsForIds = useCallback((ids: Iterable<string>) => {
    for (const id of ids) {
      const el = cellOutputSlotRef.current.get(id);
      if (el) el.innerHTML = "";
    }
  }, []);

  const getOutputSlot = useCallback((cellId: string) => cellOutputSlotRef.current.get(cellId) ?? null, []);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    trustedDisposeRef.current?.();
    trustedDisposeRef.current = null;
    setErr(null);

    const norm = normalizeNotebookCells(cells);
    const depErr = validateNotebookJsDependencies(norm);
    if (depErr) {
      setErr(depErr);
      setRunBusy(false);
      return;
    }

    runIdRef.current += 1;
    const meta = { runId: runIdRef.current, startedAt: Date.now() };
    const t0 = performance.now();

    clearPerCellOutputDom();
    const jsCount = norm.filter((c) => c.kind === "js").length;
    setRunBusy(true);
    ac.signal.addEventListener("abort", () => setRunBusy(false), { once: true });

    if (jsCount === 0) {
      setLastRunLabel(`Run #${meta.runId} · 0ms`);
      setRunBusy(false);
      return;
    }

    let trustedFinished = 0;
    let trustedCompletionHandled = false;
    const onTrustedCellDone = () => {
      trustedFinished += 1;
      if (trustedCompletionHandled || trustedFinished < jsCount) return;
      trustedCompletionHandled = true;
      if (!ac.signal.aborted) {
        const ms = Math.round(performance.now() - t0);
        setLastRunLabel(`Run #${meta.runId} · ${ms}ms`);
      }
      setRunBusy(false);
    };

    try {
      const { dispose } = runJsNotebookTrusted({
        cells: norm,
        getOutputSlot,
        archonFactory: () => archon,
        signal: ac.signal,
        meta,
        onCellFinished: () => onTrustedCellDone(),
      });
      trustedDisposeRef.current = dispose;
    } catch (e) {
      setRunBusy(false);
      if (e instanceof DOMException && e.name === "AbortError") {
        return;
      }
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [cells, clearPerCellOutputDom, getOutputSlot, archon]);

  const runCell = useCallback(
    async (cellId: string) => {
      const idx = cells.findIndex((c) => c.id === cellId);
      if (idx < 0) return;
      const target = cells[idx];
      if (target.kind === "md") return;

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      trustedDisposeRef.current?.();
      trustedDisposeRef.current = null;

      const prefix = cells.slice(0, idx + 1);
      const norm = normalizeNotebookCells(prefix);
      if (norm.length === 0) return;

      const depErr = validateNotebookJsDependencies(norm);
      if (depErr) {
        setErr(depErr);
        setRunBusy(false);
        return;
      }

      const jsIds = new Set(norm.filter((c) => c.kind === "js").map((c) => c.id));
      clearTrustedSlotsForIds(jsIds);

      setErr(null);

      runIdRef.current += 1;
      const meta = { runId: runIdRef.current, startedAt: Date.now() };
      const t0 = performance.now();

      const jsCount = norm.filter((c) => c.kind === "js").length;
      setRunBusy(true);
      ac.signal.addEventListener("abort", () => setRunBusy(false), { once: true });

      if (jsCount === 0) {
        setLastRunLabel(`Cell · run #${meta.runId} · 0ms`);
        setRunBusy(false);
        return;
      }

      let trustedFinished = 0;
      let trustedCompletionHandled = false;
      const onTrustedCellDone = () => {
        trustedFinished += 1;
        if (trustedCompletionHandled || trustedFinished < jsCount) return;
        trustedCompletionHandled = true;
        if (!ac.signal.aborted) {
          const ms = Math.round(performance.now() - t0);
          setLastRunLabel(`Cell · run #${meta.runId} · ${ms}ms`);
        }
        setRunBusy(false);
      };

      try {
        const { dispose } = runJsNotebookTrusted({
          cells: norm,
          getOutputSlot,
          archonFactory: () => archon,
          signal: ac.signal,
          meta,
          onCellFinished: () => onTrustedCellDone(),
        });
        trustedDisposeRef.current = dispose;
      } catch (e) {
        setRunBusy(false);
        if (e instanceof DOMException && e.name === "AbortError") {
          return;
        }
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [cells, clearTrustedSlotsForIds, getOutputSlot, archon],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      trustedDisposeRef.current?.();
      trustedDisposeRef.current = null;
    };
  }, []);

  // React Strict Mode remounts without resetting refs; clear so note-key run fires again after remount.
  useEffect(() => {
    return () => {
      executeKeySeenRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!autoRun) return;
    const id = window.setTimeout(() => {
      void run();
    }, 550);
    return () => window.clearTimeout(id);
  }, [cells, autoRun, run]);

  useEffect(() => {
    if (!executeOnMount) return;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial scratch run only
  }, []);

  useEffect(() => {
    if (executeWhenKeyChanges === undefined) return;
    if (executeKeySeenRef.current === executeWhenKeyChanges) return;
    executeKeySeenRef.current = executeWhenKeyChanges;
    void run();
  }, [executeWhenKeyChanges, run]);

  const addJsCell = useCallback(() => {
    onCellsChange((prev) => [
      ...prev,
      { id: makeNotebookCellId(), name: `cell${prev.length + 1}`, inputs: [], body: "0", kind: "js" },
    ]);
  }, [onCellsChange]);

  const addMdCell = useCallback(() => {
    onCellsChange((prev) => [
      ...prev,
      {
        id: makeNotebookCellId(),
        name: `md${prev.length + 1}`,
        inputs: [],
        body: "## Markdown\n\nNarrative cell (not executed).",
        kind: "md",
      },
    ]);
  }, [onCellsChange]);

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="text-[12px] font-bold opacity-85">JS notebook</div>
        <button
          type="button"
          className="rounded border border-border bg-muted/20 px-2.5 py-1.5 text-[12px] disabled:opacity-40"
          disabled={runBusy}
          onClick={() => void run()}
        >
          Run all
        </button>
        <button
          type="button"
          className="rounded border border-border bg-muted/20 px-2.5 py-1.5 text-[12px] disabled:opacity-40"
          disabled={!runBusy}
          onClick={stopRun}
        >
          Stop
        </button>
        <button
          type="button"
          className="rounded border border-border bg-muted/20 px-2.5 py-1.5 text-[12px]"
          onClick={clearOutputs}
        >
          Clear outputs
        </button>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] opacity-85">
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
          Auto-run
        </label>
        <button
          type="button"
          className="rounded border border-border bg-muted/20 px-2.5 py-1.5 text-[12px]"
          onClick={addJsCell}
        >
          Add JS cell
        </button>
        <button
          type="button"
          className="rounded border border-border bg-muted/20 px-2.5 py-1.5 text-[12px]"
          onClick={addMdCell}
        >
          Add markdown
        </button>
        {showSaveNow && onSaveNow ? (
          <button
            type="button"
            className="rounded border border-border bg-muted/20 px-2.5 py-1.5 text-[12px]"
            onClick={() => onSaveNow()}
          >
            Save now
          </button>
        ) : null}
        {lastRunLabel ? (
          <span className="text-[10px] opacity-60">{lastRunLabel}</span>
        ) : null}
        {toolbarHint ? <span className="ml-auto text-[11px] opacity-65">{toolbarHint}</span> : null}
      </div>
      {err ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {err}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <p className="mb-2 text-[11px] leading-relaxed opacity-70">
          JS cells use <code className="font-mono">@observablehq/runtime</code> plus stdlib builtins;{" "}
          <code className="font-mono">archon</code> merges <code className="font-mono">window.Archon</code>,{" "}
          <code className="font-mono">window.archon</code> (same <code className="font-mono">shell</code> as DevTools:
          tabs, commands, layout, views, keymap, …), and helpers like{" "}
          <code className="font-mono">archon.commands.run</code>. Use @observablehq/stdlib output helpers (
          <code className="font-mono">html</code>, <code className="font-mono">svg</code>, …) instead of DOM / layout
          APIs (<code className="font-mono">document</code>, <code className="font-mono">addEventListener</code>,{" "}
          <code className="font-mono">getComputedStyle</code>, …), which are blocked on{" "}
          <code className="font-mono">globalThis</code> / <code className="font-mono">window</code>. The variable field
          names this cell; the editor is its value;
          deps are other cell names. <kbd className="rounded border border-border px-0.5 font-mono">Mod+Enter</kbd>{" "}
          runs from the top through the focused JS cell.
        </p>
        <details className="mb-3 text-[10px] opacity-70">
          <summary className="cursor-pointer select-none">Documented command ids</summary>
          <ul className="mt-1 list-inside list-disc font-mono">
            {ARCHON_NOTEBOOK_DOCUMENTED_COMMANDS.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </details>
        {cells.map((c, idx) => {
          const others = cells
            .map((x) => x.name.trim())
            .filter((n, i) => n && i !== idx);
          const completionNames = Array.from(new Set([...others, ...c.inputs]));

          return (
            <div key={c.id} className="mb-2.5 rounded-lg border border-border p-2.5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase opacity-50">{c.kind === "md" ? "md" : "js"}</span>
                <input
                  className="w-40 rounded border border-border px-2 py-1 font-mono text-[11px]"
                  placeholder="variable"
                  title={NOTEBOOK_VAR_TITLE}
                  value={c.name}
                  onChange={(e) =>
                    onCellsChange((prev) =>
                      prev.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <input
                  className="w-52 rounded border border-border px-2 py-1 font-mono text-[11px]"
                  placeholder="other cells: foo, bar"
                  title={NOTEBOOK_INPUTS_TITLE}
                  value={c.inputs.join(", ")}
                  onChange={(e) =>
                    onCellsChange((prev) =>
                      prev.map((x) =>
                        x.id === c.id
                          ? {
                              ...x,
                              inputs: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            }
                          : x,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1 text-[10px]"
                  onClick={() =>
                    onCellsChange((prev) =>
                      prev.map((x) =>
                        x.id === c.id ? { ...x, kind: x.kind === "md" ? "js" : "md" } : x,
                      ),
                    )
                  }
                >
                  {c.kind === "md" ? "→ JS" : "→ MD"}
                </button>
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1 text-[11px]"
                  onClick={() => onCellsChange((prev) => prev.filter((x) => x.id !== c.id))}
                >
                  Del
                </button>
                {c.kind === "js" ? (
                  <>
                    <button
                      type="button"
                      className="rounded border border-border bg-muted/15 px-2 py-1 text-[11px] disabled:opacity-40"
                      disabled={runBusy}
                      onClick={() => void runCell(c.id)}
                    >
                      Run cell
                    </button>
                    <button
                      type="button"
                      className="rounded border border-border px-2 py-1 text-[11px] disabled:opacity-40"
                      disabled={!runBusy}
                      onClick={stopRun}
                    >
                      Stop
                    </button>
                  </>
                ) : null}
              </div>
              {c.kind === "md" ? (
                <>
                  <textarea
                    className="mb-2 h-28 w-full resize-none rounded border border-border px-2 py-2 font-mono text-[11px] outline-none"
                    spellCheck={false}
                    value={c.body}
                    onChange={(e) =>
                      onCellsChange((prev) =>
                        prev.map((x) => (x.id === c.id ? { ...x, body: e.target.value } : x)),
                      )
                    }
                  />
                  <div className={mdPreviewClass}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, defaultSchema]]}>
                      {c.body}
                    </ReactMarkdown>
                  </div>
                </>
              ) : (
                <>
                  <NotebookCellEditor
                    value={c.body}
                    onChange={(body) =>
                      onCellsChange((prev) => prev.map((x) => (x.id === c.id ? { ...x, body } : x)))
                    }
                    completionCellNames={completionNames}
                    dark={resolvedDark}
                    onModEnter={() => void runCell(c.id)}
                  />
                  <div className="mt-2 rounded border border-border bg-muted/10 p-2.5">
                    <div className="mb-1 font-mono text-[10px] opacity-70">Output</div>
                    <div
                      ref={(el) => {
                        const m = cellOutputSlotRef.current;
                        if (el) m.set(c.id, el);
                        else m.delete(c.id);
                      }}
                      className="archon-notebook-output-root min-h-[4px] text-[11px]"
                    />
                    <p className="archon-notebook-output-hint mt-1.5 text-[10px] opacity-45">
                      Run this cell or Run all to show results here.
                    </p>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
