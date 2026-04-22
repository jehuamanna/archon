import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ctxBtn } from "../../../../notes-sidebar/notes-sidebar-utils";
import { useToast } from "../../../../toast/ToastContext";

export type DocumentationLinkMenuModel = { x: number; y: number; url: string };

/**
 * Minimal context menu: copy a documentation deep-link URL (absolute) to the clipboard.
 */
export function DocumentationLinkContextMenu({
  open,
  onClose,
}: {
  open: DocumentationLinkMenuModel | null;
  onClose: () => void;
}): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const el = ref.current;
    const r = el.getBoundingClientRect();
    const pad = 6;
    let left = open.x;
    let top = open.y;
    if (left + r.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - r.width - pad);
    }
    if (top + r.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - r.height - pad);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[120] min-w-[220px] rounded-md border border-border bg-popover py-1 shadow-md"
      style={{ left: open.x, top: open.y }}
    >
      <button
        type="button"
        role="menuitem"
        className={ctxBtn}
        onClick={() => {
          void navigator.clipboard.writeText(open.url).then(
            () =>
              showToast({
                severity: "info",
                message: "Documentation link copied",
                mergeKey: "doc-link-copy",
              }),
            () => showToast({ severity: "error", message: "Could not copy link" }),
          );
          onClose();
        }}
      >
        Copy link
      </button>
    </div>,
    document.body,
  );
}
