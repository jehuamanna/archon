/**
 * Renderer-side facade for `@archon/mdx-sdk` imports inside MDX mini-app notes.
 *
 * Imports are stripped by `remark-archon-mdx-facade-imports.ts`; the tag names
 * that authors use (`Input`, `Value`, `PushButton`, `List`, `Table`, `Chart`,
 * `NoteEmbed`, `Markdown`, `Button`, `Select`, `Checkbox`, `Form`) resolve
 * through the MDXProvider component map returned by
 * `getArchonMdxFacadeComponentMap`.
 *
 * State is persisted per project via the sync-api routes in
 * `apps/archon-sync-api/src/mdx-state/routes.ts`:
 *   GET /projects/:projectId/mdx-state/:key  →  { value, version }
 *   PUT /projects/:projectId/mdx-state/:key  with If-Match and JSON body
 *
 * Live cross-tab sync uses HTTP polling (2 s) in v1 — the WebSocket endpoint
 * from phase 4 requires an upgrade-capable transport that Next's `app.inject`
 * can't provide. When the WS endpoint is exposed directly (e.g. by the
 * standalone sync-api on :4010), the polling fallback can be swapped for
 * WebSocket without touching MDX authors.
 */
import React from "react";
import { createSyncBaseUrlResolver } from "@archon/platform";
import { useMdxShell } from "../components/renderers/mdx-shell-context";
import { readCloudSyncToken } from "../cloud-sync/cloud-sync-storage";

const POLL_MS = 2000;
const WRITE_DEBOUNCE_MS = 50;

/**
 * Module-scoped in-flight map for mdx-state GETs keyed by URL. Multiple
 * `useProjectState` hook instances watching the same (projectId, key) share
 * one HTTP request; each instance still applies the result to its own
 * React state. Without this, two components using the same key (or
 * StrictMode double-mount) each fire their own concurrent fetch.
 */
type MdxStateBody = {
  value: unknown | null;
  version: number;
  mode?: "inline" | "chunked" | "absent";
};
type MdxStateReadResult =
  | { kind: "ok"; body: MdxStateBody }
  | { kind: "absent" }
  | { kind: "error"; status: number };

const mdxStateReadInFlight = new Map<string, Promise<MdxStateReadResult>>();

/** Hard ceiling so a pathologically slow fetch cannot pin the dedupe slot. */
const MDX_STATE_READ_TIMEOUT_MS = 10_000;

async function sharedMdxStateRead(url: string): Promise<MdxStateReadResult> {
  const existing = mdxStateReadInFlight.get(url);
  if (existing) return existing;
  const task = (async (): Promise<MdxStateReadResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MDX_STATE_READ_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { ...authHeaders() },
        credentials: "omit",
        signal: controller.signal,
      });
      if (res.status === 404) return { kind: "absent" };
      if (!res.ok) return { kind: "error", status: res.status };
      const body = (await res.json()) as MdxStateBody;
      return { kind: "ok", body };
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        return { kind: "error", status: 0 };
      }
      throw e;
    } finally {
      clearTimeout(timer);
      mdxStateReadInFlight.delete(url);
    }
  })();
  mdxStateReadInFlight.set(url, task);
  return task;
}

// Canonical renderer-side pattern — see upload-image-asset.ts:13 for prior art.
// `getAccessToken()` in auth-session.ts is a *different* token surface and is
// not populated in web mode; using it here was the reason every HTTP call
// returned silently before.
const resolveSyncBase = createSyncBaseUrlResolver();

function syncBase(): string {
  const b = resolveSyncBase().trim().replace(/\/$/, "");
  return b || "/api/v1";
}

