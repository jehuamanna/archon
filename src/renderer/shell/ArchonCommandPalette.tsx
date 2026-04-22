import React, { useEffect, useMemo, useRef } from "react";
import type { CommandContribution } from "./archon-contribution-registry";
import type { ArchonShellVm } from "./useArchonShell";

function label(c: CommandContribution): string {
  const cat = c.category?.trim();
  return cat ? `${cat}: ${c.title}` : c.title;
}

export function ArchonCommandPalette({ vm }: { vm: ArchonShellVm }): React.ReactElement | null {
  const { open, surface, query, setQuery, results, selectedIndex, setSelectedIndex, close, runSelected } =
    vm;

  const visible = open && surface === "palette";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!visible) return;
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [visible]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, results.length, visible]);

  const emptyHint = useMemo(() => {
    if (query.trim().length === 0) return "Type to search commands…";
    return results.length === 0 ? "No matching commands." : "";
  }, [query, results.length]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[50000] flex items-start justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // Click-away: only close when the dimmed backdrop itself is clicked.
        if (e.target === e.currentTarget) close();
      }}
      onTouchStart={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-[11px] font-semibold text-muted-foreground">Command palette</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            <span className="font-mono">Esc</span> to close
          </span>
        </div>
        <div className="px-3 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands…"
            className="w-full rounded-md border border-input bg-background px-2 py-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
              if (e.key === "Enter") {
                e.preventDefault();
                void runSelected();
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex(Math.min(results.length - 1, selectedIndex + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex(Math.max(0, selectedIndex - 1));
              }
            }}
          />
          {emptyHint ? (
            <div className="mt-2 text-[11px] text-muted-foreground">{emptyHint}</div>
          ) : null}
        </div>
        <div className="max-h-[55vh] overflow-auto border-t border-border">
          <ul className="divide-y divide-border">
            {results.slice(0, 80).map((c, idx) => {
              const active = idx === selectedIndex;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    ref={active ? activeItemRef : null}
                    className={`flex w-full items-start gap-3 px-3 py-2 text-left ${
                      active ? "bg-muted/60" : "hover:bg-muted/40"
                    }`}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => void runSelected()}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-foreground">{label(c)}</div>
                      {c.doc ? (
                        <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{c.doc}</div>
                      ) : null}
                    </div>
                    <div className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.id}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

