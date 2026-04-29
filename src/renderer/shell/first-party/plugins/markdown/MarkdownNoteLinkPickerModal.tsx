import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchWpnNoteLinkIndex,
  filterWpnNoteLinkRows,
  type WpnNoteLinkRow,
} from "./wpnNoteLinkIndex";

export interface MarkdownNoteLinkPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Omit from list (e.g. note linking to itself) */
  excludeNoteId?: string;
  onPick: (row: WpnNoteLinkRow) => void;
}

export function MarkdownNoteLinkPickerModal({
  open,
  onClose,
  excludeNoteId,
  onPick,
}: MarkdownNoteLinkPickerModalProps): React.ReactElement | null {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<WpnNoteLinkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchWpnNoteLinkIndex()
      .then(({ rows: list }) => {
        if (cancelled) return;
        setRows(list);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Could not load notes.");
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const ex = excludeNoteId?.trim();
    const base = ex ? rows.filter((r) => r.noteId !== ex) : rows;
    return filterWpnNoteLinkRows(base, query);
  }, [rows, query, excludeNoteId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Link to note"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[min(480px,70vh)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg">
        <div className="border-b border-border px-3 py-2.5">
          <p className="text-[13px] font-medium text-foreground">Link to note</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Search by title or path. Inserts a path-based link:{" "}
            <span className="font-mono text-[10px]">#/w/Project/Title</span>, or{" "}
            <span className="font-mono text-[10px]">./Title</span> when the target is in the same project.
          </p>
          <input
            ref={inputRef}
            type="search"
            className="mt-2 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter notes"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
          {loading ? (
            <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">Loading notes…</p>
          ) : error ? (
            <p className="px-2 py-6 text-center text-[12px] text-destructive">{error}</p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">No matching notes.</p>
          ) : (
            <ul className="space-y-0.5" role="listbox">
              {filtered.map((r) => (
                <li key={r.noteId} role="none">
                  <button
                    type="button"
                    role="option"
                    className="w-full rounded-md px-2 py-2 text-left text-[12px] outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      onPick(r);
                      onClose();
                    }}
                  >
                    <div className="font-medium text-foreground">{r.title}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{r.pathLabel}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted/60"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
