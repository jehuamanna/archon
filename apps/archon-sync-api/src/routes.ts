import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import {
  requireAuth,
  signAccessToken,
  signRefreshToken,
} from "./auth.js";
import { verifyAndTranslateRefresh } from "./auth-translate.js";
import { getDb } from "./pg.js";
import { notes as legacyNotes, spaces, users } from "./db/schema.js";
import {
  ensureDefaultSpaceForOrg,
  ensureUserHasDefaultOrg,
  getDefaultSpaceIdForOrg,
} from "./org-defaults.js";
import { registerBuiltinPluginRoutes } from "./builtin-plugin-routes.js";
import { registerBundledDocsPublicRoutes } from "./bundled-docs-routes.js";
import { registerMeAssetsRoutes } from "./me-assets-routes.js";
import { registerMeRoutes } from "./me-routes.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAnnouncementRoutes } from "./announcement-routes.js";
import { registerOrgRoutes } from "./org-routes.js";
import { registerSpaceRoutes } from "./space-routes.js";
import { registerTeamRoutes } from "./team-routes.js";
import { registerWpnBatchRoutes } from "./wpn-batch-routes.js";
import { registerWpnReadRoutes } from "./wpn-routes.js";
import { registerWpnWriteRoutes } from "./wpn-write-routes.js";
import { registerMcpDeviceAuthRoutes } from "./mcp-device-auth-routes.js";
import { registerNotificationsRoutes } from "./notifications-routes.js";
import { registerWpnImportExportRoutes } from "./wpn-import-export-routes.js";
import { registerMasterAdminRoutes } from "./master-admin-routes.js";
import { registerMdxStateRoutes } from "./mdx-state/routes.js";
import { registerMdxStateWsRoutes } from "./mdx-state/ws.js";
import {
  registerRealtimeRoutes,
  registerSpaceWsRoutes,
} from "./realtime/index.js";
import { maybePromoteMasterAdmin } from "./admin-auth.js";
import {
  buildSessionsAfterAppend,
  rotateRefreshSession,
  userHasRefreshJti,
} from "./refresh-sessions.js";
import { isUuid } from "./db/legacy-id-map.js";

const registerBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
});

const loginBody = registerBody.extend({
  client: z.enum(["mcp"]).optional(),
});

const refreshBody = z.object({
  refreshToken: z.string().min(10),
});

const syncPushBody = z.object({
  collection: z.literal("notes"),
  documents: z
    .array(
      z.object({
        id: z.string().uuid(),
        updatedAt: z.number(),
        deleted: z.boolean(),
        version: z.number().int(),
        title: z.string(),
        content: z.string(),
        type: z.enum(["markdown", "text", "code", "image"]),
      }),
    )
    .max(500),
});

type UserRow = typeof users.$inferSelect;

/**
 * Phase 8: pick the space the access token should carry.
 * Preference order:
 *   1. lastActiveSpaceByOrg[orgId] (still belongs to that org)
 *   2. lastActiveSpaceId (still belongs to that org)
 *   3. caller-provided fallback (typically getDefaultSpaceIdForOrg).
 */
async function resolveSessionSpaceId(
  user: UserRow,
  orgId: string,
  fallbackSpaceId: string,
): Promise<string> {
  const candidates: string[] = [];
  const remembered = (user.lastActiveSpaceByOrg as Record<string, string> | null)?.[orgId];
  if (typeof remembered === "string" && isUuid(remembered)) {
    candidates.push(remembered);
  }
  if (
    typeof user.lastActiveSpaceId === "string" &&
    isUuid(user.lastActiveSpaceId)
  ) {
    candidates.push(user.lastActiveSpaceId);
  }
  for (const spaceId of candidates) {
    const rows = await getDb()
      .select({ orgId: spaces.orgId })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);
    if (rows[0]?.orgId === orgId) {
      return spaceId;
    }
  }
  return fallbackSpaceId;
}

