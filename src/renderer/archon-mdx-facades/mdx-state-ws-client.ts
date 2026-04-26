/**
 * Project-scoped WebSocket client for mdx-state push notifications.
 *
 * One socket per (projectId), shared by every `useProjectState` hook bound to
 * that project, regardless of stateKey. The server route at `/api/v1/ws/mdx-state`
 * delivers a frame per state change:
 *
 *   { projectId, key, version, mode: "inline" | "chunked" | "absent", value? }
 *
 * Inline frames carry the new value directly — the consumer can update React
 * state without a follow-up GET. Chunked/absent frames carry only key+version,
 * and the consumer is expected to refetch that one key.
 *
 * Token: minted via `POST /api/v1/mdx-state/ws-token` (5-minute `typ:"mdxWs"`
 * JWT, per-project). Re-minted on every reconnect so wake-from-sleep works.
 *
 * Reconnect: exponential backoff (1s → 30s cap). On reconnect the socket
 * notifies subscribers via `onConnectionChange(true)`, which they use to fire
 * a catch-up read for any updates missed while disconnected.
 */
import { createSyncBaseUrlResolver } from "@archon/platform";
import { readCloudSyncToken } from "../cloud-sync/cloud-sync-storage";

const resolveSyncBase = createSyncBaseUrlResolver();

function syncBaseHttp(): string {
  return resolveSyncBase().trim().replace(/\/$/, "") || "/api/v1";
}

function isLoopbackBrowserPage(): boolean {
  if (typeof window === "undefined") return true;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Mirrors `useYjsBodyShadow.resolveRealtimeWsBase` so both WS surfaces pick the same host. */
function syncBaseWs(): string {
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
    /* ignore */
  }
  try {
    const sameOrigin =
      typeof process !== "undefined" &&
      (process.env?.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "1" ||
        process.env?.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "true");
    if (sameOrigin && isLoopbackBrowserPage()) {
      return "ws://127.0.0.1:4010/api/v1";
    }
  } catch {
    /* ignore */
  }
  return syncBaseHttp().replace(/^http(s?):/, "ws$1:");
}

export interface MdxStateFrame {
  projectId: string;
  key: string;
  version: number;
  mode: "inline" | "chunked" | "absent";
  value?: unknown;
}

export type MdxStateFrameListener = (frame: MdxStateFrame) => void;
export type MdxStateConnectionListener = (connected: boolean) => void;

interface ProjectRegistry {
  projectId: string;
  socket: WebSocket | null;
  connecting: boolean;
  shouldClose: boolean;
  listeners: Set<MdxStateFrameListener>;
  connectionListeners: Set<MdxStateConnectionListener>;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  closeGraceTimer: ReturnType<typeof setTimeout> | null;
}

const registries = new Map<string, ProjectRegistry>();

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Hold the socket open briefly after the last listener leaves so that
 *  navigating between notes on the same project doesn't churn the connection. */
const CLOSE_GRACE_MS = 5_000;

async function mintMdxStateWsToken(projectId: string): Promise<string | null> {
  try {
    const token = readCloudSyncToken();
    if (!token) return null;
    const res = await fetch(`${syncBaseHttp()}/mdx-state/ws-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      credentials: "omit",
      body: JSON.stringify({ projectId }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}

function notifyConnection(reg: ProjectRegistry, connected: boolean): void {
  for (const cb of reg.connectionListeners) {
    try {
      cb(connected);
    } catch {
      /* ignore */
    }
  }
}

function scheduleReconnect(reg: ProjectRegistry): void {
  if (reg.shouldClose) return;
  if (reg.reconnectTimer) return;
  const attempt = reg.reconnectAttempt++;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  reg.reconnectTimer = setTimeout(() => {
    reg.reconnectTimer = null;
    void ensureSocket(reg);
  }, delay);
}

async function ensureSocket(reg: ProjectRegistry): Promise<void> {
  if (reg.socket || reg.connecting || reg.shouldClose) return;
  reg.connecting = true;
  let opened = false;
  try {
    const wsToken = await mintMdxStateWsToken(reg.projectId);
    if (!wsToken || reg.shouldClose) {
      return;
    }
    const url = `${syncBaseWs()}/ws/mdx-state?token=${encodeURIComponent(
      wsToken,
    )}&projectId=${encodeURIComponent(reg.projectId)}`;
    const socket = new WebSocket(url);
    reg.socket = socket;
    opened = true;
    socket.onopen = () => {
      reg.reconnectAttempt = 0;
      notifyConnection(reg, true);
    };
    socket.onmessage = (ev) => {
      let parsed: (MdxStateFrame & { type?: string }) | null = null;
      try {
        parsed = JSON.parse(String(ev.data)) as MdxStateFrame & {
          type?: string;
        };
      } catch {
        return;
      }
      if (!parsed || parsed.type === "error") return;
      if (typeof parsed.key !== "string" || typeof parsed.version !== "number") {
        return;
      }
      const frame: MdxStateFrame = parsed;
      for (const cb of reg.listeners) {
        try {
          cb(frame);
        } catch {
          /* ignore */
        }
      }
    };
    socket.onclose = () => {
      reg.socket = null;
      notifyConnection(reg, false);
      if (!reg.shouldClose) scheduleReconnect(reg);
    };
    socket.onerror = () => {
      // onclose follows; nothing to do.
    };
  } finally {
    reg.connecting = false;
    if (!opened && !reg.shouldClose) scheduleReconnect(reg);
  }
}

function tearDown(reg: ProjectRegistry): void {
  reg.shouldClose = true;
  if (reg.reconnectTimer) {
    clearTimeout(reg.reconnectTimer);
    reg.reconnectTimer = null;
  }
  if (reg.closeGraceTimer) {
    clearTimeout(reg.closeGraceTimer);
    reg.closeGraceTimer = null;
  }
  if (reg.socket) {
    try {
      reg.socket.close();
    } catch {
      /* ignore */
    }
    reg.socket = null;
  }
  registries.delete(reg.projectId);
}

export function subscribeProjectStateFrames(
  projectId: string,
  onFrame: MdxStateFrameListener,
  onConnectionChange?: MdxStateConnectionListener,
): () => void {
  let reg = registries.get(projectId);
  if (!reg) {
    reg = {
      projectId,
      socket: null,
      connecting: false,
      shouldClose: false,
      listeners: new Set(),
      connectionListeners: new Set(),
      reconnectTimer: null,
      reconnectAttempt: 0,
      closeGraceTimer: null,
    };
    registries.set(projectId, reg);
  }
  if (reg.closeGraceTimer) {
    clearTimeout(reg.closeGraceTimer);
    reg.closeGraceTimer = null;
  }
  reg.listeners.add(onFrame);
  if (onConnectionChange) {
    reg.connectionListeners.add(onConnectionChange);
    onConnectionChange(reg.socket?.readyState === WebSocket.OPEN);
  }
  void ensureSocket(reg);
  const localReg = reg;
  return () => {
    localReg.listeners.delete(onFrame);
    if (onConnectionChange) {
      localReg.connectionListeners.delete(onConnectionChange);
    }
    if (localReg.listeners.size === 0) {
      localReg.closeGraceTimer = setTimeout(() => {
        if (localReg.listeners.size === 0) tearDown(localReg);
      }, CLOSE_GRACE_MS);
    }
  };
}
