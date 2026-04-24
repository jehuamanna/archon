import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { JwtPayload } from "../auth.js";
import { requireAuth, signToken } from "../auth.js";
import { getActiveDb, getWpnProjectsCollection } from "../db.js";
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

/**
 * "Has access to the project" — v1 uses write-access as the gate, matching
 * R2-Q3 ("anyone with access to the project can write"). Read-only shares
 * are excluded from state writes by design; they render MDX but can't mutate.
 */
/**
 * Short-TTL cache for requireProjectMember results. The permission cascade
 * in userCanWriteProject fans out to ~10 Mongo lookups; the mdx-state GET
 * poll re-hits this every 2s per key. Caching for 30s per (user, project)
 * turns N polls/sec × K keys into one expensive check per 30s window.
 */
const MEMBERSHIP_CACHE_TTL_MS = 30_000;
const membershipCache = new Map<string, { ok: boolean; expiresAt: number }>();

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
  const t0 = Date.now();
  const project = await getWpnProjectsCollection().findOne({ id: projectId });
  const t1 = Date.now();
  if (!project) {
    membershipCache.set(cacheKey, { ok: false, expiresAt: now + MEMBERSHIP_CACHE_TTL_MS });
    // eslint-disable-next-line no-console
    console.info(
      `[mdx-state] requireProjectMember projectLookup=${t1 - t0}ms result=not-found`,
    );
    return false;
  }
  // Tolerate ObjectId/string drift: the stored userId may be a string from
  // the sync-api write path OR an ObjectId from a legacy insertion. Compare
  // both string forms.
  const storedUserId =
    typeof project.userId === "string"
      ? project.userId
      : (project.userId as { toString?: () => string })?.toString?.() ?? "";
  if (storedUserId === auth.sub) {
    membershipCache.set(cacheKey, { ok: true, expiresAt: now + MEMBERSHIP_CACHE_TTL_MS });
    // eslint-disable-next-line no-console
    console.info(
      `[mdx-state] requireProjectMember projectLookup=${t1 - t0}ms result=owner-fastpath`,
    );
    return true;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[mdx-state] requireProjectMember falling through to userCanWriteProject — project.userId=${JSON.stringify(project.userId)} auth.sub=${JSON.stringify(auth.sub)}`,
  );
  const canWrite = await userCanWriteProject(auth, projectId);
  const t2 = Date.now();
  membershipCache.set(cacheKey, {
    ok: canWrite,
    expiresAt: now + MEMBERSHIP_CACHE_TTL_MS,
  });
  // eslint-disable-next-line no-console
  console.info(
    `[mdx-state] requireProjectMember projectLookup=${t1 - t0}ms userCanWriteProject=${t2 - t1}ms result=${canWrite}`,
  );
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
      const db = getActiveDb();
      const ok = await requireProjectMember(auth, projectId);
      if (!ok) return reply.status(403).send({ error: "no access to project" });
      const svc = new MdxStateService(db);
      const keys = await svc.list(projectId);
      return reply.send({ keys });
    },
  );

  app.get<{ Params: { projectId: string; key: string } }>(
    "/projects/:projectId/mdx-state/:key",
    async (request, reply) => {
      const routeStart = Date.now();
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId, key } = request.params;
      if (!projectIdRe.test(projectId) || !keyRe.test(key)) {
        return reply.status(400).send({ error: "invalid projectId or key" });
      }
      const db = getActiveDb();
      const membershipStart = Date.now();
      const ok = await requireProjectMember(auth, projectId);
      const membershipEnd = Date.now();
      if (!ok) return reply.status(403).send({ error: "no access to project" });
      const svc = new MdxStateService(db);
      const res = await svc.get(projectId, key);
      const svcEnd = Date.now();
      // eslint-disable-next-line no-console
      console.info(
        `[mdx-state] GET ${key} membership=${membershipEnd - membershipStart}ms mongoGet=${svcEnd - membershipEnd}ms total=${svcEnd - routeStart}ms`,
      );
      // Return 200 for absent keys (value: null, version: 0) instead of 404.
      // HTTP-404 for a documented "not yet written" case turned the polling
      // loop into visual spam in devtools. Clients treat `mode === "absent"`
      // or `value === null` as "use initial".
      //
      // NOTE: `reply.header(...)` must NOT be awaited — `FastifyReply` is a
      // thenable whose `.then` waits for the response stream to end. Under
      // `app.inject` (used by apps/archon-web's Next.js wrapper) the raw
      // stream only ends after reply.send, so `await reply.header(...)`
      // before send deadlocks the handler until the client times out.
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
      const db = getActiveDb();
      const ok = await requireProjectMember(auth, projectId);
      if (!ok) return reply.status(403).send({ error: "no access to project" });
      if (!consumeWriteToken(projectId, auth.sub)) {
        return reply.status(429).send({ error: "rate limit" });
      }
      const svc = new MdxStateService(db);
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
          return reply.status(413).send({ error: "value too large", totalBytes: err.totalBytes });
        }
        if (err instanceof MdxStateKeyLimitError) {
          return reply.status(422).send({ error: "key limit", keyCount: err.keyCount });
        }
        throw err;
      }
    },
  );

  /**
   * Mint a short-lived bearer for the state WebSocket. TTL 5min. Token carries
   * `{ typ: "mdxWs", projectId, sub, email }` so the WS handler can re-verify
   * project membership on each outbound frame without another DB round-trip
   * for the JWT itself.
   */
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
