/**
 * Subscriber-side ACL filter. After PG NOTIFY fans an event into the
 * connection's notify callback, we run this filter before delivering it to
 * the client socket. It re-checks project visibility so that a tab whose
 * effective role is loose enough to receive the channel doesn't see events
 * for projects with stricter access.
 *
 * Project access is the canonical scope post-squash (`spaces` is gone), so
 * this delegates to `userCanReadProject` in permission-resolver.ts — the
 * single source of truth for project read rights (master admin → org admin
 * → team grant).
 */
import { eq } from "drizzle-orm";
import type { JwtPayload } from "../auth.js";
import { getDb } from "../pg.js";
import { notes } from "../db/schema.js";
import { userCanReadProject } from "../permission-resolver.js";
import type { RealtimeEvent } from "./events.js";

/**
 * Decide whether `auth` should see `evt`. Returns false on any uncertainty —
 * the cost of dropping a structural event is far smaller than the cost of
 * leaking one to the wrong principal.
 */
export async function canDeliverToSubscriber(
  auth: JwtPayload,
  evt: RealtimeEvent,
): Promise<boolean> {
  if ("projectId" in evt && typeof evt.projectId === "string") {
    return userCanReadProject(auth.sub, evt.projectId);
  }
  // Edge events: derive projectId from src note (edges live alongside notes).
  if (evt.type === "edge.added" || evt.type === "edge.removed") {
    const rows = await getDb()
      .select({ projectId: notes.projectId })
      .from(notes)
      .where(eq(notes.id, evt.src))
      .limit(1);
    if (!rows[0]) return false;
    return userCanReadProject(auth.sub, rows[0].projectId);
  }
  return false;
}
