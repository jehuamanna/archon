import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { JwtPayload } from "../auth.js";
import { requireAuth, signToken } from "../auth.js";
import { userCanWriteProject } from "../permission-resolver.js";
import {
  MdxStateConflictError,
  MdxStateKeyLimitError,
  MdxStateService,
  MdxStateTooLargeError,
} from "./service.js";
import { consumeWriteToken } from "./rate-limit.js";

const keyRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const projectIdRe = /^[A-Za-z0-9_.-]{1,128}$/;

const putBody = z.object({ value: z.unknown() });
const wsTokenBody = z.object({ projectId: z.string().regex(projectIdRe) });

const WS_TOKEN_TTL = "5m";

const MEMBERSHIP_CACHE_TTL_MS = 30_000;
const membershipCache = new Map<string, { ok: boolean; expiresAt: number }>();

/**
 * Project access check for mdx-state read/write. Caches the result for 30 s
 * because state RPCs are chatty (one per cell render); without the cache,
 * every PUT would re-walk team_projects → team_memberships.
 *
 * The pre-migration "is project creator" fast path is gone — projects are
 * single canonical rows now, access flows through team_projects, and
 * userCanWriteProject already short-circuits for org/master admins.
 */
async function requireProjectMember(
  auth: JwtPayload,
  projectId: string,
): Promise<boolean> {
  const cacheKey = `${auth.sub}:${projectId}`;
  const now = Date.now();
  const cached = membershipCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.ok;
  }
  const canWrite = await userCanWriteProject(auth, projectId);
  membershipCache.set(cacheKey, {
    ok: canWrite,
    expiresAt: now + MEMBERSHIP_CACHE_TTL_MS,
  });
  return canWrite;
}

export function registerMdxStateRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/mdx-state",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId } = request.params;
      if (!projectIdRe.test(projectId)) {
        return reply.status(400).send({ error: "invalid projectId" });
      }
      const ok = await requireProjectMember(auth, projectId);
      if (!ok) return reply.status(403).send({ error: "no access to project" });
      const svc = new MdxStateService();
      const keys = await svc.list(projectId);
      return reply.send({ keys });
    },
  );

  app.get<{ Params: { projectId: string; key: string } }>(
    "/projects/:projectId/mdx-state/:key",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId, key } = request.params;
      if (!projectIdRe.test(projectId) || !keyRe.test(key)) {
        return reply.status(400).send({ error: "invalid projectId or key" });
      }
      const ok = await requireProjectMember(auth, projectId);
      if (!ok) return reply.status(403).send({ error: "no access to project" });
      const svc = new MdxStateService();
      const res = await svc.get(projectId, key);
      reply.header("ETag", String(res.version));
      return reply.send({
        value: res.mode === "absent" ? null : res.value,
        version: res.version,
        mode: res.mode,
      });
    },
  );

  app.put<{
    Params: { projectId: string; key: string };
    Body: unknown;
  }>(
    "/projects/:projectId/mdx-state/:key",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId, key } = request.params;
      if (!projectIdRe.test(projectId) || !keyRe.test(key)) {
        return reply.status(400).send({ error: "invalid projectId or key" });
      }
      const parsed = putBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const ifMatch = request.headers["if-match"];
      const expectedVersion = Number(
        typeof ifMatch === "string" ? ifMatch : "NaN",
      );
      if (!Number.isFinite(expectedVersion) || expectedVersion < 0) {
        return reply.status(428).send({ error: "If-Match required" });
      }
      const ok = await requireProjectMember(auth, projectId);
      if (!ok) return reply.status(403).send({ error: "no access to project" });
      if (!consumeWriteToken(projectId, auth.sub)) {
        return reply.status(429).send({ error: "rate limit" });
      }
      const svc = new MdxStateService();
      try {
        const result = await svc.put(
          projectId,
          key,
          parsed.data.value,
          expectedVersion,
          { userId: auth.sub, email: auth.email },
        );
        reply.header("ETag", String(result.version));
        return reply.send(result);
      } catch (err) {
        if (err instanceof MdxStateConflictError) {
          return reply
            .status(409)
            .send({ error: "version conflict", currentVersion: err.currentVersion });
        }
        if (err instanceof MdxStateTooLargeError) {
          return reply.status(413).send({
            error: "value too large",
            totalBytes: err.totalBytes,
          });
        }
        if (err instanceof MdxStateKeyLimitError) {
          return reply.status(422).send({
            error: "key limit",
            keyCount: err.keyCount,
          });
        }
        throw err;
      }
    },
  );

  /** Mint a short-lived bearer for the state WebSocket. */
  app.post(
    "/mdx-state/ws-token",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const parsed = wsTokenBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const ok = await requireProjectMember(auth, parsed.data.projectId);
      if (!ok) return reply.status(403).send({ error: "no access to project" });
      const payload = {
        sub: auth.sub,
        email: auth.email,
        typ: "mdxWs",
        projectId: parsed.data.projectId,
      } as unknown as Parameters<typeof signToken>[1];
      const token = signToken(jwtSecret, payload, WS_TOKEN_TTL);
      return reply.send({ token, expiresInSec: 5 * 60 });
    },
  );
}
