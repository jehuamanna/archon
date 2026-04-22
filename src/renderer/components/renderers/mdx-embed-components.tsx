import { getArchon } from "../../../shared/archon-host-access";
import React from "react";
import {
  markdownInternalNoteHref,
  markdownVfsNoteHref,
  parseInternalMarkdownNoteLink,
} from "../../utils/markdown-internal-note-href";
import { relativeAssetPathFromArchonAssetUrl } from "../../../shared/archon-asset-path";
import { observableEmbedSrc } from "./observable-embed-url";
import { ARCHON_CMD_HREF } from "./useArchonMarkdownUiComponents";
import { useMdxShell } from "./mdx-shell-context";

export { observableEmbedSrc } from "./observable-embed-url";

const SAFE_IMG_SCHEMES = new Set(["https:", "http:", "data:", "blob:"]);

/**
 * Safe MDX image override.
 * - `archon-asset:` URLs are resolved via `getArchon().assetUrl` (uses `?root=` if present).
 * - External URLs are only allowed for https/http/data/blob schemes.
 * - All other schemes (file:, javascript:, etc.) render a blocked placeholder.
 */
export function MdxSafeImage({
  src,
  alt,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement>): React.ReactElement {
  const srcStr = String(src ?? "").trim();
  let resolvedSrc: string | null = null;

  if (srcStr.toLowerCase().startsWith("archon-asset:")) {
    try {
      const u = new URL(srcStr);
      const rel = relativeAssetPathFromArchonAssetUrl(u);
      if (rel) {
        const projectRoot = u.searchParams.get("root") ?? undefined;
        resolvedSrc =
          typeof window !== "undefined" && getArchon()?.assetUrl
            ? getArchon().assetUrl(rel, projectRoot)
            : null;
      }
    } catch {
      resolvedSrc = null;
    }
  } else if (srcStr) {
    try {
      const scheme = new URL(srcStr).protocol;
      resolvedSrc = SAFE_IMG_SCHEMES.has(scheme) ? srcStr : null;
    } catch {
      resolvedSrc = null;
    }
  }

  if (!resolvedSrc) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
        [image blocked: {(alt ?? srcStr) || "no src"}]
      </span>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/img-redundant-alt
    <img
      src={resolvedSrc}
      alt={alt ?? ""}
      loading="lazy"
      className="my-2 max-w-full rounded"
      {...rest}
    />
  );
}

/** Language label extracted from `className="language-xyz"` code elements. */
function langFromClassName(className?: string): string | null {
  if (!className) return null;
  const m = className.match(/\blanguage-(\w+)\b/);
  return m?.[1] ?? null;
}

/**
 * MDX pre/code block override with language badge.
 * Keeps plain monospace rendering but adds a subtle language label in the top-right corner.
 */
