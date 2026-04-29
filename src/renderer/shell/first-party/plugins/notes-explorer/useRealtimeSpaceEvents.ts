import { useEffect, useRef, useState } from "react";
import { createSyncBaseUrlResolver } from "@archon/platform";
import { authedFetch } from "../../../../auth/auth-retry";

/**
 * Subscribe to realtime structural events on the active space's WebSocket
 * channel. Replaces 8 s polling for the WPN tree — when the server
 * fans out a `note.created / moved / renamed / deleted` (or
 * `edge.added/removed`) event for a space we're connected to, the caller
 * receives it immediately and can refetch only what changed.
 *
 * Lifecycle:
 *   1. Mint a 5 min `typ: "wsClient"` JWT via `POST /v1/realtime/ws-token`.
 *   2. Open `ws://…/v1/ws/realtime/:orgId?token=<jwt>`.
 *   3. Forward every `{ type: "event", payload }` frame to `onEvent`.
 *   4. On close 4401 (token expired), re-mint and reconnect immediately.
 *      On other closes, reconnect with capped exponential backoff.
 *   5. Caller polls a fallback timer only when `connected === false`.
 *
 * The hook itself doesn't process events — it returns a connection state
 * flag plus the latest event so the caller can drive their own refresh
 * logic. Callers that just want a "something changed" signal can debounce
 * on the returned `lastEventAt` ms epoch.
 */

type RealtimeStructuralEvent =
  | {
      type:
        | "note.created"
        | "note.moved"
        | "note.renamed"
        | "note.deleted";
      noteId: string;
      projectId: string;
      [k: string]: unknown;
    }
  | {
      type: "edge.added" | "edge.removed";
      src: string;
      dst: string;
      kind: string;
      [k: string]: unknown;
    };

interface ServerFrame {
  type: "event" | "presence.update" | "error";
  payload?: RealtimeStructuralEvent;
  [k: string]: unknown;
}

const resolveSyncBase = createSyncBaseUrlResolver();

function syncBaseToWsBase(syncBase: string): string {
  // syncBase is e.g. http://127.0.0.1:4010/api/v1.
  // → ws://127.0.0.1:4010/api/v1
  return syncBase.replace(/^http(s?):/, "ws$1:");
}

function isLoopbackBrowserPage(): boolean {
  if (typeof window === "undefined") return true;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * Decide which host serves the WebSocket. WS is HTTP-different in two ways
 * the rest of the sync-api isn't: the route handler in Next.js dev uses
 * `app.inject()`, which can't return `101 Switching Protocols`. So when
 * `NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN=1` (HTTP routed through Next on
 * :3000), the WS upgrade has to be redirected to a process that can speak
 * the protocol — the standalone Fastify sync-api on :4010, which has
 * `@fastify/websocket` registered.
 *
 * Precedence:
 * 1. `NEXT_PUBLIC_ARCHON_REALTIME_WS_URL` (explicit override).
 * 2. Same-origin + loopback page → hard-wire to `ws://127.0.0.1:4010/api/v1`.
 * 3. Otherwise convert the resolved sync-api base by swapping the scheme.
 *    Works for direct-loopback dev, and for nginx in prod where the
 *    upstream is configured to proxy WS upgrades.
 */
function resolveRealtimeWsBase(syncBase: string): string {
  try {
    const explicit =
      typeof process !== "undefined" &&
      typeof process.env?.NEXT_PUBLIC_ARCHON_REALTIME_WS_URL === "string"
        ? process.env.NEXT_PUBLIC_ARCHON_REALTIME_WS_URL.trim()
        : "";
    if (explicit) {
      return explicit.replace(/\/$/, "").replace(/^http(s?):/, "ws$1:");
    }
  } catch {
    /* ignore — process may be unavailable */
  }
  try {
    const sameOrigin =
      typeof process !== "undefined" &&
      (process.env?.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "1" ||
        process.env?.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "true");
    if (sameOrigin && isLoopbackBrowserPage()) {
      // Dev fallback: same-origin can't carry WS through Next.js dev. Point
      // at the standalone Fastify sync-api (default port from server-env.ts).
      return "ws://127.0.0.1:4010/api/v1";
    }
  } catch {
    /* ignore */
  }
  return syncBaseToWsBase(syncBase);
}

async function mintRealtimeWsToken(
  syncBase: string,
  orgId: string,
): Promise<string> {
  const res = await authedFetch({
    method: "POST",
    url: `${syncBase.replace(/\/$/, "")}/realtime/ws-token`,
    headersWithoutAuth: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId }),
    credentials: "omit",
  });
  if (!res.ok) {
    throw new Error(`ws-token mint failed: HTTP ${res.status}`);
  }
  const { token } = (await res.json()) as { token: string };
  if (!token) throw new Error("ws-token mint: empty token");
  return token;
}

