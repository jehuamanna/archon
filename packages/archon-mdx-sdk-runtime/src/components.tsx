import * as React from "react";
import { useProjectState, useNote } from "./hooks";

export interface InputProps {
  value: string;
  onChange: string;
  placeholder?: string;
}

export function Input(props: InputProps): React.ReactElement {
  const [text, setText] = useProjectState<string>(props.onChange, "");
  const [bound] = useProjectState<string>(props.value, "");
  const current = props.value === props.onChange ? text : bound;
  return React.createElement("input", {
    type: "text",
    value: current ?? "",
    placeholder: props.placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value),
  });
}

export interface SelectProps {
  options: string; // comma-separated per propSpec
  value: string;
  onChange: string;
}

export function Select(props: SelectProps): React.ReactElement {
  const opts = (props.options ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const [v, setV] = useProjectState<string>(props.onChange, opts[0] ?? "");
  return React.createElement(
    "select",
    {
      value: v ?? "",
      onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setV(e.target.value),
    },
    opts.map((opt) => React.createElement("option", { key: opt, value: opt }, opt)),
  );
}

export interface CheckboxProps {
  label: string;
  value: string;
  onChange: string;
}

export function Checkbox(props: CheckboxProps): React.ReactElement {
  const [checked, setChecked] = useProjectState<boolean>(props.onChange, false);
  return React.createElement(
    "label",
    null,
    React.createElement("input", {
      type: "checkbox",
      checked: !!checked,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setChecked(e.target.checked),
    }),
    " ",
    props.label,
  );
}

export interface ButtonProps {
  label: string;
  onClick?: string;
}

export function Button(props: ButtonProps): React.ReactElement {
  const [count, setCount] = useProjectState<number>(props.onClick ?? "__unbound", 0);
  const handler = (): void => {
    if (props.onClick) setCount((v) => (v ?? 0) + 1);
  };
  return React.createElement(
    "button",
    { type: "button", onClick: handler, "data-count": count ?? 0 },
    props.label,
  );
}

export interface FormProps {
  submit: string;
  children?: React.ReactNode;
}

export function Form(props: FormProps): React.ReactElement {
  const [, setSubmission] = useProjectState<{ submittedAt: number }>(
    props.submit,
    { submittedAt: 0 },
  );
  return React.createElement(
    "form",
    {
      onSubmit: (e: React.FormEvent) => {
        e.preventDefault();
        setSubmission({ submittedAt: Date.now() });
      },
    },
    props.children,
  );
}

export interface ListProps {
  stateKey: string;
  item?: string;
}

export function List(props: ListProps): React.ReactElement {
  const [items] = useProjectState<unknown[]>(props.stateKey, []);
  const template = props.item ?? "{title}";
  return React.createElement(
    "ul",
    null,
    (items ?? []).map((it, idx) => {
      const text = interpolate(template, it);
      return React.createElement("li", { key: idx }, text);
    }),
  );
}

function interpolate(template: string, ctx: unknown): string {
  if (ctx === null || ctx === undefined) return template;
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, name: string) => {
    if (typeof ctx !== "object") return String(ctx);
    const v = (ctx as Record<string, unknown>)[name];
    return v === undefined || v === null ? "" : String(v);
  });
}

export interface TableProps {
  stateKey: string;
  columns: string; // comma-separated
}