export function MdxCodeBlock({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLPreElement>): React.ReactElement {
  const codeEl = React.Children.toArray(children).find(
    (c: unknown): c is React.ReactElement =>
      React.isValidElement(c) && (c as React.ReactElement).type === "code",
  ) as React.ReactElement<React.HTMLAttributes<HTMLElement>> | undefined;

  const lang =
    langFromClassName(className) ??
    langFromClassName(codeEl?.props?.className ?? "") ??
    null;

  return (
    <div className="relative my-3">
      {lang ? (
        <span className="absolute right-2 top-1.5 select-none rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {lang}
        </span>
      ) : null}
      <pre
        className={`overflow-x-auto rounded-lg border border-border bg-muted/35 p-3 pr-${lang ? "16" : "3"} ${className ?? ""}`}
        {...rest}
      >
        {children}
      </pre>
    </div>
  );
}

export function ObservableEmbed({
  notebook,
  cell,
  title,
}: {
  notebook: string;
  cell?: string;
  title?: string;
}): React.ReactElement {
  const src = observableEmbedSrc(notebook, cell);
  if (!src) {
    return (
      <div className="my-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
        Invalid Observable notebook path (expected e.g. <code className="font-mono">@user/note-slug</code>).
      </div>
    );
  }
  return (
    <div className="my-4 w-full min-w-0 overflow-hidden rounded-lg border border-border bg-muted/20">
      <iframe
        title={title ?? `Observable: ${notebook}`}
        className="h-[min(560px,70vh)] w-full border-0"
        src={src}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}

/**
 * Renders an Observable notebook directly in the shell React tree using
 * `@observablehq/runtime` and `@observablehq/inspector` — no iframe required.
 *
 * Props:
 * - `notebook` — `@user/slug` or `user/slug`
 * - `cell` — optional cell name to render a single cell; omit to render all cells
 * - `title` — accessible label for the container
 *
 * The notebook ES module is fetched from `https://api.observablehq.com/`.
 * Network availability is required at render time.
 */
export function ObservableRuntimeEmbed({
  notebook,
  cell,
  title,
}: {
  notebook: string;
  cell?: string;
  title?: string;
}): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const nb = String(notebook ?? "").trim();
  const nbPath = nb.startsWith("@") ? nb.slice(1) : nb;

  React.useEffect(() => {
    if (!nbPath || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(nbPath)) {
      setStatus("error");
      setErrorMsg(`Invalid notebook path: "${notebook}"`);
      return;
    }

    const el = containerRef.current;
    if (!el) return;

    let runtime: { dispose(): void } | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const [{ Runtime }, { Inspector }, notebookMod] = await Promise.all([
          import("@observablehq/runtime"),
          import("@observablehq/inspector"),
          import(
            /* webpackIgnore: true */
            `https://api.observablehq.com/@${nbPath}.js?v=4`
          ) as Promise<{ default: unknown }>,
        ]);

        if (cancelled) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rt: any = new Runtime();
        runtime = rt as { dispose(): void };
        const define = notebookMod.default;

        if (cell) {
          const cellEl = document.createElement("div");
          el.appendChild(cellEl);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rt.module(define, (name: string) => (name === cell ? new (Inspector as any)(cellEl) : true));
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rt.module(define, (Inspector as any).into(el));
        }

        if (!cancelled) setStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      runtime?.dispose();
      el.innerHTML = "";
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nbPath, cell]);

  const label = title ?? `Observable: ${notebook}`;

  return (
    <div
      className="my-4 w-full min-w-0 overflow-hidden rounded-lg border border-border bg-muted/20"
      aria-label={label}
    >
      {status === "loading" && (
        <div className="px-3 py-4 text-[12px] text-muted-foreground">Loading {label}…</div>
      )}
      {status === "error" && (
        <div className="px-3 py-2 text-[12px] text-destructive">
          {errorMsg ?? "Failed to load Observable notebook."}
        </div>
      )}
      <div ref={containerRef} className="observable-runtime-cells p-2" />
    </div>
  );
}

export function DocLink({
  to,
  children,
}: {
  to: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const { onArchonCmdLink, onInternalNoteNavigate } = useMdxShell();
  const t = String(to ?? "").trim();
  const cmdPlain = t.match(/^command:([\w.]+)$/);
  if (cmdPlain?.[1] && onArchonCmdLink) {
    const commandId = cmdPlain[1];
    const href = `archon-cmd:${commandId}`;
    return (
      <a
        href={href}
        className="text-primary underline underline-offset-2"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onArchonCmdLink(commandId);
        }}
      >
        {children ?? commandId}
      </a>
    );
  }
  const archonCmd = t.match(ARCHON_CMD_HREF);
  if (archonCmd?.[1] && onArchonCmdLink) {
    const commandId = archonCmd[1];
    return (
      <a
        href={t}
        className="text-primary underline underline-offset-2"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onArchonCmdLink(commandId);
        }}
      >
        {children ?? commandId}
      </a>
    );
  }
  const internal = parseInternalMarkdownNoteLink(t);
  if (internal) {
    const canonical =
      internal.kind === "vfs"
        ? markdownVfsNoteHref(internal.vfsPath, internal.markdownHeadingSlug)
        : markdownInternalNoteHref(internal.noteId, internal.markdownHeadingSlug);
    const fallbackLabel =
      internal.kind === "vfs" ? internal.vfsPath.split("/").pop() ?? internal.vfsPath : internal.noteId;
    return (
      <a
        href={canonical}
        className="text-primary underline underline-offset-2"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (onInternalNoteNavigate) {
            onInternalNoteNavigate(internal);
            return;
          }
          if (typeof window !== "undefined" && window.location.hash !== canonical) {
            window.location.hash = canonical;
          }
        }}
      >
        {children ?? fallbackLabel}
      </a>
    );
  }
  return (
    <span className="text-[12px] text-muted-foreground">
      Invalid DocLink <code className="font-mono">{t}</code>
    </span>
  );
}

export function ArchonCallout({
  variant = "info",
  children,
}: {
  variant?: "info" | "warning";
  children?: React.ReactNode;
}): React.ReactElement {
  const border =
    variant === "warning" ? "border-amber-500/50 bg-amber-500/10" : "border-primary/30 bg-muted/40";
  return (
    <aside className={`my-4 rounded-md border px-3 py-2 text-[13px] leading-6 ${border}`}>
      {children}
    </aside>
  );
}

export function ArchonCard({
  title,
  children,
}: {
  title?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="my-4 rounded-lg border border-border bg-card p-3 shadow-sm">
      {title ? <div className="mb-2 text-[13px] font-semibold text-foreground">{title}</div> : null}
      <div className="text-[13px] leading-6">{children}</div>
    </div>
  );
}

export function ArchonButton({
  command,
  children,
}: {
  command: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const { onArchonCmdLink } = useMdxShell();
  const m = String(command ?? "").trim().match(ARCHON_CMD_HREF);
  const commandId = m?.[1];
  if (!commandId || !onArchonCmdLink) {
    return (
      <span className="text-[12px] text-muted-foreground">
        {commandId ? "Command links are not active here." : "Invalid ArchonButton command."}
      </span>
    );
  }
  const href = `archon-cmd:${commandId}`;
  return (
    <button
      type="button"
      className="rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-muted/60"
      onClick={() => onArchonCmdLink(commandId)}
    >
      {children ?? commandId}
    </button>
  );
}

/**
 * Renders static note metadata fields as inline text — safe for user-tier MDX
 * because no JS expressions are needed.
 *
 * `field` options: "title" | "id" | "type"
 *
 * Example: `<NoteContext field="title" />`
 */
export function NoteContext({
  field,
  fallback = "",
}: {
  field: "title" | "id" | "type";
  fallback?: string;
}): React.ReactElement {
  const { note } = useMdxShell();
  if (!note) {
    return <>{fallback}</>;
  }
  const value: string =
    field === "title"
      ? note.title ?? fallback
      : field === "id"
        ? note.id ?? fallback
        : note.type ?? fallback;
  return <>{value}</>;
}
