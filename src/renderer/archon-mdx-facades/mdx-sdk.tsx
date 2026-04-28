/**
 * Renderer-side facade for `@archon/mdx-sdk` imports inside MDX mini-app notes.
 *
 * Imports are stripped by `remark-archon-mdx-facade-imports.ts`; the tag names
 * that authors use (`Input`, `Value`, `PushButton`, `List`, `Table`, `Chart`,
 * `NoteEmbed`, `Markdown`, `Button`, `Select`, `Checkbox`, `Form`, `Code`,
 * `Slideshow`) resolve through the MDXProvider component map returned by
 * `getArchonMdxFacadeComponentMap`.
 *
 * State is persisted per project via the sync-api routes in
 * `apps/archon-sync-api/src/mdx-state/routes.ts`:
 *   GET /projects/:projectId/mdx-state/:key  →  { value, version }
 *   PUT /projects/:projectId/mdx-state/:key  with If-Match and JSON body
 *
 * Live cross-tab sync rides the project-scoped `/api/v1/ws/mdx-state` socket
 * (see `mdx-state-ws-client.ts`). One socket per projectId is shared by every
 * `useProjectState` consumer. Inline frames apply the new value directly; the
 * initial `read()` and a catch-up `read()` on each (re)connect cover any gap.
 * No periodic polling.
 */
import React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { WpnNoteLinkResolver } from "../components/renderers/mdx-shell-context";
import { parseInternalMarkdownNoteLink } from "../utils/markdown-internal-note-href";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  markdownShellClass,
  useArchonMarkdownUiComponents,
} from "../components/renderers/useArchonMarkdownUiComponents";
import { createSyncBaseUrlResolver } from "@archon/platform";
import { useMdxShell } from "../components/renderers/mdx-shell-context";
import { readCloudSyncToken } from "../cloud-sync/cloud-sync-storage";
import {
  subscribeProjectStateFrames,
  type MdxStateFrame,
} from "./mdx-state-ws-client";

const WRITE_DEBOUNCE_MS = 250;

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

/**
 * Cross-hook latest-value broadcast. Two `useProjectState` hooks bound to
 * the same (projectId, key) — e.g. `<Input onChange="x">` and
 * `<PushButton fromKey="x">` — each hold their own React state. Without
 * this, the PushButton only sees what's in its local state from the last
 * 2 s poll, so clicking it immediately after typing reads stale "" and
 * the push silently no-ops. Writes and successful reads publish here;
 * subscribers adopt the new value unless they have pending local edits.
 */
const latestByUrl = new Map<string, unknown>();
type LatestListener = (value: unknown) => void;
const latestListeners = new Map<string, Set<LatestListener>>();

function publishLatest(url: string, value: unknown): void {
  latestByUrl.set(url, value);
  const subs = latestListeners.get(url);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb(value);
    } catch {
      /* listener errors are cosmetic */
    }
  }
}

