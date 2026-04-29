/**
 * WPN export / import.
 *
 * STATUS: Migration stub. The pre-migration implementation (~554 lines)
 * built and consumed a ZIP bundle keyed on workspaces at the top level
 * (`{ workspaces[].projects[].notes[] }`). Post-migration the bundle
 * format flattens to project-rooted (`{ projects[].notes[] }`), and the
 * import path needs to decide which team to attach each project to.
 *
 * Both endpoints return 501 until A3 of the migration plan ships the
 * port. Reads via /wpn/* still work; users just can't export or import
 * bundles in the interim.
 *
 * The historical implementation lives in git history at commit
 * 7691348^ and earlier.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "./auth.js";

const NOT_PORTED = {
  error:
    "Bundle export/import is not yet ported to the post-migration schema. " +
    "Tracked as commit A3 of the migration.",
};

function reply501(reply: FastifyReply): FastifyReply {
  return reply.status(501).send(NOT_PORTED);
}

export type RegisterWpnImportExportRoutesOptions = {
  jwtSecret: string;
};

export async function registerWpnImportExportRoutes(
  app: FastifyInstance,
  opts: RegisterWpnImportExportRoutesOptions,
): Promise<void> {
  const { jwtSecret } = opts;

  app.post("/wpn/export", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });

  app.post("/wpn/import", async (request, reply) => {
    if (!(await requireAuth(request, reply, jwtSecret))) return;
    return reply501(reply);
  });
}
