import React, { useEffect, useMemo, useRef, useState } from "react";
import { evalInSandbox, type EvalResult } from "./scriptHost";

export const ARCHON_REPL_TOGGLE_EVENT = "archon-repl-toggle";

type Line =
  | { kind: "in"; text: string }
  | { kind: "out"; text: string }
  | { kind: "err"; text: string }
  | { kind: "log"; text: string };

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function ArchonReplOverlay(): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string>(`// Examples:\n// const ids = await plugins.listInstalled();\n// await plugins.disable(ids[0]);\n// ids\n`);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onToggle = () => setOpen((o) => !o);
    window.addEventListener(ARCHON_REPL_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(ARCHON_REPL_TOGGLE_EVENT, onToggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const headerHint = useMemo(
    () =>
      `Sandboxed JS (no window/DOM). Available: plugins.*  — toggle via command palette.`,
    [],
  );

  const run = async () => {
    const src = code.trim();
    if (!src || busy) return;
    setBusy(true);
    setLines((prev) => [...prev, { kind: "in", text: src }]);
    try {
      const r: EvalResult = await evalInSandbox(src);
      for (const l of r.logs) {
        setLines((prev) => [...prev, { kind: "log", text: l }]);
      }
      if (r.ok) {
        setLines((prev) => [...prev, { kind: "out", text: formatValue(r.value) }]);
      } else {
        setLines((prev) => [...prev, { kind: "err", text: r.error }]);
      }
    } catch (e) {
      setLines((prev) => [
        ...prev,
        { kind: "err", text: e instanceof Error ? e.message : "Eval failed" },
      ]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[50020] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true">
      <div className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-foreground">REPL</div>
            <div className="truncate text-[10px] text-muted-foreground">{headerHint}</div>
          </div>
          <button
            type="button"
            className="archon-btn-neutral rounded-md px-2.5 py-1.5 text-[12px] font-semibold"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? "Running…" : "Run"}
          </button>
          <button
            type="button"
            className="archon-btn-neutral rounded-md px-2.5 py-1.5 text-[12px] font-semibold"
            onClick={() => setLines([])}
          >
            Clear
          </button>
          <button
            type="button"
            className="archon-btn-neutral-strong rounded-md px-2.5 py-1.5 text-[12px] font-semibold"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-2">
          <div className="min-h-0 border-r border-border p-3">
            <textarea
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-full w-full resize-none rounded-md border border-input bg-background p-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              spellCheck={false}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void run();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
            />
            <div className="mt-2 text-[10px] text-muted-foreground">
              <span className="font-mono">Ctrl+Enter</span> to run.{" "}
              <span className="font-mono">Esc</span> to close.
            </div>
          </div>
          <div className="min-h-0 overflow-auto p-3">
            <div className="space-y-2">
              {lines.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">
                  Output will appear here.
                </div>
              ) : null}
              {lines.map((l, i) => (
                <pre
                  key={i}
                  className={`whitespace-pre-wrap break-words rounded-md border border-border/60 p-2 font-mono text-[11px] ${
                    l.kind === "in"
                      ? "bg-muted/30 text-foreground"
                      : l.kind === "out"
                        ? "bg-muted/10 text-foreground"
                        : l.kind === "log"
                          ? "bg-muted/20 text-muted-foreground"
                          : "bg-muted/20 text-red-600 dark:text-red-400"
                  }`}
                >
                  {l.text}
                </pre>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

