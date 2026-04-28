import { useEffect, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { createSyncBaseUrlResolver } from "@archon/platform";
import { authedFetch } from "../../../../auth/auth-retry";

/**
 * Per-note Yjs body collaboration hook. Opens a Hocuspocus WebSocket
 * connection (`/v1/ws/yjs/:noteId` on the standalone sync-api) and exposes
 * the live `Y.Text("content")` so the editor can bind a CodeMirror
 * extension (`yCollab(...)` from `y-codemirror.next`) directly to it.
 *
 * yCollab makes the Y.Text the single source of truth and binds it to
 * CodeMirror with the right transaction origins so local edits never echo
 * and remote edits land in the visible editor without React intermediation.
 *
 * Server bridges Y.Text → `wpn_notes.content` in `onStoreDocument`, so
 * the legacy HTTP detail / list / export endpoints stay in sync.
 */

const resolveSyncBase = createSyncBaseUrlResolver();

/**
 * Stable Y.Doc cache keyed by `noteId`. The hook's effect re-runs every
 * time `spaceId` changes (e.g. on auth / membership flicker), and React
 * StrictMode mounts effects twice in dev — both produce hook re-runs.
 * If we created a fresh Y.Doc on every re-run, the editor's yCollab
 * extension would briefly see a Y.Text whose `parent`/`doc` chain has
 * been torn down while React was still rendering the previous one,
 * crashing y-codemirror.next's ySync plugin with
 * "Cannot read properties of null (reading 'parent')".
 *
 * Keeping one Y.Doc per noteId means yCollab always binds to a stable
 * reference. The HocuspocusProvider attaches/detaches as the WS lifecycle
 * dictates, but the underlying CRDT state and observers stay put. Memory
 * cost: one Y.Doc per note touched in this session — small, and HMR
 * resets the module, so dev iteration doesn't accumulate.
 */
const noteDocCache = new Map<string, { doc: Y.Doc; ytext: Y.Text }>();

function getOrCreateNoteDoc(noteId: string): { doc: Y.Doc; ytext: Y.Text } {
  const cached = noteDocCache.get(noteId);
  if (cached) return cached;
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  const entry = { doc, ytext };
  noteDocCache.set(noteId, entry);
  return entry;
}

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
  /** Live `Y.Text("content")` bound to this note. Stable across hook
   * re-runs for the same noteId — pass to `yCollab()` as the first
   * argument. Null while the hook is inert (no `noteId` / no `spaceId`). */
  yText: Y.Text | null;
  /** True once the Hocuspocus handshake completes. Drives the editor's
   * HTTP autosave fallback: when false, the editor saves via REST
   * `saveNoteContent` because Y.Doc edits won't reach the server. */
  connected: boolean;
}

/**
 * Open a Hocuspocus connection for `noteId` while the hook is mounted and
 * expose the live `Y.Text("content")`. The editor binds it via
 * `yCollab(yText, null)` in its CodeMirror extensions; remote diffs (other
 * tabs, MCP `archon_write_note`, etc.) flow into the visible editor with no
 * intermediate React state.
 */
export function useYjsBodyShadow(
  noteId: string | null,
  spaceId: string | null,
): YjsBodyShadow {
  const [connected, setConnected] = useState(false);

  // The Y.Text is derived directly from noteId via the stable cache —
  // no useState, no re-render flicker. yCollab in the editor's extensions
  // will bind to this same reference on every render until noteId changes.
  const yText = noteId ? getOrCreateNoteDoc(noteId).ytext : null;

  useEffect(() => {
    if (!noteId || !spaceId) {
      // eslint-disable-next-line no-console
      console.debug("[yjs-body] inert", {
        noteId: !!noteId,
        spaceId: !!spaceId,
      });
      setConnected(false);
      return;
    }
    let cancelled = false;
    let provider: HocuspocusProvider | null = null;
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
        console.debug("[yjs-body] token mint failed", { spaceId, syncBase });
        setConnected(false);
        return;
      }
      const wsBase = resolveRealtimeWsBase(syncBase);
      const wsUrl = `${wsBase.replace(/\/$/, "")}/ws/yjs`;
      const { doc } = getOrCreateNoteDoc(noteId);
      provider = new HocuspocusProvider({
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
      const onStatus = (): void => {
        if (cancelled || !provider) return;
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
    })();

    return () => {
      cancelled = true;
      setConnected(false);
      // Disconnect the WS only — leave the cached Y.Doc alone. The
      // editor's yCollab extension may still hold the Y.Text reference
      // until React reconciles, and the next mount of this hook (e.g.
      // StrictMode re-mount, spaceId flicker) will reuse the same Doc.
      if (provider) {
        try {
          provider.disconnect();
          provider.destroy();
        } catch {
          /* noop */
        }
        provider = null;
      }
    };
  }, [noteId, spaceId]);

  return { yText, connected };
}
