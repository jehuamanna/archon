import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { getDb } from "./pg.js";
import { userPrefs } from "./db/schema.js";

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
    if (!auth) return;
    const rows = await getDb()
      .select({ shellLayout: userPrefs.shellLayout })
      .from(userPrefs)
      .where(eq(userPrefs.userId, auth.sub))
      .limit(1);
    return reply.send({ layout: rows[0]?.shellLayout ?? null });
  });

  app.put("/me/shell-layout", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = shellLayoutPutBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const layout = (parsed.data.layout ?? null) as unknown;
    const now = Date.now();
    await getDb()
      .insert(userPrefs)
      .values({
        userId: auth.sub,
        shellLayout: layout,
        updatedAtMs: now,
      })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: { shellLayout: layout, updatedAtMs: now },
      });
    return reply.status(204).send();
  });
}
