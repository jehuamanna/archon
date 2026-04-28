import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { createSyncBaseUrlResolver } from "@archon/platform";
import { authedFetch } from "../../../../auth/auth-retry";

/**
 * Per-note Yjs shadow doc bound to the Hocuspocus body-collab WebSocket
 * (`/v1/ws/yjs/:noteId` on the standalone sync-api). Replaces per-keystroke
 * HTTP PATCH /wpn/notes/:id with binary Yjs updates over WS. The editor
 * remains plain-text in the local CodeMirror; we just maintain a shadow
 * `Y.Text("content")` and push the latest editor value into it on each
 * debounced flush — Yjs computes the minimal update and frames it over WS.
 *
 * On `pushLatest(text)`:
 *   - If WS is connected: replace the Y.Text contents (Yjs diffs internally
 *     so only the changed bytes go on the wire), return true → caller
 *     suppresses its HTTP PATCH.
 *   - If WS is not connected: return false → caller falls back to its
 *     existing HTTP debounced save.
 *
 * Server bridges Y.Text → `wpn_notes.content` in `onStoreDocument`, so the
 * legacy HTTP detail / list / export endpoints stay in sync.
 */

const resolveSyncBase = createSyncBaseUrlResolver();

function isLoopbackBrowserPage(): boolean {
  if (typeof window === "undefined") return true;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Mirror of `useRealtimeSpaceEvents.resolveRealtimeWsBase` — same rules. */
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
  return syncBase.replace(/^http(s?):/, "ws$1:");
}

async function mintSpaceWsToken(
  syncBase: string,
  spaceId: string,
): Promise<string | null> {
  try {
    const res = await authedFetch({
      method: "POST",
      url: `${syncBase.replace(/\/$/, "")}/realtime/ws-token`,
      headersWithoutAuth: { "Content-Type": "application/json" },
      body: JSON.stringify({ spaceId }),
      credentials: "omit",
    });
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token?: string };
    return token ?? null;
  } catch {
    return null;
  }
}

export interface YjsBodyShadow {
  /** Push the latest editor text into Y.Text("content"). Returns true if the
   * push went on the wire (caller should skip its HTTP fallback). */
  pushLatest(text: string): boolean;
  /** True once the WS handshake completes. Drives the polling-fallback flag
   * the same way `useRealtimeSpaceEvents` does for the explorer. */
  connected: boolean;
}

/**
 * Open a Hocuspocus connection for `noteId` while the hook is mounted.
 * `spaceId` is required for the ws-token mint; if either is null, the
 * hook stays inert and `connected` remains false (caller falls back to
 * HTTP).
 */
