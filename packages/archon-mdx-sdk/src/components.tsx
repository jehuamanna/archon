import * as React from "react";
import { useProjectState, useNote } from "./hooks.js";

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