export function registerRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  registerBundledDocsPublicRoutes(app);
  registerWpnReadRoutes(app, { jwtSecret });
  registerWpnWriteRoutes(app, { jwtSecret });
  registerWpnBatchRoutes(app, { jwtSecret });
  registerMeRoutes(app, { jwtSecret });
  app.register(async (scoped) => registerMeAssetsRoutes(scoped, { jwtSecret }));
  registerBuiltinPluginRoutes(app, { jwtSecret });
  registerMcpDeviceAuthRoutes(app, { jwtSecret });
  registerOrgRoutes(app, { jwtSecret });
  registerSpaceRoutes(app, { jwtSecret });
  registerTeamRoutes(app, { jwtSecret });
  registerAnnouncementRoutes(app, { jwtSecret });
  registerAdminRoutes(app, { jwtSecret });
  registerMasterAdminRoutes(app, { jwtSecret });
  registerNotificationsRoutes(app, { jwtSecret });
  registerMdxStateRoutes(app, { jwtSecret });
  registerMdxStateWsRoutes(app, { jwtSecret });
  registerRealtimeRoutes(app, { jwtSecret });
  registerSpaceWsRoutes(app, { jwtSecret });
  app.register(
    async (scoped) => registerWpnImportExportRoutes(scoped, { jwtSecret }),
  );

  app.post("/auth/register", async (request, reply) => {
    const parsed = registerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const emailLower = email.toLowerCase();
    const existing = await db()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, emailLower))
      .limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ error: "Email already registered" });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = randomUUID();
    await db().insert(users).values({
      id: userId,
      email: emailLower,
      passwordHash,
    });
    await maybePromoteMasterAdmin(userId, emailLower);
    const { orgId: defaultOrgId } = await ensureUserHasDefaultOrg(userId, emailLower);
    const { spaceId: defaultSpaceId } = await ensureDefaultSpaceForOrg(
      defaultOrgId,
      userId,
    );
    const payload = {
      sub: userId,
      email: emailLower,
      activeOrgId: defaultOrgId,
      activeSpaceId: defaultSpaceId,
    };
    const jti = randomUUID();
    const token = signAccessToken(jwtSecret, payload);
    const refreshToken = signRefreshToken(jwtSecret, payload, jti);
    await db()
      .update(users)
      .set({
        refreshSessions: [{ jti, createdAt: new Date().toISOString() }],
      })
      .where(eq(users.id, userId));
    return reply.send({
      token,
      refreshToken,
      userId,
      defaultOrgId,
      defaultSpaceId,
    });
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const emailLower = email.toLowerCase();
    const userRows = await db()
      .select()
      .from(users)
      .where(eq(users.email, emailLower))
      .limit(1);
    const user = userRows[0];
    if (!user) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }
    if (user.disabled === true) {
      return reply.status(403).send({ error: "Account disabled" });
    }
    const userId = user.id;
    await maybePromoteMasterAdmin(userId, user.email);
    const { orgId: defaultOrgId } = await ensureUserHasDefaultOrg(userId, user.email);
    const { spaceId: defaultSpaceId } = await ensureDefaultSpaceForOrg(
      defaultOrgId,
      userId,
    );
    const lastActiveOrgId =
      typeof user.lastActiveOrgId === "string" && user.lastActiveOrgId.length > 0
        ? user.lastActiveOrgId
        : null;
    const loginActiveOrgId = lastActiveOrgId ?? defaultOrgId;
    const fallbackSpaceId =
      loginActiveOrgId === defaultOrgId
        ? defaultSpaceId
        : (await getDefaultSpaceIdForOrg(loginActiveOrgId)) ?? defaultSpaceId;
    const loginActiveSpaceId = await resolveSessionSpaceId(
      user,
      loginActiveOrgId,
      fallbackSpaceId,
    );
    const payload = {
      sub: userId,
      email: user.email,
      activeOrgId: loginActiveOrgId,
      activeSpaceId: loginActiveSpaceId,
    };
    const jti = randomUUID();
    const sessionVariant = parsed.data.client === "mcp" ? "mcp" : "default";
    const token = signAccessToken(jwtSecret, payload, sessionVariant);
    const refreshToken = signRefreshToken(jwtSecret, payload, jti, sessionVariant);
    const nextSessions = buildSessionsAfterAppend(
      {
        refreshSessions: user.refreshSessions,
        activeRefreshJti: user.activeRefreshJti,
      },
      jti,
    );
    await db()
      .update(users)
      .set({
        refreshSessions: nextSessions.map((s) => ({
          jti: s.jti,
          createdAt: s.createdAt.toISOString(),
        })),
        activeRefreshJti: null,
      })
      .where(eq(users.id, userId));
    return reply.send({
      token,
      refreshToken,
      userId,
      defaultOrgId,
      defaultSpaceId,
      mustSetPassword: user.mustSetPassword === true,
    });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    try {
      const p = await verifyAndTranslateRefresh(jwtSecret, parsed.data.refreshToken);
      if (!isUuid(p.sub)) {
        return reply
          .status(401)
          .send({ error: "Invalid or expired refresh token" });
      }
      const userRows = await db()
        .select()
        .from(users)
        .where(eq(users.id, p.sub))
        .limit(1);
      const user = userRows[0];
      if (
        !user ||
        !userHasRefreshJti(
          { refreshSessions: user.refreshSessions, activeRefreshJti: user.activeRefreshJti },
          p.jti,
        )
      ) {
        return reply
          .status(401)
          .send({ error: "Invalid or expired refresh token" });
      }
      if (user.disabled === true) {
        return reply.status(403).send({ error: "Account disabled" });
      }
      const newJti = randomUUID();
      const nextSessions = rotateRefreshSession(
        {
          refreshSessions: user.refreshSessions,
          activeRefreshJti: user.activeRefreshJti,
        },
        p.jti,
        newJti,
      );
      if (!nextSessions) {
        return reply
          .status(401)
          .send({ error: "Invalid or expired refresh token" });
      }
      await db()
        .update(users)
        .set({
          refreshSessions: nextSessions.map((s) => ({
            jti: s.jti,
            createdAt: s.createdAt.toISOString(),
          })),
          activeRefreshJti: null,
        })
        .where(eq(users.id, p.sub));
      const sessionVariant = p.mcp === true ? "mcp" : "default";
      const lastActiveOrgId =
        typeof user.lastActiveOrgId === "string" && user.lastActiveOrgId.length > 0
          ? user.lastActiveOrgId
          : null;
      const refreshedActiveOrgId =
        lastActiveOrgId ??
        (typeof user.defaultOrgId === "string" && user.defaultOrgId.length > 0
          ? user.defaultOrgId
          : undefined);
      let refreshedActiveSpaceId: string | undefined;
      if (refreshedActiveOrgId) {
        const fallbackSpaceId =
          (await getDefaultSpaceIdForOrg(refreshedActiveOrgId)) ?? "";
        const resolved = await resolveSessionSpaceId(
          user,
          refreshedActiveOrgId,
          fallbackSpaceId,
        );
        refreshedActiveSpaceId = resolved.length > 0 ? resolved : undefined;
      } else if (
        typeof user.lastActiveSpaceId === "string" &&
        user.lastActiveSpaceId.length > 0
      ) {
        refreshedActiveSpaceId = user.lastActiveSpaceId;
      }
      const token = signAccessToken(
        jwtSecret,
        {
          sub: p.sub,
          email: p.email,
          ...(refreshedActiveOrgId ? { activeOrgId: refreshedActiveOrgId } : {}),
          ...(refreshedActiveSpaceId ? { activeSpaceId: refreshedActiveSpaceId } : {}),
        },
        sessionVariant,
      );
      const refreshToken = signRefreshToken(
        jwtSecret,
        { sub: p.sub, email: p.email },
        newJti,
        sessionVariant,
      );
      return reply.send({ token, refreshToken });
    } catch {
      return reply
        .status(401)
        .send({ error: "Invalid or expired refresh token" });
    }
  });

  // Legacy /sync/{push,pull} use the legacy `notes` table (0 rows in dump,
  // schema preserved for round-tripping). Endpoints kept for back-compat.
  app.post("/sync/push", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = syncPushBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const userId = auth.sub;
    const accepted: string[] = [];
    const conflicts: Omit<typeof legacyNotes.$inferSelect, "userId">[] = [];

    for (const doc of parsed.data.documents) {
      const existingRows = await db()
        .select()
        .from(legacyNotes)
        .where(and(eq(legacyNotes.id, doc.id), eq(legacyNotes.userId, userId)))
        .limit(1);
      const existing = existingRows[0];
      if (existing && existing.updatedAt > doc.updatedAt) {
        const { userId: _u, ...rest } = existing;
        void _u;
        conflicts.push(rest);
        continue;
      }
      await db()
        .insert(legacyNotes)
        .values({ ...doc, userId })
        .onConflictDoUpdate({
          target: [legacyNotes.id, legacyNotes.userId],
          set: { ...doc },
        });
      accepted.push(doc.id);
    }
    return reply.send({ accepted, conflicts });
  });

  app.get("/sync/pull", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const q = z
      .object({
        collection: z.literal("notes"),
        since: z.coerce.number(),
      })
      .safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: q.error.flatten() });
    }
    const userId = auth.sub;
    const list = await db()
      .select()
      .from(legacyNotes)
      .where(
        and(eq(legacyNotes.userId, userId), gt(legacyNotes.updatedAt, q.data.since)),
      )
      .orderBy(legacyNotes.updatedAt);
    const documents = list.map(({ userId: _u, ...rest }) => {
      void _u;
      return rest;
    });
    return reply.send({ documents, lastSync: Date.now() });
  });

  app.get("/health", async (_request, reply) => {
    return reply.send({ ok: true, service: "archon-sync-api" });
  });

  app.get("/auth/me", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    let email = auth.email;
    let mustSetPassword = false;
    let lockedOrgId: string | null = null;
    let isMasterAdmin = false;
    if (isUuid(auth.sub)) {
      const userRows = await db()
        .select()
        .from(users)
        .where(eq(users.id, auth.sub))
        .limit(1);
      const u = userRows[0];
      if (u) {
        email = u.email;
        mustSetPassword = u.mustSetPassword === true;
        lockedOrgId = u.lockedOrgId ?? null;
        isMasterAdmin = u.isMasterAdmin === true;
      }
    }
    return reply.send({
      userId: auth.sub,
      email,
      mustSetPassword,
      lockedOrgId,
      isMasterAdmin,
    });
  });

  app.post("/auth/change-password", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = z
      .object({
        currentPassword: z.string().min(1).max(256),
        newPassword: z.string().min(8).max(256),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid user id" });
    }
    const userRows = await db()
      .select()
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    const user = userRows[0];
    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }
    const ok = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
    if (!ok) {
      return reply.status(401).send({ error: "Current password is incorrect" });
    }
    if (parsed.data.currentPassword === parsed.data.newPassword) {
      return reply
        .status(400)
        .send({ error: "New password must differ from current password" });
    }
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await db()
      .update(users)
      .set({ passwordHash, mustSetPassword: false })
      .where(eq(users.id, auth.sub));
    return reply.send({ ok: true, mustSetPassword: false });
  });
}
