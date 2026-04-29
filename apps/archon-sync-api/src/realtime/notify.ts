/**
 * Server-side fanout helper. Wraps `pg_notify` with payload-size guard and
 * defensive error handling so a structural op's notify failure can never tear
 * down the request that authored the data.
 *
 * AsyncLocalStorage threads `clientOpId` from the route handler into helpers
 * deep in the call tree; helpers call `notifyRealtime` and pick up the
 * client-supplied id without an explicit signature change.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { getDb } from "../pg.js";
import { channelForOrg, type RealtimeEvent } from "./events.js";

/** PG NOTIFY hard cap is 8000 bytes; leave headroom for protocol overhead. */
const PAYLOAD_CAP = 7 * 1024;

export interface ClientOpContext {
  clientOpId?: string;
}

export const clientOpStore = new AsyncLocalStorage<ClientOpContext>();

/** Read the active clientOpId, if a route handler put one in scope. */
export function currentClientOpId(): string | undefined {
  return clientOpStore.getStore()?.clientOpId;
}

/**
 * Fire a realtime event to every subscriber on the given org's channel.
 * Best-effort: if the payload is oversized or the SQL fails, we log and
 * return — the structural mutation has already committed.
 */
export async function notifyRealtime(
  orgId: string,
  evt: RealtimeEvent,
): Promise<void> {
  const channel = channelForOrg(orgId);
  const filled: RealtimeEvent = {
    ...evt,
    clientOpId: evt.clientOpId ?? currentClientOpId(),
    emittedAt: evt.emittedAt ?? new Date().toISOString(),
  };
  const payload = JSON.stringify(filled);
  if (Buffer.byteLength(payload, "utf8") > PAYLOAD_CAP) {
    // eslint-disable-next-line no-console
    console.warn(
      `[realtime] notify payload exceeds ${PAYLOAD_CAP}B on ${channel} — dropping`,
    );
    return;
  }
  try {
    await getDb().execute(sql`SELECT pg_notify(${channel}, ${payload})`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[realtime] notify failed on ${channel}: ${(err as Error).message}`,
    );
  }
}
