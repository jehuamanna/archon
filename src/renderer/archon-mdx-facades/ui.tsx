import React, { useState } from "react";

/** Primary button — Tailwind tokens only; use inside MDX via MDXProvider map or `import` (stripped). */
export function Button({
  children,
  variant = "default",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline";
}): React.ReactElement {
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors";
  const styles =
    variant === "outline"
      ? "border border-border bg-background text-foreground hover:bg-muted/50"
      : "bg-primary text-primary-foreground hover:bg-primary/90";
  return (
    <button type="button" className={`${base} ${styles}`} {...rest}>
      {children}
    </button>
  );
}

/** Inline status/label badge. variant: default | secondary | destructive | outline */
export function Badge({
  children,
  variant = "default",
}: {
  children?: React.ReactNode;
  variant?: "default" | "secondary" | "destructive" | "outline";
}): React.ReactElement {
  const styles: Record<string, string> = {
    default: "bg-primary text-primary-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    destructive: "bg-destructive/15 text-destructive",
    outline: "border border-border text-foreground",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[variant] ?? styles.default}`}
    >
      {children}
    </span>
  );
}

/** Horizontal or vertical visual divider. */
export function Separator({
  orientation = "horizontal",
}: {
  orientation?: "horizontal" | "vertical";
}): React.ReactElement {
  if (orientation === "vertical") {
    return <span className="mx-2 inline-block h-4 w-px bg-border align-middle" aria-hidden />;
  }
  return <hr className="my-4 border-t border-border" />;
}

/** Alert / callout block. variant: info | success | warning | destructive */
export function Alert({
  children,
  variant = "info",
  title,
}: {
  children?: React.ReactNode;
  variant?: "info" | "success" | "warning" | "destructive";
  title?: string;
}): React.ReactElement {
  const styles: Record<string, string> = {
    info: "border-primary/30 bg-primary/5 text-foreground",
    success: "border-green-500/40 bg-green-500/10 text-green-900 dark:text-green-200",
    warning: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
    destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  };
  return (
    <div
      className={`my-4 rounded-md border px-3 py-2.5 text-[13px] leading-6 ${styles[variant] ?? styles.info}`}
      role="alert"
    >
      {title ? <div className="mb-1 font-semibold">{title}</div> : null}
      {children}
    </div>
  );
}

const TabsContext = React.createContext<{
  active: string | undefined;
  setActive: (id: string) => void;
} | null>(null);

/** Tab container — wraps TabList and TabPanel children. defaultTab sets the initially visible panel id. */
export function Tabs({
  children,
  defaultTab,
}: {
  children?: React.ReactNode;
  defaultTab?: string;
}): React.ReactElement {
  const [active, setActive] = useState<string | undefined>(defaultTab);
  return (
    <TabsContext.Provider value={{ active, setActive }}>
      <div className="my-4">{children}</div>
    </TabsContext.Provider>
  );
}

/** Tab button strip. Place Tab children inside. */
export function TabList({ children }: { children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex border-b border-border" role="tablist">
      {children}
    </div>
  );
}

/** Individual tab trigger. id must match the corresponding TabPanel id. */
export function Tab({
  id = "",
  children,
}: {
  id?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const ctx = React.useContext(TabsContext);
  const isActive = ctx?.active === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={() => ctx?.setActive(id)}
      className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors ${
        isActive
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Self-contained disclosure — a labelled trigger button that toggles an inline callout.
 * No JS expressions needed; state is managed internally.
 *
 * Props:
 * - `label`   — button text (default "Show")
 * - `variant` — callout color: info | success | warning | destructive (default "info")
 * - `open`    — initial open state (default false)
 * - `children` — the content revealed when open
 *
 * Example: `<Disclosure label="Show details" variant="warning">Watch out!</Disclosure>`
 */
export function Disclosure({
  label = "Show",
  variant = "info",
  open: initialOpen = false,
  children,
}: {
  label?: string;
  variant?: "info" | "success" | "warning" | "destructive";
  open?: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  const [isOpen, setIsOpen] = React.useState(initialOpen);

  const calloutStyles: Record<string, string> = {
    info: "border-primary/30 bg-primary/5 text-foreground",
    success: "border-green-500/40 bg-green-500/10 text-green-900 dark:text-green-200",
    warning: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
    destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  };

  return (
    <div className="my-3">
      <button
        type="button"
        onClick={() => setIsOpen((v: boolean) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50"
        aria-expanded={isOpen}
      >
        <span
          className={`inline-block transition-transform text-[10px] ${isOpen ? "rotate-90" : ""}`}
          aria-hidden
        >
          ▶
        </span>
        {label}
      </button>
      {isOpen ? (
        <div
          className={`mt-2 rounded-md border px-3 py-2.5 text-[13px] leading-6 ${
            calloutStyles[variant] ?? calloutStyles.info
          }`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Content panel shown only when its id matches the active Tab. */
export function TabPanel({
  id = "",
  children,
}: {
  id?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const ctx = React.useContext(TabsContext);
  if (ctx?.active !== id) return <></>;
  return <div className="pt-3">{children}</div>;
}

/**
 * Self-contained counter with increment / decrement buttons.
 * No JS expressions needed.
 *
 * Props:
 * - `label`    — label shown above the counter (default "Count")
 * - `initial`  — starting value (default 0)
 * - `step`     — amount added/subtracted per click (default 1)
 * - `min`      — lower bound (optional)
 * - `max`      — upper bound (optional)
 *
 * Example: `<Counter label="Items" initial="0" step="1" min="0" max="10" />`
 */
export function Counter({
  label = "Count",
  initial = 0,
  step = 1,
  min,
  max,
}: {
  label?: string;
  initial?: number;
  step?: number;
  min?: number;
  max?: number;
}): React.ReactElement {
  const [count, setCount] = React.useState(Number(initial));
  const s = Number(step) || 1;

  const decrement = (): void => {
    setCount((c: number) => {
      const next = c - s;
      return min !== undefined ? Math.max(min, next) : next;
    });
  };
  const increment = (): void => {
    setCount((c: number) => {
      const next = c + s;
      return max !== undefined ? Math.min(max, next) : next;
    });
  };

  const atMin = min !== undefined && count <= min;
  const atMax = max !== undefined && count >= max;

  return (
    <div className="my-3 inline-flex flex-col items-start gap-1">
      {label ? (
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      ) : null}
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-1 py-1">
        <button
          type="button"
          onClick={decrement}
          disabled={atMin}
          className="flex h-7 w-7 items-center justify-center rounded text-[16px] font-bold text-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <span className="min-w-[2.5rem] text-center font-mono text-[14px] font-semibold tabular-nums">
          {count}
        </span>
        <button
          type="button"
          onClick={increment}
          disabled={atMax}
          className="flex h-7 w-7 items-center justify-center rounded text-[16px] font-bold text-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Increase ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * Self-contained labelled text input.
 * No JS expressions needed — all config via static string props.
 *
 * Props:
 * - `label`       — label above the field (default "Input")
 * - `placeholder` — placeholder text (default "Type here…")
 * - `initial`     — starting value (default "")
 * - `show`        — when "value", renders the live value below the input (default "none")
 * - `prefix`      — static prefix shown before the live value when show="value"
 *
 * Example: `<TextInput label="Your name" placeholder="Enter name" show="value" prefix="Hello, " />`
 */
export function TextInput({
  label = "Input",
  placeholder = "Type here…",
  initial = "",
  show = "none",
  prefix = "",
}: {
  label?: string;
  placeholder?: string;
  initial?: string;
  show?: "none" | "value";
  prefix?: string;
}): React.ReactElement {
  const [value, setValue] = React.useState(String(initial));

  return (
    <div className="my-3 flex flex-col gap-1.5">
      {label ? (
        <label className="text-[12px] font-medium text-muted-foreground">{label}</label>
      ) : null}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      {show === "value" && value ? (
        <span className="text-[13px] text-foreground">
          {prefix}
          <span className="font-medium">{value}</span>
        </span>
      ) : null}
    </div>
  );
}
