import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { WpnNoteLinkRow } from "./wpnNoteLinkIndex";

export interface MarkdownNoteLinkAutocompletePopoverProps {
  open: boolean;
  anchorRect: DOMRect | null;
  loading: boolean;
  error: string | null;
  rows: readonly WpnNoteLinkRow[];
  selectedIndex: number;
  onSelect: (row: WpnNoteLinkRow) => void;
}

export function MarkdownNoteLinkAutocompletePopover({
  open,
  anchorRect,
  loading,
  error,
  rows,
  selectedIndex,
  onSelect,
}: MarkdownNoteLinkAutocompletePopoverProps): React.ReactElement | null {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-wiki-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex]);

  if (!open || !anchorRect) {
    return null;
  }

  const top = Math.min(anchorRect.bottom + 4, window.innerHeight - 8);
  const maxH = Math.min(280, window.innerHeight - top - 12);

  return createPortal(
    <div
      className="fixed z-[95] rounded-md border border-border bg-background shadow-md"
      style={{
        left: anchorRect.left,
        top,
        width: Math.max(240, anchorRect.width),
        maxHeight: maxH,
      }}
      role="listbox"
      aria-label="Note link suggestions"
    >
      <div className="max-h-[inherit] overflow-y-auto py-1">
        {loading ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">Loading notes…</p>
        ) : error ? (
          <p className="px-2 py-3 text-center text-[11px] text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">No matching notes.</p>
        ) : (
          <ul ref={listRef} className="space-y-0.5">
            {rows.map((r, i) => (
              <li key={r.noteId}>
                <button
                  type="button"
                  data-wiki-idx={i}
                  role="option"
                  aria-selected={i === selectedIndex}
                  className={`w-full px-2 py-1.5 text-left text-[11px] outline-none ${
                    i === selectedIndex ? "bg-muted/70" : "hover:bg-muted/40"
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSelect(r)}
                >
                  <div className="font-medium text-foreground">{r.title}</div>
                  <div className="mt-0.5 font-mono text-[9px] leading-tight text-muted-foreground">
                    {r.pathLabel}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