function authHeaders(): Record<string, string> {
  const token = readCloudSyncToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * The `Note` type exposed to MDX via `MdxShellContext` doesn't carry
 * `project_id` (see `src/shared/plugin-api.ts`). Resolve it lazily from
 * `GET /wpn/notes-with-context` — the same endpoint used by image-notes
 * for noteId→project lookup (see upload-image-asset.ts:55). Cached by
 * noteId at module scope so we make one fetch per note per session.
 */
const projectIdCache = new Map<string, string | null>();
const projectIdInFlight = new Map<string, Promise<string | null>>();

async function resolveProjectIdFor(noteId: string): Promise<string | null> {
  const cached = projectIdCache.get(noteId);
  if (cached !== undefined) return cached;
  const pending = projectIdInFlight.get(noteId);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const res = await fetch(`${syncBase()}/wpn/notes-with-context`, {
        method: "GET",
        headers: authHeaders(),
        credentials: "omit",
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[mdx-sdk] notes-with-context → ${res.status}`);
        projectIdCache.set(noteId, null);
        return null;
      }
      const body = (await res.json()) as {
        notes?: { id: string; project_id: string }[];
      };
      const hit = (body.notes ?? []).find((n) => n.id === noteId);
      const pid = hit?.project_id ?? null;
      projectIdCache.set(noteId, pid);
      if (!pid) {
        // eslint-disable-next-line no-console
        console.warn(`[mdx-sdk] note ${noteId} not found in current scope`);
      }
      return pid;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[mdx-sdk] notes-with-context threw:", e);
      projectIdCache.set(noteId, null);
      return null;
    } finally {
      projectIdInFlight.delete(noteId);
    }
  })();
  projectIdInFlight.set(noteId, promise);
  return promise;
}

function useProjectId(): string | null {
  const shell = useMdxShell();
  // The renderer may pass a WpnNote (has project_id) or a plugin-api Note (doesn't).
  // Try the direct field first — it's free.
  const direct = (shell as unknown as { note?: { project_id?: string } }).note?.project_id;
  const noteId = shell.note?.id;
  const [pid, setPid] = React.useState<string | null>(() => {
    if (typeof direct === "string" && direct.length > 0) return direct;
    if (noteId) return projectIdCache.get(noteId) ?? null;
    return null;
  });

  React.useEffect(() => {
    if (typeof direct === "string" && direct.length > 0) {
      setPid(direct);
      return;
    }
    if (!noteId) {
      setPid(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const resolved = await resolveProjectIdFor(noteId);
      if (!cancelled) setPid(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [direct, noteId]);

  return pid;
}

/** Keys that are intentionally unbound — skip network entirely, use local state only. */
function isUnboundKey(key: string): boolean {
  return key === "" || key.startsWith("__");
}

/**
 * Per-(projectId, key) state hook.
 *
 * Design notes — why this is more than a naive fetch/poll:
 *
 * 1. While the user is typing, local state is authoritative. GET polls
 *    never clobber a "dirty" (locally-modified) value; they only update
 *    `versionRef` in the background so the next PUT has a fresh
 *    `If-Match`. Without this the 2-second poll would erase typing that
 *    hadn't been PUT-acknowledged yet.
 *
 * 2. Writes are strictly serialized via `inFlightRef`. A second keystroke
 *    while a PUT is in flight sets `queuedRef` rather than firing a second
 *    overlapping PUT with a stale `If-Match`. This prevents the 409 storm
 *    we observed: two concurrent PUTs both sending `If-Match: 0`, the
 *    second 409'ing, its handler re-fetching and wiping the user's
 *    in-progress text.
 *
 * 3. On 409, we refetch to sync `versionRef` but we DO NOT overwrite the
 *    local value. `dirtyRef` stays true, and the drain loop fires another
 *    PUT with the updated version + the user's current local value.
 *
 * 4. While a write is pending or in flight, GET polls are suppressed —
 *    there's nothing for the server to tell us that our local value
 *    doesn't already know.
 */
function useProjectState<T>(
  key: string,
  initial?: T,
): [T | undefined, (next: T | ((prev: T | undefined) => T)) => void, { loading: boolean; error?: string }] {
  const projectId = useProjectId();
  const [value, setValue] = React.useState<T | undefined>(initial);
  const [loading, setLoading] = React.useState<boolean>(!isUnboundKey(key));
  const [error, setError] = React.useState<string | undefined>(undefined);

  const versionRef = React.useRef<number>(0);
  const dirtyRef = React.useRef<boolean>(false);
  const latestRef = React.useRef<T | undefined>(initial);
  const inFlightRef = React.useRef<Promise<void> | null>(null);
  const queuedRef = React.useRef<boolean>(false);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pin `initial` so callers passing fresh object/array literals per render
  // don't destabilize `read`'s identity and re-trigger the polling effect.
  const initialRef = React.useRef<T | undefined>(initial);
  initialRef.current = initial;
  const readInFlightRef = React.useRef<Promise<void> | null>(null);

  const unbound = isUnboundKey(key);

  const putUrl = React.useMemo(
    () =>
      projectId && !unbound
        ? `${syncBase()}/projects/${encodeURIComponent(projectId)}/mdx-state/${encodeURIComponent(key)}`
        : null,
    [projectId, key, unbound],
  );

  const read = React.useCallback(async (): Promise<void> => {
    if (!putUrl || unbound) return;
    // Suppress reads when a write is in-flight (the write already reflects the
    // latest truth) or when this hook's own previous read is still running.
    if (inFlightRef.current) return;
    if (readInFlightRef.current) return readInFlightRef.current;
    // Never overwrite local state if the user has pending edits.
    const skipLocalUpdate = dirtyRef.current;
    const currentInitial = initialRef.current;
    const applyResult = async (): Promise<void> => {
      try {
        const result = await sharedMdxStateRead(putUrl);
        if (result.kind === "absent") {
          if (!skipLocalUpdate) {
            versionRef.current = 0;
            if (currentInitial !== undefined) setValue(currentInitial);
          }
          setLoading(false);
          return;
        }
        if (result.kind === "error") {
          setError(`GET ${result.status}`);
          setLoading(false);
          // eslint-disable-next-line no-console
          console.warn(`[mdx-sdk] GET ${key} → ${result.status}`);
          return;
        }
        const body = result.body;
        const absent =
          body.mode === "absent" || (body.value === null && body.version === 0);
        if (absent) {
          if (!skipLocalUpdate) {
            versionRef.current = 0;
            if (currentInitial !== undefined) setValue(currentInitial);
          }
        } else if (body.version >= versionRef.current) {
          versionRef.current = body.version;
          if (!skipLocalUpdate) {
            setValue(body.value as T);
          }
        }
        setError(undefined);
        setLoading(false);
      } catch (e) {
        setError((e as Error).message);
        setLoading(false);
        // eslint-disable-next-line no-console
        console.warn(`[mdx-sdk] GET ${key} threw:`, e);
      }
    };
    const task = applyResult();
    readInFlightRef.current = task;
    try {
      await task;
    } finally {
      readInFlightRef.current = null;
    }
  }, [putUrl, key, unbound]);

  const drainWrites = React.useCallback(async (): Promise<void> => {
    if (!putUrl) return;
    while (dirtyRef.current) {
      dirtyRef.current = false;
      const snapshot = latestRef.current;
      const expectedVersion = versionRef.current;
      try {
        const res = await fetch(putUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": String(expectedVersion),
            ...authHeaders(),
          },
          credentials: "omit",
          body: JSON.stringify({ value: snapshot }),
        });
        if (res.status === 200) {
          const body = (await res.json()) as { version: number };
          versionRef.current = body.version;
          setError(undefined);
          continue;
        }
        if (res.status === 409) {
          // Sync versionRef from server; keep local value; re-dirty so the
          // loop retries with the new version.
          try {
            const body = (await res.json()) as { currentVersion?: number };
            if (typeof body.currentVersion === "number") {
              versionRef.current = body.currentVersion;
            } else {
              await read();
            }
          } catch {
            await read();
          }
          dirtyRef.current = true;
          continue;
        }
        if (res.status === 429) {
          setError("rate limit — slow down");
          // Brief backoff before giving up this drain cycle; next edit retries.
          await new Promise((r) => setTimeout(r, 250));
          return;
        }
        if (res.status === 413) {
          setError("value too large");
          return;
        }
        setError(`PUT ${res.status}`);
        // eslint-disable-next-line no-console
        console.warn(`[mdx-sdk] PUT ${key} → ${res.status}`);
        return;
      } catch (e) {
        setError((e as Error).message);
        // eslint-disable-next-line no-console
        console.warn(`[mdx-sdk] PUT ${key} threw:`, e);
        return;
      }
    }
  }, [putUrl, key, read]);

  const kickDrain = React.useCallback((): void => {
    if (!putUrl) return;
    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }
    const promise = (async () => {
      do {
        queuedRef.current = false;
        await drainWrites();
      } while (queuedRef.current && dirtyRef.current);
    })();
    inFlightRef.current = promise;
    void promise.finally(() => {
      inFlightRef.current = null;
    });
  }, [putUrl, drainWrites]);

  React.useEffect(() => {
    if (unbound) {
      setLoading(false);
      return;
    }
    if (!projectId) return;
    void read();
    const id = setInterval(() => {
      // Suppressed by `read` internally when dirtyRef / inFlightRef is set.
      void read();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [read, projectId, unbound]);

  const write = React.useCallback<(n: T | ((prev: T | undefined) => T)) => void>(
    (next) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T | undefined) => T)(prev) : next;
        latestRef.current = resolved;
        if (unbound || !putUrl) return resolved;
        dirtyRef.current = true;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          kickDrain();
        }, WRITE_DEBOUNCE_MS);
        return resolved;
      });
    },
    [unbound, putUrl, kickDrain],
  );

  return [value, write, { loading, error }];
}

/* ----------  Components ---------- */

export function Value({
  stateKey,
  fallback,
}: {
  stateKey?: string;
  fallback?: string;
}): React.ReactElement {
  const [v] = useProjectState<unknown>(stateKey ?? "", undefined);
  if (v === undefined || v === null || v === "") {
    return <>{fallback ?? ""}</>;
  }
  const text = typeof v === "object" ? JSON.stringify(v) : String(v);
  return <>{text}</>;
}

export function Input({
  value: valueKey,
  onChange: onChangeKey,
  placeholder,
}: {
  value?: string;
  onChange?: string;
  placeholder?: string;
}): React.ReactElement {
  const boundKey = onChangeKey ?? valueKey ?? "";
  const [v, setV] = useProjectState<string>(boundKey, "");
  return (
    <input
      type="text"
      className="rounded-md border border-border bg-background px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
      value={typeof v === "string" ? v : ""}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
    />
  );
}

export function Select({
  options,
  onChange: onChangeKey,
  value: valueKey,
}: {
  options?: string;
  onChange?: string;
  value?: string;
}): React.ReactElement {
  const opts = (options ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const boundKey = onChangeKey ?? valueKey ?? "";
  const [v, setV] = useProjectState<string>(boundKey, opts[0] ?? "");
  return (
    <select
      className="rounded-md border border-border bg-background px-3 py-1.5 text-[13px] text-foreground"
      value={typeof v === "string" ? v : ""}
      onChange={(e) => setV(e.target.value)}
    >
      {opts.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  label,
  onChange: onChangeKey,
  value: valueKey,
}: {
  label?: string;
  onChange?: string;
  value?: string;
}): React.ReactElement {
  const boundKey = onChangeKey ?? valueKey ?? "";
  const [v, setV] = useProjectState<boolean>(boundKey, false);
  return (
    <label className="inline-flex items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        checked={v === true}
        onChange={(e) => setV(e.target.checked)}
      />
      <span>{label ?? ""}</span>
    </label>
  );
}

/**
 * Robust children presence check. MDX v3 sometimes compiles self-closing
 * JSX (`<Button label="…" />`) with `children: []` rather than undefined —
 * which, with a plain `??` fallback, renders as nothing because `[]` is
 * not nullish but React renders an empty array as the empty string. Fall
 * back to `label` whenever children don't actually carry visible content.
 */
function hasVisibleChildren(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function Button({
  label,
  onClick,
  children,
  variant = "default",
}: {
  label?: string;
  onClick?: string;
  children?: React.ReactNode;
  variant?: "default" | "outline";
}): React.ReactElement {
  // When `onClick` is not a stateKey, skip all network — this lets existing
  // `<Button>Text</Button>` notes keep working exactly as before.
  const [count, setCount] = useProjectState<number>(onClick ?? "", 0);
  const handle = (): void => {
    if (onClick) setCount((prev) => (typeof prev === "number" ? prev + 1 : 1));
  };
  const labelText =
    typeof label === "string" && label.length > 0 ? label : undefined;
  const visibleChildren = hasVisibleChildren(children) ? children : undefined;
  const text: React.ReactNode = visibleChildren ?? labelText ?? "Button";

  // Inline styles + Tailwind classes. The inline fallbacks guarantee the
  // button is visible even in environments where design-system tokens
  // (`--primary`, `--primary-foreground`, `--border`) aren't resolved.
  const baseStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    lineHeight: 1.2,
    minHeight: 28,
  };
  const variantStyle: React.CSSProperties =
    variant === "outline"
      ? {
          background: "transparent",
          color: "inherit",
          border: "1px solid currentColor",
          opacity: 0.85,
        }
      : {
          background: "var(--primary, #2563eb)",
          color: "var(--primary-foreground, #ffffff)",
          border: "1px solid transparent",
        };
  const cls =
    variant === "outline"
      ? "inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50"
      : "inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90";

  return (
    <button
      type="button"
      onClick={handle}
      className={cls}
      style={{ ...baseStyle, ...variantStyle }}
      data-archon-sdk-button=""
      data-archon-sdk-button-label={labelText ?? ""}
      data-count={count ?? 0}
      aria-label={typeof text === "string" ? text : labelText}
    >
      {text}
    </button>
  );
}

function parseBoolAttr(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1" || v === "yes";
  return false;
}

export function PushButton({
  label,
  fromKey,
  value,
  toKey,
  clearFrom,
}: {
  label?: string;
  fromKey?: string;
  value?: string;
  toKey?: string;
  clearFrom?: boolean | string;
}): React.ReactElement {
  const srcKey = typeof fromKey === "string" ? fromKey : "";
  const [src, setSrc] = useProjectState<string>(srcKey || "__pushbutton_unbound", "");
  const [list, setList] = useProjectState<unknown[]>(toKey ?? "__pushbutton_unbound_to", []);
  const doClear = parseBoolAttr(clearFrom);
  const handle = (): void => {
    const payload =
      srcKey && typeof src === "string" && src.length > 0 ? src : value ?? "";
    if (!payload && !value) return;
    setList((prev) => [...(Array.isArray(prev) ? prev : []), payload]);
    if (doClear && srcKey) setSrc("");
  };
  return (
    <button
      type="button"
      onClick={handle}
      className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50"
    >
      {label ?? "Add"}
    </button>
  );
}

export function Form({
  submit,
  children,
}: {
  submit?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const [, setSub] = useProjectState<{ submittedAt: number }>(
    submit ?? "__form_unbound",
    { submittedAt: 0 },
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submit) setSub({ submittedAt: Date.now() });
      }}
      className="my-3 flex flex-col gap-2"
    >
      {children}
    </form>
  );
}

function interpolate(template: string, ctx: unknown): string {
  if (ctx === null || ctx === undefined) return template;
  if (typeof ctx !== "object") {
    return template.replace(/\{\.\}/g, String(ctx));
  }
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*|\.)\}/g, (_m, name: string) => {
    if (name === ".") return typeof ctx === "object" ? JSON.stringify(ctx) : String(ctx);
    const rec = ctx as Record<string, unknown>;
    const v = rec[name];
    return v === undefined || v === null ? "" : String(v);
  });
}

export function List({
  stateKey,
  item,
}: {
  stateKey?: string;
  item?: string;
}): React.ReactElement {
  const [items] = useProjectState<unknown[]>(stateKey ?? "__list_unbound", []);
  const template = item ?? "- {.}";
  const rendered = Array.isArray(items) ? items : [];
  return (
    <ul className="my-2 list-none space-y-1">
      {rendered.map((it, idx) => (
        <li key={idx} className="text-[13px]">
          {interpolate(template, it)}
        </li>
      ))}
      {rendered.length === 0 && (
        <li className="text-[12px] text-muted-foreground">(empty)</li>
      )}
    </ul>
  );
}

export function Table({
  stateKey,
  columns,
}: {
  stateKey?: string;
  columns?: string;
}): React.ReactElement {
  const [rows] = useProjectState<Record<string, unknown>[]>(stateKey ?? "__table_unbound", []);
  const cols = (columns ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const data = Array.isArray(rows) ? rows : [];
  return (
    <table className="my-3 w-full border-collapse text-[13px]">
      <thead>
        <tr>
          {cols.map((c) => (
            <th
              key={c}
              className="border-b border-border px-2 py-1 text-left text-[11px] uppercase tracking-wide text-muted-foreground"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i} className="border-b border-border/60">
            {cols.map((c) => (
              <td key={c} className="px-2 py-1">
                {row[c] === undefined || row[c] === null ? "" : String(row[c])}
              </td>
            ))}
          </tr>
        ))}
        {data.length === 0 && (
          <tr>
            <td
              colSpan={cols.length || 1}
              className="px-2 py-2 text-center text-muted-foreground"
            >
              (empty)
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function Chart({
  stateKey,
  kind,
}: {
  stateKey?: string;
  kind?: "bar" | "line" | "pie" | string;
}): React.ReactElement {
  const [data] = useProjectState<number[]>(stateKey ?? "__chart_unbound", []);
  const series = Array.isArray(data) ? data.map((v) => Number(v) || 0) : [];
  const max = series.reduce((m, v) => Math.max(m, v), 0) || 1;
  if (kind === "line") {
    const w = 240;
    const h = 60;
    const step = series.length > 1 ? w / (series.length - 1) : 0;
    const pts = series
      .map((v, i) => `${i * step},${h - (v / max) * h}`)
      .join(" ");
    return (
      <svg width={w} height={h} role="img" aria-label="line chart">
        <polyline fill="none" stroke="currentColor" strokeWidth={2} points={pts} />
      </svg>
    );
  }
  if (kind === "pie") {
    // Degenerate pie: render slices as proportional horizontal bars for v1.
    const total = series.reduce((a, b) => a + b, 0) || 1;
    return (
      <div className="my-2 flex h-4 w-full overflow-hidden rounded-sm border border-border">
        {series.map((v, i) => (
          <div
            key={i}
            style={{ width: `${(v / total) * 100}%` }}
            className={`${i % 2 === 0 ? "bg-primary/70" : "bg-primary/40"}`}
          />
        ))}
      </div>
    );
  }
  // Default: bar
  return (
    <div className="my-2 flex items-end gap-1" style={{ height: 64 }}>
      {series.map((v, i) => (
        <span
          key={i}
          title={String(v)}
          className="inline-block bg-primary/70"
          style={{ width: 10, height: `${(v / max) * 100}%` }}
        />
      ))}
      {series.length === 0 && (
        <span className="text-[12px] text-muted-foreground">(empty)</span>
      )}
    </div>
  );
}

export function NoteEmbed({
  title,
  id,
}: {
  title?: string;
  id?: string;
}): React.ReactElement {
  const [state, setState] = React.useState<{ source: string; loading: boolean; error?: string }>({
    source: "",
    loading: true,
  });
  const projectId = useProjectId();

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (id) {
          const res = await fetch(`${syncBase()}/wpn/notes/${encodeURIComponent(id)}`, {
            headers: authHeaders(),
            credentials: "omit",
          });
          if (!res.ok) {
            if (!cancelled) setState({ source: "", loading: false, error: `GET ${res.status}` });
            return;
          }
          const body = (await res.json()) as { note?: { content?: string } };
          if (!cancelled)
            setState({ source: body.note?.content ?? "", loading: false });
          return;
        }
        if (title && projectId) {
          const res = await fetch(
            `${syncBase()}/wpn/projects/${encodeURIComponent(projectId)}/notes`,
            { headers: authHeaders(), credentials: "omit" },
          );
          if (!res.ok) {
            if (!cancelled) setState({ source: "", loading: false, error: `GET ${res.status}` });
            return;
          }
          const body = (await res.json()) as {
            notes?: Array<{ id: string; title: string; content?: string }>;
          };
          const hit = body.notes?.find((n) => n.title === title);
          if (!cancelled) {
            setState({
              source: hit?.content ?? "",
              loading: false,
              error: hit ? undefined : "note not found",
            });
          }
          return;
        }
        if (!cancelled) setState({ source: "", loading: false, error: "title or id required" });
      } catch (e) {
        if (!cancelled) setState({ source: "", loading: false, error: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, title, projectId]);

  if (state.loading)
    return <div className="text-[12px] text-muted-foreground">Loading embed…</div>;
  if (state.error)
    return (
      <div className="text-[12px] text-destructive" role="alert">
        NoteEmbed error: {state.error}
      </div>
    );
  return (
    <div className="my-3 whitespace-pre-wrap rounded-md border border-border bg-muted/10 p-3 text-[13px]">
      {state.source}
    </div>
  );
}

export function Markdown({ source }: { source?: string }): React.ReactElement {
  const paragraphs = String(source ?? "").split(/\n{2,}/);
  return (
    <div className="my-2 space-y-2">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-[13px]">
          {p}
        </p>
      ))}
    </div>
  );
}

/**
 * Tag name → component map for the `@archon/mdx-sdk` facade. Extends the
 * existing `@archon/ui` map via composition in `component-map.ts`.
 */
export function getArchonMdxSdkFacadeComponentMap(): Record<
  string,
  React.ComponentType<Record<string, unknown>>
> {
  return {
    Input,
    Select,
    Checkbox,
    Button,
    PushButton,
    Form,
    Value,
    List,
    Table,
    Chart,
    NoteEmbed,
    Markdown,
  } as unknown as Record<string, React.ComponentType<Record<string, unknown>>>;
}
