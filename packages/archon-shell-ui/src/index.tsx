import * as React from "react";

export type ShellCommandArgs = Record<string, unknown> | undefined;

export type ArchonShellApi = {
  commands: {
    invoke: (commandId: string, args?: ShellCommandArgs) => Promise<unknown> | unknown;
    list?: () => Promise<unknown>;
  };
  keymap?: {
    list: () => Promise<unknown>;
  };
  context?: {
    get?: () => unknown;
  };
};

/**
 * Minimal, stable "shell UI" primitives.
 * These are intentionally boring: plugins should compose these rather than
 * injecting arbitrary HTML into chrome regions.
 */

export function Panel(props: {
  title?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {props.title ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderBottom: "1px solid rgba(0,0,0,.08)",
            fontFamily: "ui-sans-serif, system-ui",
            fontSize: 12,
            fontWeight: 700,
            opacity: 0.85,
          }}
        >
          <div>{props.title}</div>
          <div style={{ marginLeft: "auto" }}>{props.right}</div>
        </div>
      ) : null}
      <div style={{ minHeight: 0, flex: 1 }}>{props.children}</div>
    </div>
  );
}

export function Button(props: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      style={{
        fontSize: 12,
        padding: "6px 10px",
        border: "1px solid rgba(0,0,0,.15)",
        background: "rgba(0,0,0,.02)",
        cursor: "pointer",
        borderRadius: 8,
      }}
    >
      {props.children}
    </button>
  );
}

export function Stack(props: {
  gap?: number;
  padding?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        padding: props.padding ?? 12,
        display: "flex",
        flexDirection: "column",
        gap: props.gap ?? 10,
        fontFamily: "ui-sans-serif, system-ui",
      }}
    >
      {props.children}
    </div>
  );
}

export function Mono(props: { children: React.ReactNode }): React.ReactElement {
  return (
    <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      {props.children}
    </span>
  );
}

/**
 * Convenience for iframe-based shell views (today’s mechanism).
 * If your view runs in an iframe and the host exposes `window.archon.shell`,
 * this reads it in a stable way.
 */
export function getArchonShellApi(): ArchonShellApi | null {
  const w = window as any;
  const api = w?.archon?.shell;
  if (!api) return null;
  return api as ArchonShellApi;
}

