import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { getAuditEventsCollection } from "./db.js";
import { requireOrgRole } from "./org-auth.js";

export function registerAdminRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  /** Admin-only: paginated audit log for the org, newest-first. */
  app.get("/orgs/:orgId/audit", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const q = z
      .object({
        before: z.coerce.number().optional(),
        limit: z.coerce.number().min(1).max(500).optional(),
      })
      .safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: q.error.flatten() });
    }
    const limit = q.data.limit ?? 100;
    const filter: Record<string, unknown> = { orgId };
    if (q.data.before) {
      filter.ts = { $lt: new Date(q.data.before) };
    }
    const rows = await getAuditEventsCollection()
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return reply.send({
      events: rows.map((r) => ({
        eventId: r._id.toHexString(),
        orgId: r.orgId,
        actorUserId: r.actorUserId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata ?? null,
        ts: r.ts,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.ts.getTime() : null,
    });
  });
}