function subscribeLatest(url: string, cb: LatestListener): () => void {
  let set = latestListeners.get(url);
  if (!set) {
    set = new Set();
    latestListeners.set(url, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

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
      const absent =
        body.mode === "absent" || (body.value === null && body.version === 0);
      if (!absent) {
        publishLatest(url, body.value);
      }
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
 * Design notes — why this is more than a naive fetch/subscribe:
 *
 * 1. While the user is typing, local state is authoritative. Inbound
 *    frames and reads never clobber a "dirty" (locally-modified) value;
 *    they only update `versionRef` in the background so the next PUT has
 *    a fresh `If-Match`. Without this an inbound echo would erase typing
 *    that hadn't been PUT-acknowledged yet.
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
 * 4. Live updates arrive via the project-scoped WS subscription — inline
 *    frames apply directly, chunked/absent frames trigger a single
 *    targeted GET. On reconnect we fire one catch-up read in case any
 *    frames were missed while the socket was down.
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
    const onFrame = (frame: MdxStateFrame): void => {
      if (frame.projectId !== projectId) return;
      if (frame.key !== key) return;
      // A write of ours is still settling; the PUT response will sync versionRef
      // and `latestRef` already has the locally-correct value. Ignoring the
      // frame avoids racing the user's in-progress edit with our own echo.
      if (dirtyRef.current || inFlightRef.current) return;
      if (frame.version <= versionRef.current) return;
      if (frame.mode === "inline" && "value" in frame) {
        versionRef.current = frame.version;
        const v = frame.value as T;
        latestRef.current = v;
        setValue(v);
        if (putUrl) publishLatest(putUrl, frame.value);
        setError(undefined);
      } else {
        // chunked or absent — refetch this one key.
        void read();
      }
    };
    const onConnectionChange = (connected: boolean): void => {
      // Catch up on any updates the client missed while the WS was down.
      if (connected) void read();
    };
    return subscribeProjectStateFrames(projectId, onFrame, onConnectionChange);
  }, [read, projectId, unbound, key, putUrl]);

  // Subscribe to cross-hook broadcasts so this hook reflects writes made by
  // other <Input>/<PushButton>/etc. instances on the same key immediately.
  // Without this, the PushButton click handler reads a stale `src` and the
  // push is dropped. Skip when the user has pending local edits so a
  // broadcast can't clobber mid-type.
  React.useEffect(() => {
    if (unbound || !putUrl) return;
    const known = latestByUrl.get(putUrl);
    if (known !== undefined && !dirtyRef.current) {
      setValue(known as T);
      latestRef.current = known as T;
    }
    return subscribeLatest(putUrl, (v) => {
      if (dirtyRef.current) return;
      setValue(v as T);
      latestRef.current = v as T;
    });
  }, [putUrl, unbound]);

  const write = React.useCallback<(n: T | ((prev: T | undefined) => T)) => void>(
    (next) => {
      // Resolve against `latestRef` (kept in sync on every write and every
      // authoritative read) instead of using a `setValue` updater. React
      // may replay updater functions, and side effects inside a replayed
      // updater can fire `setValue` on sibling hooks mid-render — that's
      // the "Cannot update a component while rendering a different
      // component" warning we hit before. Pre-computing `resolved` and
      // passing it as a plain value means the update is not replayed, so
      // the broadcast below stays in the event tick where it belongs.
      const prev = latestRef.current;
      const resolved =
        typeof next === "function"
          ? (next as (p: T | undefined) => T)(prev)
          : next;
      latestRef.current = resolved;
      setValue(resolved);
      if (unbound || !putUrl) return;
      dirtyRef.current = true;
      // Broadcast to sibling hooks on the same key (e.g. <Input>'s write
      // needs to be visible to <PushButton fromKey=…> before the next
      // 2 s poll, otherwise clicking the button reads stale state).
      publishLatest(putUrl, resolved);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        kickDrain();
      }, WRITE_DEBOUNCE_MS);
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
  // Tokens in src/renderer/styles/tokens.css are bare HSL tuples (e.g.
  // `--primary: 239 64% 48%`), so wrap in hsl() and use the slash alpha
  // form. Raw tuples as input to color-mix() are invalid and cause the
  // browser to drop the declaration — which is why the bars rendered
  // transparent in the MDX preview after the earlier color-mix attempt.
  const barFill = "hsl(var(--primary, 239 64% 48%) / 0.7)";
  const barFillDim = "hsl(var(--primary, 239 64% 48%) / 0.4)";
  const emptyColor = "hsl(var(--muted-foreground, 215.4 16.3% 46.9%))";
  if (kind === "pie") {
    // Degenerate pie: render slices as proportional horizontal bars for v1.
    const total = series.reduce((a, b) => a + b, 0) || 1;
    return (
      <div className="my-2 flex h-4 w-full overflow-hidden rounded-sm border border-border">
        {series.map((v, i) => (
          <div
            key={i}
            style={{
              width: `${(v / total) * 100}%`,
              background: i % 2 === 0 ? barFill : barFillDim,
            }}
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
          className="inline-block"
          style={{
            width: 10,
            height: `${(v / max) * 100}%`,
            background: barFill,
          }}
        />
      ))}
      {series.length === 0 && (
        <span className="text-[12px]" style={{ color: emptyColor }}>
          (empty)
        </span>
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
          // Two-step: the `/wpn/projects/:projectId/notes` endpoint returns a
          // flat list with id/title but intentionally without `content` (to
          // keep list payloads tight). Find the matching title here, then
          // fetch the full note by id from `/wpn/notes/:id` which does
          // include content.
          const listRes = await fetch(
            `${syncBase()}/wpn/projects/${encodeURIComponent(projectId)}/notes`,
            { headers: authHeaders(), credentials: "omit" },
          );
          if (!listRes.ok) {
            if (!cancelled) setState({ source: "", loading: false, error: `GET ${listRes.status}` });
            return;
          }
          const listBody = (await listRes.json()) as {
            notes?: Array<{ id: string; title: string }>;
          };
          const hit = listBody.notes?.find((n) => n.title === title);
          if (!hit) {
            if (!cancelled)
              setState({ source: "", loading: false, error: "note not found" });
            return;
          }
          const noteRes = await fetch(
            `${syncBase()}/wpn/notes/${encodeURIComponent(hit.id)}`,
            { headers: authHeaders(), credentials: "omit" },
          );
          if (!noteRes.ok) {
            if (!cancelled) setState({ source: "", loading: false, error: `GET ${noteRes.status}` });
            return;
          }
          const noteBody = (await noteRes.json()) as { note?: { content?: string } };
          if (!cancelled)
            setState({ source: noteBody.note?.content ?? "", loading: false });
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

type CodeLanguage = "markdown" | "javascript" | "typescript" | "json" | "plain";

function languageExtension(lang: CodeLanguage | string | undefined): Extension[] {
  switch (lang) {
    case "javascript":
      return [javascript()];
    case "typescript":
      return [javascript({ typescript: true })];
    case "json":
    case "plain":
      return [];
    case "markdown":
    default:
      return [markdown()];
  }
}

/**
 * CodeMirror-backed editor surfaced to MDX as `<Code>`. Defaults to markdown
 * highlighting so a note can offer a "type a markdown document" surface and
 * keep the source in `useProjectState` like every other input — no special
 * casing in the host. `language="javascript" | "typescript" | "json" | "plain"`
 * picks a different mode (json/plain fall back to no highlighting since
 * `@codemirror/lang-json` isn't bundled).
 */
export function Code({
  value: valueKey,
  onChange: onChangeKey,
  language,
  placeholder,
  readOnly,
}: {
  value?: string;
  onChange?: string;
  language?: CodeLanguage | string;
  placeholder?: string;
  readOnly?: boolean | string;
}): React.ReactElement {
  const boundKey = onChangeKey ?? valueKey ?? "";
  const [v, setV] = useProjectState<string>(boundKey, "");
  const extensions = React.useMemo(() => languageExtension(language), [language]);
  const ro = parseBoolAttr(readOnly);
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-background">
      <CodeMirror
        value={typeof v === "string" ? v : ""}
        placeholder={placeholder}
        readOnly={ro}
        extensions={extensions}
        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
        onChange={(next) => setV(next)}
      />
    </div>
  );
}

/** WPN-explorer drag MIME — must match `WpnExplorerPanelView.tsx:85`. */
const WPN_NOTE_DND_MIME = "application/archon-wpn-note";

/**
 * CodeMirror extension that turns a WPN-explorer drag-drop into a markdown
 * link inserted at the drop position. When the drop payload is missing or
 * the resolver can't find the note, the handler returns `false` so default
 * CodeMirror behavior runs (e.g. plain-text URI list still gets pasted).
 */
function wpnNoteLinkDropExtension(
  resolver: WpnNoteLinkResolver | undefined,
): Extension {
  return EditorView.domEventHandlers({
    dragenter(event: DragEvent): boolean {
      // Some browsers require preventDefault on dragenter for the element
      // to be treated as a valid drop target. dragover-only is not
      // always sufficient — claim the drop here too.
      const types = event.dataTransfer?.types;
      if (!types || !Array.from(types).includes(WPN_NOTE_DND_MIME)) return false;
      event.preventDefault();
      return true;
    },
    dragover(event: DragEvent): boolean {
      const types = event.dataTransfer?.types;
      if (!types || !Array.from(types).includes(WPN_NOTE_DND_MIME)) return false;
      event.preventDefault();
      // Source's `effectAllowed` is `copyMove` (see WpnExplorerPanelView.tsx
      // `onDragStartNote`), so `copy` is valid and gives the user a
      // copy-cursor indicator that the drop is accepted.
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      return true;
    },
    drop(event: DragEvent, view: EditorView): boolean {
      const dt = event.dataTransfer;
      if (!dt) return false;
      const raw = dt.getData(WPN_NOTE_DND_MIME);
      if (!raw) return false;
      let payload: { projectId?: unknown; noteId?: unknown };
      try {
        payload = JSON.parse(raw) as { projectId?: unknown; noteId?: unknown };
      } catch {
        return false;
      }
      const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
      const noteId = typeof payload.noteId === "string" ? payload.noteId : "";
      if (!projectId || !noteId) return false;
      const resolved = resolver ? resolver({ projectId, noteId }) : null;
      if (!resolved) return false;
      event.preventDefault();
      event.stopPropagation();
      const md = `[${resolved.label}](${resolved.href})`;
      const pos =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
        view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, to: pos, insert: md },
        selection: { anchor: pos + md.length },
      });
      view.focus();
      return true;
    },
  });
}

/**
 * Fetch a note's markdown content by id (preferred) or by title within the
 * current MDX project. Mirrors `NoteEmbed`'s pattern (id → `GET /wpn/notes/:id`;
 * title → list-then-get inside `projectId`) but returns the raw source string
 * for components that need to do their own rendering. Returns
 * `{ source: "" }` and a non-empty `error` when neither input is present or
 * the fetch fails.
 */
function useExternalNoteSource(
  id: string | undefined,
  title: string | undefined,
  projectId: string | null,
): { source: string; loading: boolean; error?: string } {
  const [state, setState] = React.useState<{
    source: string;
    loading: boolean;
    error?: string;
  }>({ source: "", loading: !!(id || title) });

  React.useEffect(() => {
    if (!id && !title) {
      setState({ source: "", loading: false });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    void (async () => {
      try {
        if (id) {
          const res = await fetch(
            `${syncBase()}/wpn/notes/${encodeURIComponent(id)}`,
            { headers: authHeaders(), credentials: "omit" },
          );
          if (!res.ok) {
            if (!cancelled)
              setState({ source: "", loading: false, error: `GET ${res.status}` });
            return;
          }
          const body = (await res.json()) as { note?: { content?: string } };
          if (!cancelled)
            setState({ source: body.note?.content ?? "", loading: false });
          return;
        }
        if (title && projectId) {
          const listRes = await fetch(
            `${syncBase()}/wpn/projects/${encodeURIComponent(projectId)}/notes`,
            { headers: authHeaders(), credentials: "omit" },
          );
          if (!listRes.ok) {
            if (!cancelled)
              setState({ source: "", loading: false, error: `GET ${listRes.status}` });
            return;
          }
          const listBody = (await listRes.json()) as {
            notes?: Array<{ id: string; title: string }>;
          };
          const hit = listBody.notes?.find((n) => n.title === title);
          if (!hit) {
            if (!cancelled)
              setState({ source: "", loading: false, error: "note not found" });
            return;
          }
          const noteRes = await fetch(
            `${syncBase()}/wpn/notes/${encodeURIComponent(hit.id)}`,
            { headers: authHeaders(), credentials: "omit" },
          );
          if (!noteRes.ok) {
            if (!cancelled)
              setState({ source: "", loading: false, error: `GET ${noteRes.status}` });
            return;
          }
          const noteBody = (await noteRes.json()) as {
            note?: { content?: string };
          };
          if (!cancelled)
            setState({ source: noteBody.note?.content ?? "", loading: false });
          return;
        }
        if (!cancelled)
          setState({
            source: "",
            loading: false,
            error: "title or id required",
          });
      } catch (e) {
        if (!cancelled)
          setState({ source: "", loading: false, error: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, title, projectId]);

  return state;
}

type SlideSeparator = "hr" | "h1";

/**
 * Split a markdown deck into slides. `hr` splits on lines containing only
 * `---` (>=3 dashes, optional whitespace). `h1` makes each `# ` heading a
 * new slide. Empty leading/trailing chunks are dropped; remaining chunks
 * are trimmed but their internal whitespace is preserved.
 */
function splitSlides(src: string, sep: SlideSeparator): string[] {
  const text = String(src ?? "");
  if (sep === "h1") {
    // Match `# ` at line-start. Keep the heading by re-prefixing each chunk.
    const parts = text.split(/^(?=# )/m).map((p) => p.replace(/\s+$/, ""));
    const out = parts.filter((p) => p.trim().length > 0);
    return out.length > 0 ? out : [text.trim()];
  }
  // hr: split on /^\s*-{3,}\s*$/ (a line that is only dashes)
  const parts = text.split(/^[ \t]*-{3,}[ \t]*$/m).map((p) => p.trim());
  const out = parts.filter((p) => p.length > 0);
  return out.length > 0 ? out : [text.trim()];
}

/**
 * `<Slideshow>` — markdown deck with built-in Edit/Present toggle. The
 * source is bound to `value` (a project-state stateKey, same pattern as
 * `<Code>`); slides are split on `---` by default (configurable via
 * `separator`). In present mode each slide renders through react-markdown
 * with the same component map and Tailwind class set as a regular
 * markdown note.
 *
 * The host MDX shell's editor/preview split does NOT pipe a mode flag into
 * rendered MDX — by design, mini-app components are always rendered in
 * "preview." The Edit/Present toggle therefore lives inside this
 * component, persisted per-deck under a state key derived from `value`
 * (`${value}__mode`) so reopening the note restores the last-used view.
 */
export function Slideshow({
  value: valueKey,
  onChange: onChangeKey,
  noteId,
  noteTitle,
  indexKey,
  placeholder,
  separator,
}: {
  value?: string;
  onChange?: string;
  noteId?: string;
  noteTitle?: string;
  indexKey?: string;
  placeholder?: string;
  separator?: SlideSeparator | string;
}): React.ReactElement {
  const boundKey = onChangeKey ?? valueKey ?? "";
  // External-note mode: when `noteId` or `noteTitle` is set, the deck source
  // is read-only — fetched from the source note rather than project state.
  // Editing is disabled (users edit the source note directly), so the
  // Edit/Present toggle, the textarea, and the Link-to-note picker all
  // collapse and the component renders the present branch only.
  const isExternal = !!(
    (noteId && noteId.length > 0) ||
    (noteTitle && noteTitle.length > 0)
  );
  const projectId = useProjectId();
  const external = useExternalNoteSource(
    isExternal ? noteId : undefined,
    isExternal ? noteTitle : undefined,
    projectId,
  );
  const [src, setSrc] = useProjectState<string>(
    isExternal ? "__slideshow_external_unused" : boundKey,
    "",
  );
  const effectiveSrc = isExternal ? external.source : src;
  const sep: SlideSeparator = separator === "h1" ? "h1" : "hr";
  const slides = React.useMemo(
    () => splitSlides(typeof effectiveSrc === "string" ? effectiveSrc : "", sep),
    [effectiveSrc, sep],
  );

  // Edit/Present mode persists per-deck via a state-key derived from the
  // bound `value` key, so reopening the note (or opening it in another tab)
  // restores the last-used view. When `value` is unbound, the mode falls
  // back to a local-only state (the `__`-prefix convention skips the network
  // in `useProjectState`). External-note decks are forced to present mode.
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
  // External decks have no Edit mode, so we can't reuse `mode` to drive the
  // full-screen overlay (it would force every embedded `<Slideshow noteId>`
  // to take over the viewport on mount). Track full-screen separately, keep
  // the inline present view as the default, and let the Present/Exit
  // buttons + Esc toggle it.
  const [externalFullscreen, setExternalFullscreen] = React.useState(false);

  // Slide index: project-state when `indexKey` is set, otherwise local React state.
  const [persistedIdx, setPersistedIdx] = useProjectState<number>(
    indexKey ?? "__slideshow_unbound_idx",
    0,
  );
  const [localIdx, setLocalIdx] = React.useState<number>(0);
  const rawIdx = indexKey ? persistedIdx ?? 0 : localIdx;
  const idx = Math.max(0, Math.min(slides.length - 1, rawIdx | 0));
  const setIdx = (n: number): void => {
    const clamped = Math.max(0, Math.min(slides.length - 1, n));
    if (indexKey) setPersistedIdx(clamped);
    else setLocalIdx(clamped);
  };

  const shell = useMdxShell();
  const viewRef = React.useRef<EditorView | null>(null);
  const cmExtensions = React.useMemo(
    () => [markdown(), wpnNoteLinkDropExtension(shell.resolveWpnNoteLink)],
    [shell.resolveWpnNoteLink],
  );

  const insertLinkAtCaret = React.useCallback(
    (link: { label: string; href: string }): void => {
      const view = viewRef.current;
      if (!view) return;
      const md = `[${link.label}](${link.href})`;
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, to: pos, insert: md },
        selection: { anchor: pos + md.length },
      });
      view.focus();
    },
    [],
  );

  const onPickNoteLinkClick = React.useCallback((): void => {
    const opener = shell.openWpnNoteLinkPicker;
    if (!opener || !viewRef.current) return;
    opener((link) => insertLinkAtCaret(link));
  }, [shell.openWpnNoteLinkPicker, insertLinkAtCaret]);

  const canPickNoteLink = !!shell.openWpnNoteLinkPicker;
  const { components: baseComponents } = useArchonMarkdownUiComponents({});
  const openInternalNoteLinkInNewTab = shell.openInternalNoteLinkInNewTab;
  // Slides should open internal note links in a NEW Archon tab (not a new
  // browser tab — that would lose context in the desktop app and double-load
  // the SPA in the web app). External http(s) links keep the legacy
  // `target="_blank"` behavior. Falls back to `target="_blank"` for internal
  // links too when rendered outside `MdxNoteEditor` (no host workbench).
  const components = React.useMemo(
    () => ({
      ...baseComponents,
      a: ({
        href,
        children,
        ...rest
      }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
        const internal =
          typeof href === "string" ? parseInternalMarkdownNoteLink(href) : null;
        if (internal && openInternalNoteLinkInNewTab) {
          return (
            <a
              {...rest}
              href={href}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                openInternalNoteLinkInNewTab(internal);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [baseComponents, openInternalNoteLinkInNewTab],
  );

  const toggleBtn = (
    target: "edit" | "present",
    label: string,
  ): React.ReactElement => {
    const active = mode === target;
    return (
      <button
        type="button"
        onClick={() => setMode(target)}
        className={
          "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors " +
          (active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-foreground hover:bg-muted/50")
        }
      >
        {label}
      </button>
    );
  };

  const navBtn = (
    onClick: () => void,
    disabled: boolean,
    label: string,
  ): React.ReactElement => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-md border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors " +
        (disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-muted/50")
      }
    >
      {label}
    </button>
  );

  const isPresenting = isExternal ? externalFullscreen : mode === "present";

  // In Present mode, take over the viewport — Esc returns to Edit (or, for
  // external decks, collapses the full-screen overlay back to inline).
  // Arrow keys navigate slides while presenting.
  React.useEffect(() => {
    if (!isPresenting) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (isExternal) setExternalFullscreen(false);
        else setMode("edit");
      } else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        if (idx < slides.length - 1) {
          e.preventDefault();
          setIdx(idx + 1);
        }
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        if (idx > 0) {
          e.preventDefault();
          setIdx(idx - 1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // setMode/setExternalFullscreen/setIdx are stable; intentionally re-bind on idx/slides.length so the closure is fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresenting, isExternal, idx, slides.length]);

  // Present mode swaps to a fixed-position overlay that fills the
  // viewport. Edit mode keeps the inline component layout so the deck
  // sits naturally in the surrounding MDX content.
  const outerClass = isPresenting
    ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-background"
    : "my-3 flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-md border border-border bg-background";

  return (
    <div className={outerClass}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          {!isExternal && toggleBtn("edit", "Edit")}
          {!isExternal && toggleBtn("present", "Present")}
          {isExternal && !externalFullscreen && (
            <button
              type="button"
              onClick={() => setExternalFullscreen(true)}
              className="rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              Present
            </button>
          )}
          {isExternal && externalFullscreen && (
            <button
              type="button"
              onClick={() => setExternalFullscreen(false)}
              className="rounded-md border border-primary bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Exit
            </button>
          )}
          {isExternal && (
            <span className="ml-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              External note
            </span>
          )}
        </div>
        {!isExternal && mode === "edit" && (
          <button
            type="button"
            onClick={onPickNoteLinkClick}
            disabled={!canPickNoteLink}
            title={
              canPickNoteLink
                ? "Pick a note and insert a markdown link at the caret"
                : "Note picker isn't available in this rendering context"
            }
            className={
              "rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors " +
              (canPickNoteLink ? "hover:bg-muted/50" : "cursor-not-allowed opacity-40")
            }
          >
            Link to note (path)
          </button>
        )}
        {mode === "present" && (
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            <span>
              Slide {idx + 1} of {slides.length}
            </span>
            {isPresenting && (
              <span className="hidden text-[11px] opacity-70 sm:inline">
                ← / → to navigate · Esc to exit
              </span>
            )}
          </div>
        )}
      </div>
      {isExternal && external.loading ? (
        <div className="p-4 text-[12px] text-muted-foreground">
          Loading deck…
        </div>
      ) : isExternal && external.error ? (
        <div className="p-4 text-[12px] text-destructive" role="alert">
          Slideshow error: {external.error}
        </div>
      ) : mode === "edit" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeMirror
            value={typeof src === "string" ? src : ""}
            placeholder={placeholder}
            height="100%"
            extensions={cmExtensions}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
            }}
            className="archon-md-cm h-full min-h-0 overflow-hidden text-[13px] [&_.cm-editor]:flex [&_.cm-editor]:h-full [&_.cm-editor]:min-h-0 [&_.cm-editor]:flex-col [&_.cm-scroller]:min-h-0 [&_.cm-scroller]:flex-1"
            onCreateEditor={(view) => {
              viewRef.current = view;
            }}
            onChange={(next) => setSrc(next)}
          />
        </div>
      ) : (
        <div
          className={
            "flex min-h-0 flex-1 flex-col gap-2 " +
            (isPresenting ? "px-16 py-12 sm:px-24 sm:py-16" : "p-4")
          }
        >
          {isPresenting && (
            <style>{`
.archon-slideshow-fullscreen h1 {
  font-size: clamp(40px, 6vw, 64px) !important;
  line-height: 1.1 !important;
  font-weight: 700 !important;
  letter-spacing: -0.02em !important;
  margin: 0 0 0.5em !important;
}
.archon-slideshow-fullscreen h2 {
  font-size: clamp(28px, 4.5vw, 44px) !important;
  line-height: 1.15 !important;
  font-weight: 600 !important;
  letter-spacing: -0.01em !important;
  margin: 0.6em 0 0.4em !important;
}
.archon-slideshow-fullscreen h3 {
  font-size: clamp(22px, 3.4vw, 32px) !important;
  line-height: 1.2 !important;
  font-weight: 600 !important;
  margin: 0.6em 0 0.3em !important;
}
.archon-slideshow-fullscreen p,
.archon-slideshow-fullscreen li,
.archon-slideshow-fullscreen blockquote {
  font-size: clamp(18px, 2.4vw, 24px) !important;
  line-height: 1.5 !important;
}
.archon-slideshow-fullscreen ul,
.archon-slideshow-fullscreen ol {
  margin: 0.5em 0 !important;
  padding-left: 0.4em !important;
  list-style-position: inside !important;
}
.archon-slideshow-fullscreen li {
  text-indent: -1.2em !important;
  padding-left: 1.2em !important;
}
.archon-slideshow-fullscreen li + li {
  margin-top: 0.35em !important;
}
.archon-slideshow-fullscreen li::marker {
  font-variant-numeric: tabular-nums;
}
.archon-slideshow-fullscreen blockquote {
  border-left: 4px solid currentColor;
  padding-left: 0.8em !important;
  opacity: 0.85;
  margin: 0.6em 0 !important;
}
.archon-slideshow-fullscreen code {
  font-size: 0.85em !important;
}
.archon-slideshow-fullscreen pre {
  font-size: clamp(14px, 1.6vw, 20px) !important;
  line-height: 1.45 !important;
  padding: 0.9em 1.1em !important;
  border-radius: 8px !important;
}
.archon-slideshow-fullscreen pre code {
  font-size: inherit !important;
}
.archon-slideshow-fullscreen table {
  font-size: clamp(16px, 1.9vw, 20px) !important;
}
.archon-slideshow-fullscreen th,
.archon-slideshow-fullscreen td {
  padding: 0.5em 0.7em !important;
}
.archon-slideshow-fullscreen hr {
  margin: 1em 0 !important;
}
            `}</style>
          )}
          <div
            className={
              "mx-auto w-full min-h-0 flex-1 overflow-y-auto " +
              (isPresenting
                ? "max-w-[1100px] archon-slideshow-fullscreen"
                : "") +
              " " +
              markdownShellClass
            }
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {slides[idx] ?? ""}
            </ReactMarkdown>
          </div>
          <div
            className={
              "mx-auto mt-2 flex w-full shrink-0 justify-between " +
              (isPresenting ? "max-w-[1100px]" : "max-w-4xl")
            }
          >
            {navBtn(() => setIdx(idx - 1), idx <= 0, "◀ Prev")}
            {navBtn(() => setIdx(idx + 1), idx >= slides.length - 1, "Next ▶")}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Fetch markdown children of a parent note by listing the project's flat
 * note tree (`GET /wpn/projects/:projectId/notes`, which returns each row's
 * `parent_id`, `type`, and `sibling_index`) and filtering to the requested
 * parent. Used by `<DeckPicker>` so a Welcome-screen author can drop a deck
 * collection in without hard-coding individual deck note ids.
 */
function useMarkdownChildren(
  parentNoteId: string | undefined,
  projectId: string | null,
): {
  decks: Array<{ id: string; title: string }>;
  loading: boolean;
  error?: string;
} {
  const [state, setState] = React.useState<{
    decks: Array<{ id: string; title: string }>;
    loading: boolean;
    error?: string;
  }>({ decks: [], loading: !!(parentNoteId && projectId) });

  React.useEffect(() => {
    if (!parentNoteId || !projectId) {
      setState({ decks: [], loading: false });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    void (async () => {
      try {
        const res = await fetch(
          `${syncBase()}/wpn/projects/${encodeURIComponent(projectId)}/notes`,
          { headers: authHeaders(), credentials: "omit" },
        );
        if (!res.ok) {
          if (!cancelled)
            setState({ decks: [], loading: false, error: `GET ${res.status}` });
          return;
        }
        const body = (await res.json()) as {
          notes?: Array<{
            id: string;
            title: string;
            type: string;
            parent_id: string | null;
            sibling_index: number;
          }>;
        };
        const matches = (body.notes ?? [])
          .filter((n) => n.parent_id === parentNoteId && n.type === "markdown")
          .sort((a, b) => a.sibling_index - b.sibling_index)
          .map((n) => ({ id: n.id, title: n.title }));
        if (!cancelled) setState({ decks: matches, loading: false });
      } catch (e) {
        if (!cancelled)
          setState({ decks: [], loading: false, error: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parentNoteId, projectId]);

  return state;
}

/**
 * `<DeckPicker>` — pick one of the markdown children of `parentNoteId` and
 * render it through `<Slideshow>`. Lets the Welcome screen carry several
 * audience-tailored decks without re-editing the note each time a new deck
 * is added — drop a markdown note under the parent and it shows up here.
 *
 * Selection is local React state (resets on reload). Pass `selectedKey` to
 * persist the chosen deck id across reloads via `useProjectState`.
 */
export function DeckPicker({
  parentNoteId,
  selectedKey,
  emptyLabel,
}: {
  parentNoteId?: string;
  selectedKey?: string;
  emptyLabel?: string;
}): React.ReactElement {
  const projectId = useProjectId();
  const { decks, loading, error } = useMarkdownChildren(parentNoteId, projectId);

  const [persistedId, setPersistedId] = useProjectState<string>(
    selectedKey || "__deckpicker_unbound",
    "",
  );
  const [localId, setLocalId] = React.useState<string>("");
  const usePersisted = !!selectedKey;
  const selectedRaw = usePersisted ? persistedId : localId;

  // Default to the first deck once the list loads. If the persisted id no
  // longer matches any child (deck deleted or renamed), fall back too.
  const selectedId = React.useMemo(() => {
    if (decks.length === 0) return "";
    const present = decks.some((d) => d.id === selectedRaw);
    return present ? selectedRaw : decks[0]!.id;
  }, [decks, selectedRaw]);

  const select = React.useCallback(
    (id: string): void => {
      if (usePersisted) setPersistedId(id);
      else setLocalId(id);
    },
    [usePersisted, setPersistedId],
  );

  if (!parentNoteId) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-[13px] text-muted-foreground">
        DeckPicker: <code>parentNoteId</code> is required.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="rounded-md border border-border p-3 text-[13px] text-muted-foreground">
        Loading decks…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-border p-3 text-[13px] text-red-600">
        DeckPicker error: {error}
      </div>
    );
  }
  if (decks.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-[13px] text-muted-foreground">
        {emptyLabel || "No decks yet — add a markdown child note under the collection."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Pick a deck">
        {decks.map((d) => {
          const active = d.id === selectedId;
          return (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => select(d.id)}
              className={
                "rounded-full border px-3 py-1 text-[13px] font-medium transition-colors " +
                (active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-foreground hover:bg-muted/40")
              }
            >
              {d.title}
            </button>
          );
        })}
      </div>
      <Slideshow noteId={selectedId} />
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
    Code,
    Slideshow,
    DeckPicker,
  } as unknown as Record<string, React.ComponentType<Record<string, unknown>>>;
}
