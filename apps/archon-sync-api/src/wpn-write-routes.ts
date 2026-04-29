/**
 * WPN write routes — project + note CRUD.
 *
 * STATUS: Migration stub. The pre-migration implementation (1,607 lines, 33
 * endpoints split between workspace operations, share management, and
 * project/note tree mutation) is preserved in git history at commit
 * 7691348^ and earlier.
 *
 * Workspace endpoints are dropped wholesale along with the workspaces
 * table. Share endpoints are gone with workspace_shares / project_shares.
 * Visibility endpoints are gone with the public/private/shared visibility
 * concept. Project + note write endpoints are stubbed at 501 until
 * `wpn-pg-writes.ts` is ported (commit A1 in the migration plan).
 *
 * Reads keep working — they live in `wpn-routes.ts` and are already
 * migrated.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "./auth.js";

const NOT_PORTED = {
  error:
    "This write endpoint is not yet ported to the post-migration schema. " +
    "Tracked as commit A1 of the migration. Reads via /wpn/* are unaffected.",
};

function reply501(reply: FastifyReply): FastifyReply {
  return reply.status(501).send(NOT_PORTED);
}

export function registerWpnWriteRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  // Project writes — all 501 until A1 lands.
  app.post("/wpn/projects", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.patch("/wpn/projects/:id", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.delete("/wpn/projects/:id", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.post("/wpn/projects/delete", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.post("/wpn/projects/:id/duplicate", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.get("/wpn/projects/:projectId/settings", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.patch("/wpn/projects/:projectId/settings", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });

  // Note writes.
  app.post("/wpn/projects/:projectId/notes", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.patch("/wpn/notes/:id", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.post("/wpn/notes/:id/preview-title-change", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.post("/wpn/notes/delete", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.post("/wpn/notes/move", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.post("/wpn/notes/move-to-project", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
  app.post(
    "/wpn/projects/:projectId/notes/:noteId/duplicate",
    async (request, reply) => {
      if (!(await requireAuth(request, reply, jwtSecret))) return;
      return reply501(reply);
    },
  );

  // Explorer state.
  app.patch("/wpn/projects/:projectId/explorer-state", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
}