export function useYjsBodyShadow(
  noteId: string | null,
  spaceId: string | null,
  onRemoteChange?: (text: string) => void,
): YjsBodyShadow {
  const [connected, setConnected] = useState(false);
  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const lastPushedRef = useRef<string | null>(null);
  // Sentinel used as the Y.Transaction origin for our own pushLatest writes
  // so the observer (below) can ignore them. Anything else — diffs the WS
  // applies on remote updates, including out-of-band writes from MCP — comes
  // through with a different origin and reaches `onRemoteChange`.
  const localOriginRef = useRef<symbol>(Symbol("yjs-body-shadow-local"));
  const onRemoteChangeRef = useRef(onRemoteChange);
  onRemoteChangeRef.current = onRemoteChange;
  const observerRef = useRef<{
    ytext: Y.Text;
    observer: (event: Y.YTextEvent, txn: Y.Transaction) => void;
  } | null>(null);

  useEffect(() => {
    if (!noteId || !spaceId) {
      // eslint-disable-next-line no-console
      console.debug(
        "[yjs-body] inert",
        { noteId: !!noteId, spaceId: !!spaceId },
      );
      setConnected(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const syncBase = resolveSyncBase().trim().replace(/\/$/, "");
      if (!syncBase) {
        // eslint-disable-next-line no-console
        console.debug("[yjs-body] no sync base resolved");
        setConnected(false);
        return;
      }
      const token = await mintSpaceWsToken(syncBase, spaceId);
      if (cancelled || !token) {
        // eslint-disable-next-line no-console
        console.debug("[yjs-body] token mint failed", {
          spaceId,
          syncBase,
        });
        setConnected(false);
        return;
      }
      const wsBase = resolveRealtimeWsBase(syncBase);
      // Hocuspocus connects to `url` verbatim (it sends `name` in the auth
      // protocol message, not in the URL path). The server route is mounted
      // at `/api/v1/ws/yjs`, so the base must include `/ws/yjs`.
      const wsUrl = `${wsBase.replace(/\/$/, "")}/ws/yjs`;
      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: wsUrl,
        name: noteId,
        document: doc,
        token,
        onAuthenticationFailed: ({ reason }) => {
          // eslint-disable-next-line no-console
          console.warn("[yjs-body] auth failed:", reason);
        },
        onClose: () => {
          if (!cancelled) setConnected(false);
        },
      });
      docRef.current = doc;
      providerRef.current = provider;
      // Wait until handshake completes — `synced` flips once the server
      // sends the initial state. Until then, pushLatest() returns false.
      const onStatus = (): void => {
        if (cancelled) return;
        const ok = provider.synced && provider.isConnected;
        // eslint-disable-next-line no-console
        console.debug("[yjs-body] status", {
          synced: provider.synced,
          connected: provider.isConnected,
          flag: ok,
        });
        setConnected(ok);
      };
      provider.on("status", onStatus);
      provider.on("synced", onStatus);
      onStatus();

      // Observe remote diffs (including out-of-band writes from MCP) and
      // pump them up to the host editor so its React/CodeMirror state stays
      // in sync. Without this, the editor stays empty after a remote write
      // and its next pushLatest clobbers the live Y.Doc with the stale
      // local text — silently reverting MCP / cross-tab edits.
      const ytext = doc.getText("content");
      const observer = (_event: Y.YTextEvent, txn: Y.Transaction): void => {
        if (cancelled) return;
        if (txn.origin === localOriginRef.current) return;
        const next = ytext.toString();
        lastPushedRef.current = next;
        onRemoteChangeRef.current?.(next);
      };
      ytext.observe(observer);
      observerRef.current = { ytext, observer };

      // Fire once on initial sync so the editor adopts whatever the server
      // already had (handles the case where MCP wrote before the editor
      // connected).
      const fireSyncedOnce = (): void => {
        if (cancelled) return;
        const next = ytext.toString();
        lastPushedRef.current = next;
        onRemoteChangeRef.current?.(next);
      };
      if (provider.synced) fireSyncedOnce();
      else provider.on("synced", fireSyncedOnce);
    })();

    return () => {
      cancelled = true;
      setConnected(false);
      const p = providerRef.current;
      const d = docRef.current;
      const obs = observerRef.current;
      providerRef.current = null;
      docRef.current = null;
      observerRef.current = null;
      lastPushedRef.current = null;
      if (obs) {
        try {
          obs.ytext.unobserve(obs.observer);
        } catch {
          /* noop */
        }
      }
      if (p) {
        try {
          p.disconnect();
          p.destroy();
        } catch {
          /* noop */
        }
      }
      if (d) {
        try {
          d.destroy();
        } catch {
          /* noop */
        }
      }
    };
  }, [noteId, spaceId]);

  return useMemo(
    () => ({
      connected,
      pushLatest(text: string): boolean {
        const doc = docRef.current;
        if (!doc || !connected) return false;
        if (lastPushedRef.current === text) return true; // no-op skip
        const ytext = doc.getText("content");
        const current = ytext.toString();
        if (current === text) {
          lastPushedRef.current = text;
          return true;
        }
        try {
          // One Yjs transaction → one diff frame on the wire. The origin
          // sentinel lets our remote-diff observer (above) skip this write
          // so we don't echo our own text back into the editor's React
          // state.
          doc.transact(() => {
            ytext.delete(0, ytext.length);
            ytext.insert(0, text);
          }, localOriginRef.current);
          lastPushedRef.current = text;
          return true;
        } catch {
          return false;
        }
      },
    }),
    [connected],
  );
}
