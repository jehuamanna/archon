import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  requireAuth,
  signAccessToken,
  signRefreshToken,
} from "./auth.js";
import { verifyAndTranslateRefresh } from "./auth-translate.js";
import { getDb } from "./pg.js";
import { teams, users } from "./db/schema.js";
import {
  ensureDefaultTeamForOrg,
  ensureUserHasDefaultOrg,
  getDefaultTeamIdForOrg,
} from "./org-defaults.js";
import { registerBuiltinPluginRoutes } from "./builtin-plugin-routes.js";
import { registerBundledDocsPublicRoutes } from "./bundled-docs-routes.js";
import { registerMeAssetsRoutes } from "./me-assets-routes.js";
import { registerMeRoutes } from "./me-routes.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerOrgRoutes } from "./org-routes.js";
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
import { registerMdxSdkSpecRoutes } from "./mdx-sdk-spec/routes.js";
import {
  registerRealtimeRoutes,
  registerYjsWsRoutes,
  registerRealtimeDiagnosticsRoute,
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

type UserRow = typeof users.$inferSelect;

/**
 * Pick the team the access token should carry as `activeTeamId`.
 * Preference order:
 *   1. lastActiveTeamByOrg[orgId] (still belongs to that org)
 *   2. lastActiveTeamId (still belongs to that org)
 *   3. caller-provided fallback (typically getDefaultTeamIdForOrg).
 */
async function resolveSessionTeamId(
  user: UserRow,
  orgId: string,
  fallbackTeamId: string,
): Promise<string> {
  const candidates: string[] = [];
  const remembered = (user.lastActiveTeamByOrg as Record<string, string> | null)?.[orgId];
  if (typeof remembered === "string" && isUuid(remembered)) {
    candidates.push(remembered);
  }
  if (
    typeof user.lastActiveTeamId === "string" &&
    isUuid(user.lastActiveTeamId)
  ) {
    candidates.push(user.lastActiveTeamId);
  }
  for (const teamId of candidates) {
    const rows = await getDb()
      .select({ orgId: teams.orgId })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    if (rows[0]?.orgId === orgId) {
      return teamId;
    }
  }
  return fallbackTeamId;
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
  registerTeamRoutes(app, { jwtSecret });
  registerAdminRoutes(app, { jwtSecret });
  registerMasterAdminRoutes(app, { jwtSecret });
  registerNotificationsRoutes(app, { jwtSecret });
  registerMdxStateRoutes(app, { jwtSecret });
  registerMdxStateWsRoutes(app, { jwtSecret });
  registerMdxSdkSpecRoutes(app);
  registerRealtimeRoutes(app, { jwtSecret });
  registerYjsWsRoutes(app, { jwtSecret });
  registerRealtimeDiagnosticsRoute(app, { jwtSecret });
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
    const { teamId: defaultTeamId } = await ensureDefaultTeamForOrg(
      defaultOrgId,
      userId,
    );
    const payload = {
      sub: userId,
      email: emailLower,
      activeOrgId: defaultOrgId,
      activeTeamId: defaultTeamId,
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
      defaultTeamId,
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
    const { teamId: defaultTeamId } = await ensureDefaultTeamForOrg(
      defaultOrgId,
      userId,
    );
    const lastActiveOrgId =
      typeof user.lastActiveOrgId === "string" && user.lastActiveOrgId.length > 0
        ? user.lastActiveOrgId
        : null;
    const loginActiveOrgId = lastActiveOrgId ?? defaultOrgId;
    const fallbackTeamId =
      loginActiveOrgId === defaultOrgId
        ? defaultTeamId
        : (await getDefaultTeamIdForOrg(loginActiveOrgId)) ?? defaultTeamId;
    const loginActiveTeamId = await resolveSessionTeamId(
      user,
      loginActiveOrgId,
      fallbackTeamId,
    );
    const payload = {
      sub: userId,
      email: user.email,
      activeOrgId: loginActiveOrgId,
      activeTeamId: loginActiveTeamId,
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
      defaultTeamId,
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
      let refreshedActiveTeamId: string | undefined;
      if (refreshedActiveOrgId) {
        const fallbackTeamId =
          (await getDefaultTeamIdForOrg(refreshedActiveOrgId)) ?? "";
        const resolved = await resolveSessionTeamId(
          user,
          refreshedActiveOrgId,
          fallbackTeamId,
        );
        refreshedActiveTeamId = resolved.length > 0 ? resolved : undefined;
      } else if (
        typeof user.lastActiveTeamId === "string" &&
        user.lastActiveTeamId.length > 0
      ) {
        refreshedActiveTeamId = user.lastActiveTeamId;
      }
      const token = signAccessToken(
        jwtSecret,
        {
          sub: p.sub,
          email: p.email,
          ...(refreshedActiveOrgId ? { activeOrgId: refreshedActiveOrgId } : {}),
          ...(refreshedActiveTeamId ? { activeTeamId: refreshedActiveTeamId } : {}),
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