export function Table(props: TableProps): React.ReactElement {
  const [rows] = useProjectState<Record<string, unknown>[]>(props.stateKey, []);
  const cols = (props.columns ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return React.createElement(
    "table",
    null,
    React.createElement(
      "thead",
      null,
      React.createElement(
        "tr",
        null,
        cols.map((c) => React.createElement("th", { key: c }, c)),
      ),
    ),
    React.createElement(
      "tbody",
      null,
      (rows ?? []).map((row, i) =>
        React.createElement(
          "tr",
          { key: i },
          cols.map((c) =>
            React.createElement(
              "td",
              { key: c },
              row[c] === undefined || row[c] === null ? "" : String(row[c]),
            ),
          ),
        ),
      ),
    ),
  );
}

export interface ChartProps {
  stateKey: string;
  kind: "bar" | "line" | "pie";
}

export function Chart(props: ChartProps): React.ReactElement {
  const [data] = useProjectState<number[]>(props.stateKey, []);
  const series = Array.isArray(data) ? data : [];
  return React.createElement(
    "div",
    { style: { display: "flex", gap: "4px", alignItems: "flex-end" } },
    series.map((v, i) =>
      React.createElement("span", {
        key: i,
        style: {
          width: "8px",
          height: `${Math.max(1, v ?? 0)}px`,
          background: "#4b5",
          display: "inline-block",
        },
        title: `${v}`,
      }),
    ),
  );
}

export interface NoteEmbedProps {
  id?: string;
  title?: string;
}

export function NoteEmbed(props: NoteEmbedProps): React.ReactElement {
  const ref = props.id ?? props.title ?? "";
  const { source, loading, error } = useNote(ref);
  if (loading) return React.createElement("div", null, "Loading…");
  if (error) return React.createElement("div", { role: "alert" }, String(error));
  return React.createElement(Markdown, { source });
}

export interface ValueProps {
  stateKey: string;
  fallback?: string;
}

/** Render the current value of a project-state key. */
export function Value(props: ValueProps): React.ReactElement {
  const [v] = useProjectState<unknown>(props.stateKey);
  if (v === undefined || v === null) {
    return React.createElement(React.Fragment, null, props.fallback ?? "");
  }
  const text = typeof v === "object" ? JSON.stringify(v) : String(v);
  return React.createElement(React.Fragment, null, text);
}

export interface PushButtonProps {
  label: string;
  /** State key whose current value is appended (defaults to a literal if given). */
  fromKey?: string;
  value?: string;
  /** Array state key to append to. Created as [] if missing. */
  toKey: string;
  /** When true, the fromKey is cleared after the push. */
  clearFrom?: boolean;
}

/**
 * Append-to-array button. Reads `fromKey` (or the static `value`) and pushes
 * it onto the array at `toKey`. Handy for "add task" / "add attendee" flows
 * that `<Button onClick>` (which only increments a counter) can't express.
 */
export function PushButton(props: PushButtonProps): React.ReactElement {
  const [source, setSource] = useProjectState<string>(
    props.fromKey ?? "__pushbutton_unbound",
    "",
  );
  const [list, setList] = useProjectState<unknown[]>(props.toKey, []);
  const onClick = (): void => {
    const payload =
      props.fromKey && typeof source === "string" && source.length > 0
        ? source
        : props.value ?? "";
    if (payload === "" && !props.fromKey && !props.value) return;
    setList((prev) => [...(prev ?? []), payload]);
    if (props.clearFrom && props.fromKey) setSource("");
  };
  return React.createElement(
    "button",
    { type: "button", onClick },
    props.label,
  );
}

export interface CodeProps {
  value: string;
  onChange: string;
  language?: "markdown" | "javascript" | "typescript" | "json" | "plain";
  placeholder?: string;
  readOnly?: boolean;
}

/**
 * `<Code>` — CodeMirror editor in the Electron renderer; the web runtime
 * here ships a minimal `<textarea>` fallback (no codemirror bundle in web)
 * so mini-app notes that use `<Code>` still work end-to-end.
 */
export function Code(props: CodeProps): React.ReactElement {
  const boundKey = props.onChange ?? props.value;
  const [v, setV] = useProjectState<string>(boundKey, "");
  return React.createElement("textarea", {
    value: typeof v === "string" ? v : "",
    placeholder: props.placeholder,
    readOnly: !!props.readOnly,
    spellCheck: false,
    "data-archon-code-language": props.language ?? "markdown",
    rows: 12,
    style: { fontFamily: "ui-monospace, monospace", width: "100%" },
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setV(e.target.value),
  });
}

export interface SlideshowProps {
  value?: string;
  onChange?: string;
  noteId?: string;
  noteTitle?: string;
  indexKey?: string;
  placeholder?: string;
  separator?: "hr" | "h1";
}

function splitSlides(src: string, sep: "hr" | "h1"): string[] {
  const text = String(src ?? "");
  if (sep === "h1") {
    const parts = text.split(/^(?=# )/m).map((p) => p.replace(/\s+$/, ""));
    const out = parts.filter((p) => p.trim().length > 0);
    return out.length > 0 ? out : [text.trim()];
  }
  const parts = text.split(/^[ \t]*-{3,}[ \t]*$/m).map((p) => p.trim());
  const out = parts.filter((p) => p.length > 0);
  return out.length > 0 ? out : [text.trim()];
}

/**
 * `<Slideshow>` web-runtime fallback. The Electron renderer wires this to
 * CodeMirror + react-markdown; here we ship a textarea for editing and a
 * `<pre>` block for presenting so the navigation flow still works without
 * a markdown bundle in the web app.
 */
export function Slideshow(props: SlideshowProps): React.ReactElement {
  const boundKey = props.onChange ?? props.value ?? "";
  // External-note mode: when `noteId` or `noteTitle` is set, the deck source
  // is read-only and fetched from the source note (mirrors NoteEmbed). The
  // Edit toggle is hidden; users edit by opening the source note directly.
  const externalRef = props.noteId ?? props.noteTitle ?? "";
  const isExternal = externalRef.length > 0;
  const externalNote = useNote(isExternal ? externalRef : "");
  const [src, setSrc] = useProjectState<string>(
    isExternal ? "__slideshow_external_unused" : boundKey,
    "",
  );
  const effectiveSrc = isExternal ? externalNote.source : src;
  const sep: "hr" | "h1" = props.separator === "h1" ? "h1" : "hr";
  const slides = splitSlides(
    typeof effectiveSrc === "string" ? effectiveSrc : "",
    sep,
  );
  // Persist Edit/Present mode per-deck so reopens remember the last view.
  // External decks are forced to present mode.
  const modeKey = boundKey ? `${boundKey}__mode` : "__slideshow_mode_unbound";
  const [storedMode, setStoredMode] = useProjectState<"edit" | "present">(
    modeKey,
    "edit",
  );
  const mode: "edit" | "present" = isExternal
    ? "present"
    : storedMode === "present"
      ? "present"
      : "edit";
  const setMode = (next: "edit" | "present"): void => {
    if (isExternal) return;
    setStoredMode(next);
  };
  const [persistedIdx, setPersistedIdx] = useProjectState<number>(
    props.indexKey ?? "__slideshow_unbound_idx",
    0,
  );
  const [localIdx, setLocalIdx] = React.useState<number>(0);
  const rawIdx = props.indexKey ? persistedIdx ?? 0 : localIdx;
  const idx = Math.max(0, Math.min(slides.length - 1, rawIdx | 0));
  const setIdx = (n: number): void => {
    const clamped = Math.max(0, Math.min(slides.length - 1, n));
    if (props.indexKey) setPersistedIdx(clamped);
    else setLocalIdx(clamped);
  };

  const toolbarChildren: React.ReactNode[] = [];
  if (!isExternal) {
    toolbarChildren.push(
      React.createElement(
        "button",
        {
          key: "edit",
          type: "button",
          onClick: () => setMode("edit"),
          disabled: mode === "edit",
        },
        "Edit",
      ),
      React.createElement(
        "button",
        {
          key: "present",
          type: "button",
          onClick: () => setMode("present"),
          disabled: mode === "present",
        },
        "Present",
      ),
    );
  } else {
    toolbarChildren.push(
      React.createElement(
        "span",
        {
          key: "ext",
          style: { fontSize: 11, textTransform: "uppercase", color: "#666" },
        },
        "External note",
      ),
    );
  }
  if (mode === "present") {
    toolbarChildren.push(
      React.createElement(
        "span",
        { key: "count", style: { marginLeft: "auto", fontSize: 12 } },
        `Slide ${idx + 1} of ${slides.length}`,
      ),
    );
  }
  const externalLoading = isExternal && externalNote.loading;
  const externalError = isExternal && externalNote.error;
  return React.createElement(
    "div",
    { style: { border: "1px solid #ccc", borderRadius: 4, margin: "12px 0" } },
    React.createElement(
      "div",
      {
        style: {
          display: "flex",
          gap: 6,
          padding: 6,
          borderBottom: "1px solid #eee",
        },
      },
      ...toolbarChildren,
    ),
    externalLoading
      ? React.createElement(
          "div",
          { style: { padding: 12, fontSize: 12, color: "#666" } },
          "Loading deck…",
        )
      : externalError
        ? React.createElement(
            "div",
            {
              role: "alert",
              style: { padding: 12, fontSize: 12, color: "#b91c1c" },
            },
            `Slideshow error: ${String(externalNote.error)}`,
          )
        : mode === "edit"
      ? React.createElement("textarea", {
          value: typeof src === "string" ? src : "",
          placeholder: props.placeholder,
          rows: 12,
          spellCheck: false,
          style: { width: "100%", fontFamily: "ui-monospace, monospace", border: 0, padding: 8 },
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setSrc(e.target.value),
        })
      : React.createElement(
          "div",
          { style: { padding: 12 } },
          React.createElement(
            "pre",
            { style: { whiteSpace: "pre-wrap", margin: 0, minHeight: 120 } },
            slides[idx] ?? "",
          ),
          React.createElement(
            "div",
            { style: { display: "flex", justifyContent: "space-between", marginTop: 8 } },
            React.createElement(
              "button",
              { type: "button", onClick: () => setIdx(idx - 1), disabled: idx <= 0 },
              "◀ Prev",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                onClick: () => setIdx(idx + 1),
                disabled: idx >= slides.length - 1,
              },
              "Next ▶",
            ),
          ),
        ),
  );
}

export interface MarkdownProps {
  source: string;
}

/** Minimal markdown-like block: paragraphs only. Real sanitized renderer supplied by host. */
export function Markdown(props: MarkdownProps): React.ReactElement {
  const paragraphs = String(props.source ?? "").split(/\n{2,}/);
  return React.createElement(
    "div",
    null,
    paragraphs.map((p, i) => React.createElement("p", { key: i }, p)),
  );
}
