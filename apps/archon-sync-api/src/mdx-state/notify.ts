/**
 * pg_notify wrapper — replaces Mongo Change Streams for the mdx-state WS.
 *
 * Channel naming: `mdx:<projectId>` (lowercase letters, digits, underscore,
 * hyphen — uuid-shaped, safe for PG identifiers without quoting). Payload
 * stays under PG's 8KB NOTIFY hard cap by carrying only the `key` and
 * `version`; subscribers re-fetch the head row by id when they receive a
 * notification.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../pg.js";

export interface MdxStateNotifyPayload {
  projectId: string;
  key: string;
  version: number;
}

const PG_NOTIFY_PAYLOAD_CAP_BYTES = 7 * 1024;

function channelFor(projectId: string): string {
  // pg_notify accepts arbitrary text channel names with single-quote escaping.
  // Anchor on `mdx:<projectId>` so subscribers can LISTEN with no quoting.
  return `mdx:${projectId}`;
}

/**
 * Fire a PG NOTIFY for a given (project, key, version). Subscribers running
 * `LISTEN mdx:<projectId>` receive the JSON payload and can re-fetch the
 * head row to pull the current value.
 *
 * Best-effort: NOTIFY is fire-and-forget — failures are logged but not
 * propagated so a notification problem can't block the underlying write.
 */
export async function notifyMdxState(
  projectId: string,
  key: string,
  version: number,
): Promise<void> {
  const channel = channelFor(projectId);
  const payloadObj: MdxStateNotifyPayload = { projectId, key, version };
  const payload = JSON.stringify(payloadObj);
  if (Buffer.byteLength(payload, "utf8") > PG_NOTIFY_PAYLOAD_CAP_BYTES) {
    // Should never happen with the above shape, but be defensive — PG
    // truncates at 8KB and we want to spot the bug instead of silently
    // delivering a truncated message.
    // eslint-disable-next-line no-console
    console.warn(
      `[mdx-state] notify payload exceeds ${PG_NOTIFY_PAYLOAD_CAP_BYTES}B — channel=${channel}`,
    );
    return;
  }
  try {
    await getDb().execute(sql`SELECT pg_notify(${channel}, ${payload})`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[mdx-state] notify failed on ${channel}: ${(err as Error).message}`);
  }
}
