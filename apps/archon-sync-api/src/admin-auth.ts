import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, and, sql, ne, or, isNull } from "drizzle-orm";
import { requireAuth, type JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import { users } from "./db/schema.js";
import { isUuid } from "./db/legacy-id-map.js";

/** PG-row shape replacing the Mongo UserDoc (used for return type). */
export type AdminAuthUser = typeof users.$inferSelect;

/**
 * Authorize a platform-wide master-admin action. Resolves the caller's user
 * row and checks `is_master_admin === true`. On failure sends 401/403 and
 * returns `null` — callers must early-return.
 *
 * Authoritative (DB-backed) rather than JWT-claim-based so a demote takes
 * effect immediately for in-flight tokens.
 */
export async function requireMasterAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  jwtSecret: string,
): Promise<{ auth: JwtPayload; user: AdminAuthUser } | null> {
  const auth = await requireAuth(request, reply, jwtSecret);
  if (!auth) return null;
  if (!isUuid(auth.sub)) {
    await reply.status(401).send({ error: "Invalid session" });
    return null;
  }
  const rows = await getDb()
    .select()
    .from(users)
    .where(eq(users.id, auth.sub))
    .limit(1);
  const user = rows[0];
  if (!user || user.isMasterAdmin !== true) {
    await reply.status(403).send({ error: "Master admin role required" });
    return null;
  }
  return { auth, user };
}

/**
 * First-run promotion: if `ARCHON_MASTER_ADMIN_EMAIL` matches the user's
 * email, flip `is_master_admin` to true on first authentication. Idempotent.
 */
export async function maybePromoteMasterAdmin(
  userId: string,
  email: string,
): Promise<void> {
  const configured = (process.env.ARCHON_MASTER_ADMIN_EMAIL ?? "")
    .trim()
    .toLowerCase();
  if (!configured || configured !== email.trim().toLowerCase()) return;
  if (!isUuid(userId)) return;
  await getDb()
    .update(users)
    .set({ isMasterAdmin: true })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.isMasterAdmin), ne(users.isMasterAdmin, true)),
      ),
    );
}

// Drizzle helpers we don't currently use locally — exported as `_` to suppress
// "unused import" warnings in legacy build configurations.
export const _drizzleUnusedImports = { sql };