export interface UseRealtimeSpaceEventsResult {
  connected: boolean;
  lastEventAt: number;
  lastEvent: RealtimeStructuralEvent | null;
}

/**
 * Returns `{ connected, lastEventAt, lastEvent }`. Callers typically drive
 * a refresh effect off `lastEventAt`.
 */
export function useRealtimeSpaceEvents(
  spaceId: string | null,
  onEvent?: (evt: RealtimeStructuralEvent) => void,
): UseRealtimeSpaceEventsResult {
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState(0);
  const [lastEvent, setLastEvent] =
    useState<RealtimeStructuralEvent | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!spaceId) {
      setConnected(false);
      return;
    }
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const scheduleReconnect = (delayMs: number): void => {
      if (cancelled) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delayMs);
    };

    const connect = async (): Promise<void> => {
      if (cancelled) return;
      const syncBase = resolveSyncBase().trim().replace(/\/$/, "");
      if (syncBase.length === 0) {
        // No sync-api wired in this environment — caller's polling fallback
        // will continue to drive refreshes.
        setConnected(false);
        return;
      }
      let token: string;
      try {
        token = await mintRealtimeWsToken(syncBase, spaceId);
      } catch (err) {
        if (cancelled) return;
        attempt++;
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        // eslint-disable-next-line no-console
        console.warn("[realtime] token mint failed, retrying:", err);
        scheduleReconnect(backoff);
        return;
      }
      if (cancelled) return;

      const wsBase = resolveRealtimeWsBase(syncBase);
      const url = `${wsBase}/ws/realtime/${encodeURIComponent(spaceId)}?token=${encodeURIComponent(token)}`;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        attempt++;
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        // eslint-disable-next-line no-console
        console.warn("[realtime] WS construct failed, retrying:", err);
        scheduleReconnect(backoff);
        return;
      }

      socket.onopen = (): void => {
        attempt = 0;
        setConnected(true);
      };
      socket.onmessage = (msg: MessageEvent): void => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(
            typeof msg.data === "string" ? msg.data : String(msg.data),
          ) as ServerFrame;
        } catch {
          return;
        }
        if (frame.type === "event" && frame.payload) {
          const evt = frame.payload;
          setLastEvent(evt);
          setLastEventAt(Date.now());
          try {
            onEventRef.current?.(evt);
          } catch {
            /* user handler errors must not tear the socket down */
          }
        }
      };
      socket.onclose = (ev: CloseEvent): void => {
        setConnected(false);
        if (cancelled) return;
        // 4401 = token expired or invalid → re-mint immediately.
        // 4403 = no access (revocation) → don't auto-reconnect.
        // 1000 = normal close (we initiated cleanup) → stop.
        if (ev.code === 4403) return;
        if (ev.code === 1000) return;
        if (ev.code === 4401) {
          attempt = 0;
          scheduleReconnect(50);
          return;
        }
        attempt++;
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        scheduleReconnect(backoff);
      };
      socket.onerror = (): void => {
        // onclose will fire next; don't double-handle.
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        try {
          socket.close(1000, "unmount");
        } catch {
          /* noop */
        }
      }
      setConnected(false);
    };
  }, [spaceId]);

  return { connected, lastEventAt, lastEvent };
}
