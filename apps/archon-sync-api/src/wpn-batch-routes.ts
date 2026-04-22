import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { syncApiV1Path } from "./api-v1-prefix.js";
import { requireAuth } from "./auth.js";

const batchOpSchema = z.object({
  /** Client-supplied id to correlate responses (idempotent within this request only). */
  id: z.string().min(1).max(128),
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
  path: z.string().min(4).max(512),
  body: z.unknown().optional(),
});

const batchBodySchema = z.object({
  operations: z.array(batchOpSchema).min(1).max(40),
});

function logicalPathForWpnCheck(p: string): string {
  if (p.startsWith("/api/v1/")) {
    return p.slice("/api/v1".length) || "/";
  }
  return p;
}

function isSafeWpnPath(p: string): boolean {
  const logical = logicalPathForWpnCheck(p);
  if (!logical.startsWith("/wpn/")) {
    return false;
  }
  if (logical.includes("..") || logical.includes("//")) {
    return false;
  }
  /** Avoid recursive batch-in-batch via inject. */
  if (logical === "/wpn/sync/batch" || logical.startsWith("/wpn/sync/")) {
    return false;
  }
  return true;
}

/**
 * Run multiple WPN HTTP operations in one round-trip (same JWT).
 * Each op is executed via Fastify inject; safe paths are limited to `/wpn/*`.
 */
export function registerWpnBatchRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  app.post("/wpn/sync/batch", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = batchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const authHeader = request.headers.authorization ?? "";
    const results: {
      id: string;
      status: number;
      body: unknown;
    }[] = [];

    for (const op of parsed.data.operations) {
      if (!isSafeWpnPath(op.path)) {
        return reply.status(400).send({
          error: `Invalid path for operation ${op.id} (must be a /wpn/ URL without .. )`,
        });
      }
      const injectOpts: {
        method: "GET" | "POST" | "PATCH" | "DELETE";
        url: string;
        headers: Record<string, string>;
        payload?: string;
      } = {
        method: op.method,
        url: syncApiV1Path(op.path),
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
        },
      };
      if (op.method !== "GET" && op.method !== "DELETE" && op.body !== undefined) {
        injectOpts.payload = JSON.stringify(op.body);
      }
      const res = await app.inject(injectOpts);
      let body: unknown;
      try {
        body =
          res.payload && res.payload.length > 0
            ? (JSON.parse(res.payload) as unknown)
            : null;
      } catch {
        body = res.payload;
      }
      results.push({ id: op.id, status: res.statusCode, body });
    }

    return reply.send({ ok: true as const, results });
  });
}
