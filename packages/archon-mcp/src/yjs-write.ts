/**
 * Server-side Hocuspocus client used by `archon_write_note` to push the note
 * body through the live Yjs document instead of relying on `PATCH /wpn/notes/:id`
 * alone. The PATCH path keeps a defensive in-process bridge
 * (`applyContentToYjsDoc`) but it only works when the editor and the REST hit
 * the *same* sync-api process. Going through a real WS client makes the write
 * survive multi-instance deployments — Hocuspocus routes us to whichever
 * instance owns the doc.
 *
 * Flow per call:
 *   1. open `HocuspocusProvider` to `${wsUrl}` with `name: noteId`,
 *   2. wait until the initial sync settles (`synced && isConnected`),
 *   3. replace `Y.Text("content")` in one Y transaction (so the wire frame
 *      is one diff and the editor sees a single coherent broadcast),
 *   4. wait until `unsyncedChanges === 0` so we know the server has acked,
 *   5. tear down the provider + Y.Doc.
 *
 * The write is a *destructive replace* of the text channel, matching the
 * behaviour of the existing `applyContentToYjsDoc` bridge — concurrent
 * editor edits made between sync and our transact may merge in via CRDT.
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

export type WriteNoteContentViaYjsArgs = {
  wsUrl: string;
  wsToken: string;
  noteId: string;
  content: string;
  /** Max ms to wait for the initial Hocuspocus sync. */
  syncTimeoutMs?: number;
  /** Max ms to wait for the server to ack our update. */
  ackTimeoutMs?: number;
};

const DEFAULT_SYNC_TIMEOUT_MS = 5000;
const DEFAULT_ACK_TIMEOUT_MS = 3000;

export async function writeNoteContentViaYjs(
  args: WriteNoteContentViaYjsArgs,
): Promise<void> {
  const syncTimeoutMs = args.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const ackTimeoutMs = args.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  const doc = new Y.Doc();
  const state: { authError: Error | null } = { authError: null };
  let provider: HocuspocusProvider | undefined;
  try {
    provider = new HocuspocusProvider({
      url: args.wsUrl,
      name: args.noteId,
      document: doc,
      token: args.wsToken,
      onAuthenticationFailed: ({ reason }) => {
        state.authError = new Error(`Yjs WS auth failed: ${reason}`);
      },
    });

    await waitFor(
      () => {
        if (state.authError) throw state.authError;
        return provider!.synced && provider!.isConnected;
      },
      syncTimeoutMs,
      "Hocuspocus sync",
    );

    const ytext = doc.getText("content");
    if (ytext.toString() === args.content) return;

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      if (args.content.length > 0) ytext.insert(0, args.content);
    });

    await waitFor(
      () => provider!.unsyncedChanges === 0,
      ackTimeoutMs,
      "Hocuspocus ack",
    );
  } finally {
    if (provider) {
      try {
        provider.disconnect();
        provider.destroy();
      } catch {
        /* noop */
      }
    }
    try {
      doc.destroy();
    } catch {
      /* noop */
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

/**
 * Derive the Yjs WebSocket URL from the MCP HTTP base URL. The sync-api
 * mounts Hocuspocus at `<v1-prefix>/ws/yjs` and the MCP base URL already
 * includes the v1 prefix (see `config.ts#normalizeSyncBase`).
 */
export function deriveYjsWsUrl(httpBaseUrl: string): string {
  const trimmed = httpBaseUrl.replace(/\/+$/, "");
  const wsBase = trimmed.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}/ws/yjs`;
}
