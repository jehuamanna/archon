import * as React from "react";
import { useSDKContext } from "./context";

type Dispatch<T> = (next: T | ((prev: T) => T)) => void;

/**
 * Primary state primitive — each `key` is its own Mongo doc (`project_state_head`).
 * Optimistic local echo; reconciles on server ack.
 */
export function useProjectState<T>(
  key: string,
  initial?: T,
): [T, Dispatch<T>] {
  const ctx = useSDKContext();
  const [value, setValue] = React.useState<T>((initial as T) ?? (undefined as unknown as T));
  const versionRef = React.useRef<number>(0);
  const pendingRef = React.useRef<number | null>(null);

  // Mount: fetch current value.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await ctx.transport.getAuthToken();
        const res = await fetch(
          `${ctx.transport.apiBaseUrl}/projects/${encodeURIComponent(
            ctx.project.id,
          )}/mdx-state/${encodeURIComponent(key)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            credentials: "include",
          },
        );
        if (cancelled) return;
        if (res.status === 200) {
          const body = (await res.json()) as { value: T; version: number };
          versionRef.current = body.version;
          setValue(body.value);
        } else if (res.status === 404) {
          versionRef.current = 0;
          if (initial !== undefined) setValue(initial);
        }
      } catch {
        /* swallow — UI will stay on optimistic/initial */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.project.id, ctx.transport, key, initial]);

  // Live updates via shared WebSocket (see ws-client.ts in host).
  React.useEffect(() => {
    const handler = (frame: {
      projectId: string;
      key: string;
      version: number;
      mode: "inline" | "chunked";
      value?: unknown;
    }) => {
      if (frame.projectId !== ctx.project.id) return;
      if (frame.key !== key) return;
      if (frame.version <= versionRef.current) return;
      versionRef.current = frame.version;
      if (frame.mode === "inline" && "value" in frame) {
        setValue(frame.value as T);
      } else {
        // Chunked — refetch.
        void (async () => {
          const token = await ctx.transport.getAuthToken();
          const res = await fetch(
            `${ctx.transport.apiBaseUrl}/projects/${encodeURIComponent(
              ctx.project.id,
            )}/mdx-state/${encodeURIComponent(key)}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              credentials: "include",
            },
          );
          if (res.ok) {
            const body = (await res.json()) as { value: T; version: number };
            versionRef.current = body.version;
            setValue(body.value);
          }
        })();
      }
    };
    const unsub = subscribeToStateFrames(ctx, handler);
    return unsub;
  }, [ctx, key]);

  const set = React.useCallback<Dispatch<T>>(
    (next) => {
      if (ctx.readOnly) return;
      setValue((prev) => {
        const nextValue =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        // Optimistic echo; debounce the PUT.
        if (pendingRef.current !== null) {
          window.clearTimeout(pendingRef.current);
        }
        pendingRef.current = window.setTimeout(() => {
          void (async () => {
            const token = await ctx.transport.getAuthToken();
            const res = await fetch(
              `${ctx.transport.apiBaseUrl}/projects/${encodeURIComponent(
                ctx.project.id,
              )}/mdx-state/${encodeURIComponent(key)}`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                  "If-Match": String(versionRef.current),
                },
                credentials: "include",
                body: JSON.stringify({ value: nextValue }),
              },
            );
            if (res.status === 200) {
              const body = (await res.json()) as { version: number };
              versionRef.current = body.version;
            }
            // On 409: fetch current, rebase — simple "server wins" v1.
            if (res.status === 409) {
              const get = await fetch(
                `${ctx.transport.apiBaseUrl}/projects/${encodeURIComponent(
                  ctx.project.id,
                )}/mdx-state/${encodeURIComponent(key)}`,
                {
                  headers: { Authorization: `Bearer ${token}` },
                  credentials: "include",
                },
              );
              if (get.ok) {
                const body = (await get.json()) as { value: T; version: number };
                versionRef.current = body.version;
                setValue(body.value);
              }
            }
          })();
        }, 50);
        return nextValue;
      });
    },
    [ctx, key],
  );

  return [value, set];
}

