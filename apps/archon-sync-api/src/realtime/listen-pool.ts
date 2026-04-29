/**
 * Refcounted LISTEN/NOTIFY channel manager. One dedicated `pg.Client` per
 * channel; subscribers register a callback and receive raw notification
 * payloads. When the last subscriber releases its handle, the channel is
 * kept open for an idle window so a quick reconnect doesn't pay the LISTEN
 * setup cost.
 *
 * Lifted out of `mdx-state/ws.ts` so Phase 3 can reuse the same primitive
 * for `rt:org:<id>` structural-event fanout, and Phase 2 for any
 * Hocuspocus broadcast channels we end up needing. The `mdx-state` flow
 * keeps its inline copy until we migrate it (out of scope for Phase 1).
 */
import type { PoolClient } from "pg";
import { acquireDedicatedClient } from "../pg.js";

const IDLE_RELEASE_MS = 60_000;

export interface ChannelEntry {
  refcount: number;
  client: PoolClient;
  subscribers: Set<(payload: string) => void>;
  idleTimer: NodeJS.Timeout | null;
}

const channels = new Map<string, ChannelEntry>();

/**
 * Subscribe to PG channel `channelName`. Returns a release function;
 * caller must invoke it once at unsubscription time. Multiple subscribers
 * to the same channel share one underlying `pg.Client`.
 */
export async function acquireChannel(
  channelName: string,
  onNotify: (payload: string) => void,
): Promise<() => Promise<void>> {
  let entry = channels.get(channelName);
  if (!entry) {
    const client = await acquireDedicatedClient();
    const subscribers = new Set<(p: string) => void>();
    client.on("notification", (msg) => {
      if (msg.channel !== channelName) return;
      const payload = msg.payload ?? "";
      for (const cb of subscribers) {
        try {
          cb(payload);
        } catch {
          /* ignore subscriber errors so one bad cb doesn't poison the rest */
        }
      }
    });
    await client.query(`LISTEN "${channelName.replace(/"/g, '""')}"`);
    entry = { refcount: 0, client, subscribers, idleTimer: null };
    channels.set(channelName, entry);
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.refcount++;
  entry.subscribers.add(onNotify);
  const captured = entry;
  return async () => {
    captured.subscribers.delete(onNotify);
    captured.refcount--;
    if (captured.refcount > 0) return;
    captured.idleTimer = setTimeout(() => {
      if (captured.refcount > 0) return;
      channels.delete(channelName);
      void (async () => {
        try {
          await captured.client.query(
            `UNLISTEN "${channelName.replace(/"/g, '""')}"`,
          );
        } catch {
          /* ignore */
        }
        captured.client.release();
      })();
    }, IDLE_RELEASE_MS);
  };
}

/**
 * Snapshot of every active channel. Exposed for diagnostics and tests —
 * never relied on for runtime correctness.
 */
export function getChannelDiagnostics(): Array<{
  channelName: string;
  refcount: number;
  subscribers: number;
  idleTimerActive: boolean;
}> {
  const out: Array<{
    channelName: string;
    refcount: number;
    subscribers: number;
    idleTimerActive: boolean;
  }> = [];
  for (const [name, entry] of channels) {
    out.push({
      channelName: name,
      refcount: entry.refcount,
      subscribers: entry.subscribers.size,
      idleTimerActive: entry.idleTimer !== null,
    });
  }
  return out;
}

/**
 * Force-release every channel — test helper so a process can drop all PG
 * clients and shut the pool down cleanly. Not exported from the package
 * barrel; tests import directly from this file.
 */
export async function _resetChannelsForTests(): Promise<void> {
  const entries = Array.from(channels.entries());
  channels.clear();
  for (const [name, entry] of entries) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      await entry.client.query(`UNLISTEN "${name.replace(/"/g, '""')}"`);
    } catch {
      /* ignore */
    }
    entry.client.release();
  }
}
