/**
 * Subscriber-side ACL filter. After PG NOTIFY fans an event into the
 * connection's notify callback, we run this filter before delivering it to
 * the client socket. It re-checks project visibility so that a tab whose
 * effective role is loose enough to receive the channel doesn't see events
 * for projects with stricter (private/role-restricted) visibility.
 *
 * The check is a pared-down, boolean variant of `assertCanReadProject`: the
 * filter has no `reply` to send 404s on; it simply suppresses the event.
 */
import { eq } from "drizzle-orm";
import type { JwtPayload } from "../auth.js";
import { getDb } from "../pg.js";
import { wpnNotes, wpnProjects, wpnWorkspaces } from "../db/schema.js";
import {
  effectiveRoleInSpace,
  getEffectiveSpaceRoles,
} from "../permission-resolver.js";
import type { RealtimeEvent } from "./events.js";
import { users } from "../db/schema.js";

async function userCanReadProject(
  auth: JwtPayload,
  projectId: string,
): Promise<boolean> {
  const projRows = await getDb()
    .select({
      visibility: wpnProjects.visibility,
      creatorUserId: wpnProjects.creatorUserId,
      userId: wpnProjects.userId,
      workspaceId: wpnProjects.workspace_id,
    })
    .from(wpnProjects)
    .where(eq(wpnProjects.id, projectId))
    .limit(1);
  const project = projRows[0];
  if (!project) return false;
  const wsRows = await getDb()
    .select({ spaceId: wpnWorkspaces.spaceId, orgId: wpnWorkspaces.orgId })
    .from(wpnWorkspaces)
    .where(eq(wpnWorkspaces.id, project.workspaceId))
    .limit(1);
  const ws = wsRows[0];
  if (ws?.spaceId) {
    const masterRows = await getDb()
      .select({ flag: users.isMasterAdmin })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    if (masterRows[0]?.flag) return true;
    const roles = await getEffectiveSpaceRoles(auth.sub);
    if (roles.get(ws.spaceId) === "owner") return true;
    if (!roles.has(ws.spaceId)) return false;
  }
  const visibility = project.visibility ?? "public";
  const creator = project.creatorUserId ?? project.userId;
  if (visibility === "public") return true;
  if (visibility === "private") return creator === auth.sub;
  return creator === auth.sub;
}

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
    return userCanReadProject(auth, evt.projectId);
  }
  // Edge events: derive projectId from src note (edges live alongside notes).
  if (evt.type === "edge.added" || evt.type === "edge.removed") {
    const rows = await getDb()
      .select({ projectId: wpnNotes.project_id })
      .from(wpnNotes)
      .where(eq(wpnNotes.id, evt.src))
      .limit(1);
    if (!rows[0]) return false;
    return userCanReadProject(auth, rows[0].projectId);
  }
  return false;
}

// Suppress unused import warnings if the resolver-only path lands later.
void effectiveRoleInSpace;
