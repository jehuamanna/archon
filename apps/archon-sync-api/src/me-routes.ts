import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { getUserPrefsCollection } from "./db.js";

const shellLayoutPutBody = z.object({
  layout: z.unknown().optional(),
});

export function registerMeRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  app.get("/me/shell-layout", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const col = getUserPrefsCollection();
    const row = await col.findOne({ userId: auth.sub });
    return reply.send({ layout: row?.shellLayout ?? null });
  });

  app.put("/me/shell-layout", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = shellLayoutPutBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const col = getUserPrefsCollection();
    const now = Date.now();
    await col.updateOne(
      { userId: auth.sub },
      {
        $set: {
          userId: auth.sub,
          shellLayout: parsed.data.layout ?? null,
          updatedAtMs: now,
        },
      },
      { upsert: true },
    );
    return reply.status(204).send();
  });
}
