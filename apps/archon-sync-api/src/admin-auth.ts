import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, and, sql, ne, or, isNull } from "drizzle-orm";
import { requireAuth, type JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import { users } from "./db/schema.js";
import { isUuid } from "./db/legacy-id-map.js";

/** PG-row shape for users used as return types. */
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

/**
 * Boot-time bootstrap: ensure a master-admin user exists when
 * `ARCHON_MASTER_ADMIN_EMAIL` is set. Public signup is disabled, so without
 * this no one can ever sign in to a freshly-deployed instance.
 *
 * Behavior on each boot:
 *  - No email env → no-op, log warning.
 *  - Account missing → create with password = `ARCHON_MASTER_ADMIN_PASSWORD`
 *    if provided, else the email address itself. `mustSetPassword=true` so
 *    first login forces rotation via `MustChangePasswordScreen`.
 *  - Account exists, not master → promote to master_admin. Password
 *    untouched — they already have one.
 *  - Account exists and is master:
 *      - default: no-op (idempotent).
 *      - `ARCHON_MASTER_ADMIN_RESET=1` (one-shot operator recovery):
 *        force password back to the env-supplied value (or email),
 *        flip `mustSetPassword=true`, clear refresh sessions. Use when
 *        the operator has lost the existing master admin's password and
 *        cannot reach the DB. Unset the flag after the boot — leaving
 *        it on means every restart resets the password on you.
 *
 * Idempotent in the default path. Returns a structured result for logging.
 */
export async function ensureMasterAdmin(): Promise<
  | { kind: "skipped-no-email" }
  | { kind: "created"; userId: string; email: string; usedDefaultPassword: boolean }
  | { kind: "promoted-existing"; userId: string; email: string }
  | { kind: "already-master"; userId: string; email: string }
  | { kind: "reset-existing"; userId: string; email: string; usedDefaultPassword: boolean }
> {
  const email = (process.env.ARCHON_MASTER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) return { kind: "skipped-no-email" };

  const explicitPw = (process.env.ARCHON_MASTER_ADMIN_PASSWORD ?? "").trim();
  const usedDefaultPassword = explicitPw.length === 0;
  const password = explicitPw.length > 0 ? explicitPw : email;

  const resetFlag = (process.env.ARCHON_MASTER_ADMIN_RESET ?? "").trim().toLowerCase();
  const wantReset = resetFlag === "1" || resetFlag === "true";

  const db = getDb();
  const existing = await db
    .select({
      id: users.id,
      email: users.email,
      isMasterAdmin: users.isMasterAdmin,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing[0]) {
    // Reset path takes precedence — operator explicitly asked for it.
    // Also re-asserts master-admin in case the existing account is a member.
    if (wantReset) {
      const passwordHash = await bcrypt.hash(password, 12);
      await db
        .update(users)
        .set({
          passwordHash,
          mustSetPassword: true,
          isMasterAdmin: true,
          refreshSessions: null,
          activeRefreshJti: null,
          disabled: null,
        })
        .where(eq(users.id, existing[0].id));
      return {
        kind: "reset-existing",
        userId: existing[0].id,
        email,
        usedDefaultPassword,
      };
    }
    if (existing[0].isMasterAdmin === true) {
      return { kind: "already-master", userId: existing[0].id, email };
    }
    await db
      .update(users)
      .set({ isMasterAdmin: true })
      .where(eq(users.id, existing[0].id));
    return { kind: "promoted-existing", userId: existing[0].id, email };
  }

  // Bootstrap account creation. The default password is the email address —
  // intentionally weak so the operator notices and rotates it on first login.
  // `mustSetPassword=true` makes the renderer hard-block the workbench until
  // a new password is set via POST /auth/change-password.
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email,
    passwordHash,
    isMasterAdmin: true,
    mustSetPassword: true,
  });
  return { kind: "created", userId, email, usedDefaultPassword };
}

// Drizzle helpers we don't currently use locally — exported as `_` to suppress
// "unused import" warnings in legacy build configurations.
export const _drizzleUnusedImports = { sql };
