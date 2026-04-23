import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { z } from "zod";
import {
  requireAuth,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "./auth.js";
import type { SyncNoteDoc, UserDoc } from "./db.js";
import {
  ensureDefaultSpaceForOrg,
  ensureUserHasDefaultOrg,
  getActiveDb,
  getDefaultSpaceIdForOrg,
  getNotesCollection,
  getSpacesCollection,
  getUsersCollection,
} from "./db.js";
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
import { maybePromoteMasterAdmin } from "./admin-auth.js";
import {
  buildSessionsAfterAppend,
  rotateRefreshSession,
  userHasRefreshJti,
} from "./refresh-sessions.js";

const registerBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
});

const loginBody = registerBody.extend({
  /** When `mcp`, refresh token uses ARCHON_JWT_MCP_REFRESH_EXPIRES (default 7d). */
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

/**
 * Phase 8: resolve the space to stamp into the session's access token, given
 * the user doc, the org the session is entering, and a caller-provided
 * fallback (typically `getDefaultSpaceIdForOrg`). Preference order:
 *   1. `lastActiveSpaceByOrg[orgId]` (still belongs to that org)
 *   2. `lastActiveSpaceId` (still belongs to that org)
 *   3. caller-provided `fallbackSpaceIdHex` (read-only default-space lookup)
 *
 * Guards against schema drift where `lastActiveSpaceId` was set before the
 * user switched orgs — we must not stamp a spaceId that belongs to a
 * different org onto the new session, or WPN reads will scope incorrectly.
 */
async function resolveSessionSpaceId(
  user: UserDoc,
  orgIdHex: string,
  fallbackSpaceIdHex: string,
): Promise<string> {
  const candidates: string[] = [];
  const remembered = user.lastActiveSpaceByOrg?.[orgIdHex];
  if (typeof remembered === "string" && /^[a-f0-9]{24}$/i.test(remembered)) {
    candidates.push(remembered);
  }
  if (
    typeof user.lastActiveSpaceId === "string" &&
    /^[a-f0-9]{24}$/i.test(user.lastActiveSpaceId)
  ) {
    candidates.push(user.lastActiveSpaceId);
  }
  for (const spaceIdHex of candidates) {
    try {
      const space = await getSpacesCollection().findOne({
        _id: new ObjectId(spaceIdHex),
      });
      if (space && space.orgId === orgIdHex) {
        return spaceIdHex;
      }
    } catch {
      // fall through to next candidate
    }
  }
  return fallbackSpaceIdHex;
}

export function registerRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

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
  app.register(
    async (scoped) => registerWpnImportExportRoutes(scoped, { jwtSecret }),
  );

  app.post("/auth/register", async (request, reply) => {
    const parsed = registerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const users = getUsersCollection();
    const existing = await users.findOne({ email: email.toLowerCase() });
    if (existing) {
      return reply.status(409).send({ error: "Email already registered" });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const ins = await users.insertOne({
      email: email.toLowerCase(),
      passwordHash,
    });
    const userId = ins.insertedId.toHexString();
    await maybePromoteMasterAdmin(userId, email.toLowerCase());
    const { orgId: defaultOrgId } = await ensureUserHasDefaultOrg(
      getActiveDb(),
      userId,
      email.toLowerCase(),
    );
    const { spaceId: defaultSpaceId } = await ensureDefaultSpaceForOrg(
      getActiveDb(),
      defaultOrgId,
      userId,
    );
    const payload = {
      sub: userId,
      email: email.toLowerCase(),
      activeOrgId: defaultOrgId,
      activeSpaceId: defaultSpaceId,
    };
    const jti = randomUUID();
    const token = signAccessToken(jwtSecret, payload);
    const refreshToken = signRefreshToken(jwtSecret, payload, jti);
    await users.updateOne(
      { _id: ins.insertedId },
      { $set: { refreshSessions: [{ jti, createdAt: new Date() }] } },
    );
    return reply.send({ token, refreshToken, userId, defaultOrgId, defaultSpaceId });
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const users = getUsersCollection();
    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }
    if ((user as UserDoc).disabled === true) {
      return reply.status(403).send({ error: "Account disabled" });
    }
    const userId = user._id.toHexString();
    await maybePromoteMasterAdmin(userId, user.email);
    const { orgId: defaultOrgId } = await ensureUserHasDefaultOrg(
      getActiveDb(),
      userId,
      user.email,
    );
    const { spaceId: defaultSpaceId } = await ensureDefaultSpaceForOrg(
      getActiveDb(),
      defaultOrgId,
      userId,
    );
    const userDoc = user as UserDoc;
    const lastActiveOrgId =
      typeof userDoc.lastActiveOrgId === "string" && userDoc.lastActiveOrgId.length > 0
        ? userDoc.lastActiveOrgId
        : null;
    const loginActiveOrgId = lastActiveOrgId ?? defaultOrgId;
    // If the session is re-entering a non-default org, `lastActiveSpaceId`
    // may no longer belong to it. resolveSessionSpaceId validates against
    // the spaces collection and falls back to the target org's default space
    // (read-only lookup — no silent space-owner enrolment for invited members).
    const fallbackSpaceId =
      loginActiveOrgId === defaultOrgId
        ? defaultSpaceId
        : (await getDefaultSpaceIdForOrg(loginActiveOrgId)) ?? defaultSpaceId;
    const loginActiveSpaceId = await resolveSessionSpaceId(
      userDoc,
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
    const nextSessions = buildSessionsAfterAppend(user as UserDoc, jti);
    await users.updateOne(
      { _id: user._id },
      { $set: { refreshSessions: nextSessions }, $unset: { activeRefreshJti: "" } },
    );
    return reply.send({
      token,
      refreshToken,
      userId,
      defaultOrgId,
      defaultSpaceId,
      mustSetPassword: (user as UserDoc).mustSetPassword === true,
    });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    try {
      const p = verifyRefreshToken(jwtSecret, parsed.data.refreshToken);
      const users = getUsersCollection();
      let userId: ObjectId;
      try {
        userId = new ObjectId(p.sub);
      } catch {
        return reply.status(401).send({ error: "Invalid or expired refresh token" });
      }
      const user = (await users.findOne({ _id: userId })) as UserDoc | null;
      if (!user || !userHasRefreshJti(user, p.jti)) {
        return reply.status(401).send({ error: "Invalid or expired refresh token" });
      }
      if (user.disabled === true) {
        return reply.status(403).send({ error: "Account disabled" });
      }
      const newJti = randomUUID();
      const nextSessions = rotateRefreshSession(user, p.jti, newJti);
      if (!nextSessions) {
        return reply.status(401).send({ error: "Invalid or expired refresh token" });
      }
      await users.updateOne(
        { _id: userId },
        { $set: { refreshSessions: nextSessions }, $unset: { activeRefreshJti: "" } },
      );
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
        // Read-only default-space lookup — avoids silently enrolling the
        // caller as Space Owner when refreshing into an invited org.
        const fallbackSpaceId =
          (await getDefaultSpaceIdForOrg(refreshedActiveOrgId)) ?? undefined;
        const resolved = await resolveSessionSpaceId(
          user,
          refreshedActiveOrgId,
          fallbackSpaceId ?? "",
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
      return reply.status(401).send({ error: "Invalid or expired refresh token" });
    }
  });

  app.post("/sync/push", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = syncPushBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const userId = auth.sub;
    const notes = getNotesCollection();
    const accepted: string[] = [];
    const conflicts: Omit<SyncNoteDoc, "userId">[] = [];

    for (const doc of parsed.data.documents) {
      const filter = { id: doc.id, userId };
      const existing = await notes.findOne(filter);
      if (existing && existing.updatedAt > doc.updatedAt) {
        const { userId: _uid, ...rest } = existing;
        conflicts.push(rest);
        continue;
      }
      const toWrite: SyncNoteDoc = {
        ...doc,
        userId,
      };
      await notes.replaceOne(filter, toWrite, { upsert: true });
      accepted.push(doc.id);
    }

    return reply.send({ accepted, conflicts });
  });

  app.get("/sync/pull", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
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
    const notes = getNotesCollection();
    const since = q.data.since;
    const cursor = notes.find({
      userId,
      updatedAt: { $gt: since },
    });
    const list = await cursor.sort({ updatedAt: 1 }).toArray();
    const documents = list.map(({ userId: _u, ...rest }) => rest);
    return reply.send({
      documents,
      lastSync: Date.now(),
    });
  });

  app.get("/health", async (_request, reply) => {
    return reply.send({ ok: true, service: "archon-sync-api" });
  });

  /** Debug: resolve user from JWT (same as sync auth). */
  app.get("/auth/me", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const users = getUsersCollection();
    let email = auth.email;
    let mustSetPassword = false;
    let lockedOrgId: string | null = null;
    let isMasterAdmin = false;
    try {
      const u = (await users.findOne({
        _id: new ObjectId(auth.sub),
      })) as UserDoc | null;
      if (u) {
        email = u.email;
        mustSetPassword = u.mustSetPassword === true;
        lockedOrgId = u.lockedOrgId ?? null;
        isMasterAdmin = u.isMasterAdmin === true;
      }
    } catch {
      /* invalid ObjectId */
    }
    return reply.send({
      userId: auth.sub,
      email,
      mustSetPassword,
      lockedOrgId,
      isMasterAdmin,
    });
  });

  /**
   * Authenticated password change. Required flow for accounts created via the
   * admin Create-Member path, but also available to any user who wants to
   * rotate their password. Verifies currentPassword, writes the new hash,
   * and clears mustSetPassword.
   */
  app.post("/auth/change-password", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = z
      .object({
        currentPassword: z.string().min(1).max(256),
        newPassword: z.string().min(8).max(256),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    let userOid: ObjectId;
    try {
      userOid = new ObjectId(auth.sub);
    } catch {
      return reply.status(401).send({ error: "Invalid user id" });
    }
    const users = getUsersCollection();
    const user = (await users.findOne({ _id: userOid })) as UserDoc | null;
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
    await users.updateOne(
      { _id: userOid },
      { $set: { passwordHash, mustSetPassword: false } },
    );
    return reply.send({ ok: true, mustSetPassword: false });
  });
}