export function useNote(idOrTitle: string): {
  source: string;
  loading: boolean;
  error?: Error;
} {
  const ctx = useSDKContext();
  const [state, setState] = React.useState<{
    source: string;
    loading: boolean;
    error?: Error;
  }>({ source: "", loading: true });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await ctx.transport.getAuthToken();
        const url = `${ctx.transport.apiBaseUrl}/projects/${encodeURIComponent(
          ctx.project.id,
        )}/notes/resolve?ref=${encodeURIComponent(idOrTitle)}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({
            source: "",
            loading: false,
            error: new Error(`useNote: ${res.status}`),
          });
          return;
        }
        const body = (await res.json()) as { content: string };
        setState({ source: body.content, loading: false });
      } catch (err) {
        if (!cancelled) {
          setState({ source: "", loading: false, error: err as Error });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, idOrTitle]);

  return state;
}

export interface QuerySpec {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
}

export function useQuery<T = unknown>(spec: QuerySpec): {
  data?: T;
  loading: boolean;
  error?: Error;
} {
  const ctx = useSDKContext();
  const [state, setState] = React.useState<{
    data?: T;
    loading: boolean;
    error?: Error;
  }>({ loading: true });
  const cacheKey = JSON.stringify({
    url: spec.url,
    method: spec.method ?? "GET",
    body: spec.body,
  });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sameOrigin = ctx.transport.isSameOrigin?.(spec.url) ?? false;
        const res = await fetch(spec.url, {
          method: spec.method ?? "GET",
          headers: spec.headers,
          body: spec.body ? JSON.stringify(spec.body) : undefined,
          credentials: sameOrigin ? "include" : "omit",
        });
        if (cancelled) return;
        const contentType = res.headers.get("content-type") ?? "";
        const data = contentType.includes("json")
          ? ((await res.json()) as T)
          : ((await res.text()) as unknown as T);
        setState({ data, loading: false });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err as Error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.transport, cacheKey, spec.url, spec.method, spec.headers, spec.body]);

  return state;
}

export function useMutation<TBody = unknown, TResp = unknown>(
  spec: Omit<QuerySpec, "body">,
): {
  mutate: (body: TBody) => Promise<TResp>;
  loading: boolean;
  error?: Error;
} {
  const ctx = useSDKContext();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | undefined>(undefined);

  const mutate = React.useCallback(
    async (body: TBody): Promise<TResp> => {
      setLoading(true);
      setError(undefined);
      try {
        const sameOrigin = ctx.transport.isSameOrigin?.(spec.url) ?? false;
        const res = await fetch(spec.url, {
          method: spec.method ?? "POST",
          headers: {
            "Content-Type": "application/json",
            ...(spec.headers ?? {}),
          },
          body: JSON.stringify(body),
          credentials: sameOrigin ? "include" : "omit",
        });
        const contentType = res.headers.get("content-type") ?? "";
        const data = contentType.includes("json")
          ? ((await res.json()) as TResp)
          : ((await res.text()) as unknown as TResp);
        setLoading(false);
        return data;
      } catch (err) {
        setError(err as Error);
        setLoading(false);
        throw err;
      }
    },
    [ctx.transport, spec.url, spec.method, spec.headers],
  );

  return { mutate, loading, error };
}

export function useBacklinks(noteId: string): {
  backlinks: Array<{ id: string; title: string }>;
  loading: boolean;
} {
  const ctx = useSDKContext();
  const [state, setState] = React.useState<{
    backlinks: Array<{ id: string; title: string }>;
    loading: boolean;
  }>({ backlinks: [], loading: true });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await ctx.transport.getAuthToken();
      const res = await fetch(
        `${ctx.transport.apiBaseUrl}/notes/${encodeURIComponent(noteId)}/backlinks`,
        {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
        },
      );
      if (!cancelled && res.ok) {
        const body = (await res.json()) as {
          backlinks: Array<{ id: string; title: string }>;
        };
        setState({ backlinks: body.backlinks, loading: false });
      } else if (!cancelled) {
        setState({ backlinks: [], loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.transport, noteId]);

  return state;
}

export function useCurrentUser(): {
  id: string;
  email: string;
  displayName?: string;
} {
  const { user } = useSDKContext();
  return user;
}

export function useProjectNotes(): {
  notes: Array<{ id: string; title: string; type: string }>;
  loading: boolean;
} {
  const ctx = useSDKContext();
  const [state, setState] = React.useState<{
    notes: Array<{ id: string; title: string; type: string }>;
    loading: boolean;
  }>({ notes: [], loading: true });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await ctx.transport.getAuthToken();
      const res = await fetch(
        `${ctx.transport.apiBaseUrl}/projects/${encodeURIComponent(
          ctx.project.id,
        )}/notes?fields=id,title,type`,
        {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
        },
      );
      if (!cancelled && res.ok) {
        const body = (await res.json()) as {
          notes: Array<{ id: string; title: string; type: string }>;
        };
        setState({ notes: body.notes, loading: false });
      } else if (!cancelled) {
        setState({ notes: [], loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.transport, ctx.project.id]);

  return state;
}

/* ---- WS pub/sub shared across hook instances ------------------------- */

type StateFrame = {
  projectId: string;
  key: string;
  version: number;
  mode: "inline" | "chunked";
  value?: unknown;
};
type StateFrameListener = (frame: StateFrame) => void;

interface WsRegistry {
  listeners: Set<StateFrameListener>;
  socket: WebSocket | null;
  connecting: boolean;
}

const wsRegistries = new WeakMap<object, WsRegistry>();

function getRegistry(ctx: object): WsRegistry {
  const reg = wsRegistries.get(ctx);
  if (reg) return reg;
  const next: WsRegistry = { listeners: new Set(), socket: null, connecting: false };
  wsRegistries.set(ctx, next);
  return next;
}

function subscribeToStateFrames(
  ctx: ReturnType<typeof useSDKContext>,
  listener: StateFrameListener,
): () => void {
  const reg = getRegistry(ctx as unknown as object);
  reg.listeners.add(listener);
  void ensureSocket(ctx, reg);
  return () => {
    reg.listeners.delete(listener);
    if (reg.listeners.size === 0 && reg.socket) {
      reg.socket.close();
      reg.socket = null;
    }
  };
}

async function ensureSocket(
  ctx: ReturnType<typeof useSDKContext>,
  reg: WsRegistry,
): Promise<void> {
  if (reg.socket || reg.connecting) return;
  reg.connecting = true;
  try {
    const token = await ctx.transport.getAuthToken();
    const url = `${ctx.transport.wsUrl}?token=${encodeURIComponent(
      token,
    )}&projectId=${encodeURIComponent(ctx.project.id)}`;
    const socket = new WebSocket(url);
    socket.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as StateFrame;
        for (const listener of reg.listeners) listener(frame);
      } catch {
        /* ignore malformed frame */
      }
    };
    socket.onclose = () => {
      reg.socket = null;
    };
    reg.socket = socket;
  } finally {
    reg.connecting = false;
  }
}
