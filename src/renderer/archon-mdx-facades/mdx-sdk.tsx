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

function useProjectState<T>(
  key: string,
  initial?: T,
): [T | undefined, (next: T | ((prev: T | undefined) => T)) => void, { loading: boolean; error?: string }] {
  const projectId = useProjectId();
  const [value, setValue] = React.useState<T | undefined>(initial);
  const [loading, setLoading] = React.useState<boolean>(!isUnboundKey(key));
  const [error, setError] = React.useState<string | undefined>(undefined);
  const versionRef = React.useRef<number>(0);
  const pendingRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const unbound = isUnboundKey(key);

  const read = React.useCallback(async (): Promise<void> => {
    if (!projectId || unbound) return;
    try {
      const res = await fetch(
        `${syncBase()}/projects/${encodeURIComponent(projectId)}/mdx-state/${encodeURIComponent(key)}`,
        { headers: { ...authHeaders() }, credentials: "omit" },
      );
      // Back-compat: older sync-apis may still 404 for absent keys. Treat
      // 404 identically to the new 200-absent response.
      if (res.status === 404) {
        versionRef.current = 0;
        if (initial !== undefined) setValue(initial);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(`GET ${res.status}`);
        setLoading(false);
        // eslint-disable-next-line no-console
        console.warn(`[mdx-sdk] GET ${key} → ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        value: T | null;
        version: number;
        mode?: "inline" | "chunked" | "absent";
      };
      if (body.mode === "absent" || (body.value === null && body.version === 0)) {
        versionRef.current = 0;
        if (initial !== undefined) setValue(initial);
        setError(undefined);
        setLoading(false);
        return;
      }
      // Only overwrite if the server version is strictly newer — avoids
      // stomping an in-flight local write that already bumped the version.
      if (body.version >= versionRef.current) {
        versionRef.current = body.version;
        setValue(body.value as T);
      }
      setError(undefined);
      setLoading(false);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
      // eslint-disable-next-line no-console
      console.warn(`[mdx-sdk] GET ${key} threw:`, e);
    }
  }, [projectId, key, initial, unbound]);

  React.useEffect(() => {
    if (unbound) {
      setLoading(false);
      return;
    }
    if (!projectId) return;
    void read();
    const id = setInterval(() => {
      void read();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [read, projectId, unbound]);

  const write = React.useCallback<(n: T | ((prev: T | undefined) => T)) => void>(
    (next) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T | undefined) => T)(prev) : next;
        if (unbound || !projectId) return resolved;
        if (pendingRef.current) clearTimeout(pendingRef.current);
        pendingRef.current = setTimeout(() => {
          void (async () => {
            try {
              const res = await fetch(
                `${syncBase()}/projects/${encodeURIComponent(projectId)}/mdx-state/${encodeURIComponent(key)}`,
                {
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/json",
                    "If-Match": String(versionRef.current),
                    ...authHeaders(),
                  },
                  credentials: "omit",
                  body: JSON.stringify({ value: resolved }),
                },
              );
              if (res.status === 200) {
                const body = (await res.json()) as { version: number };
                versionRef.current = body.version;
                setError(undefined);
              } else if (res.status === 409) {
                // Server has a newer version — refetch.
                await read();
              } else if (res.status === 429) {
                setError("rate limit — slow down");
              } else if (res.status === 413) {
                setError("value too large");
              } else {
                setError(`PUT ${res.status}`);
                // eslint-disable-next-line no-console
                console.warn(`[mdx-sdk] PUT ${key} → ${res.status}`);
              }
            } catch (e) {
              setError((e as Error).message);
              // eslint-disable-next-line no-console
              console.warn(`[mdx-sdk] PUT ${key} threw:`, e);
            }
          })();
        }, WRITE_DEBOUNCE_MS);
        return resolved;
      });
    },
    [projectId, key, unbound, read],
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
  // Prefer children (JSX body form), fall back to label prop, then to a
  // visible placeholder so the button never renders empty.
  const text =
    (children !== undefined && children !== null && children !== "" ? children : undefined) ??
    (typeof label === "string" && label.length > 0 ? label : undefined) ??
    "Button";
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors";
  const style =
    variant === "outline"
      ? "border border-border bg-background text-foreground hover:bg-muted/50"
      : "bg-primary text-primary-foreground hover:bg-primary/90";
  return (
    <button
      type="button"
      onClick={handle}
      className={`${base} ${style}`}
      data-count={count ?? 0}
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
