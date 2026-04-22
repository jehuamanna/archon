import React, { useLayoutEffect, useRef } from "react";

function normalizeSingleLine(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n/g, " ").replace(/\u00a0/g, " ");
}

function readFromEl(el: HTMLElement): string {
  return normalizeSingleLine(el.innerText ?? "");
}

export type InlineSingleLineEditableProps = {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel?: () => void;
  className?: string;
  autoFocus?: boolean;
  /** When false, blur does not call onCommit. Default true. */
  commitOnBlur?: boolean;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  "aria-label"?: string;
};

/**
 * Single-line in-place editing using contentEditable (matches NoteViewer title pattern).
 * Remount when the edited entity changes (use a stable `key` from the parent).
 */
export function InlineSingleLineEditable({
  value,
  onChange,
  onCommit,
  onCancel,
  className = "",
  autoFocus = true,
  commitOnBlur = true,
  onClick,
  "aria-label": ariaLabel,
}: InlineSingleLineEditableProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const initialRef = useRef(value);
  initialRef.current = value;
  const committedRef = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initialRef.current;
    if (!autoFocus) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialize DOM from open value once per mount
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const cur = readFromEl(el);
    if (cur !== value) {
      el.textContent = value;
    }
  }, [value]);

  const handleInput = () => {
    const el = ref.current;
    if (!el) return;
    onChange(readFromEl(el));
  };

  const handleBlur = () => {
    if (!commitOnBlur) return;
    if (committedRef.current) return;
    onCommit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      committedRef.current = true;
      onCommit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = normalizeSingleLine(e.clipboardData.getData("text/plain"));
    document.execCommand("insertText", false, text);
    handleInput();
  };

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="false"
      tabIndex={0}
      className={className}
      onInput={handleInput}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onClick={onClick}
    />
  );
}
