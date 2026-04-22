import type { FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { requireAuth, type JwtPayload } from "./auth.js";
import { getUsersCollection, type UserDoc } from "./db.js";

/**
 * Authorize a platform-wide master-admin action. Resolves the caller's
 * `UserDoc`, checks `isMasterAdmin === true`. On failure sends 401/403 and
 * returns `null`; callers must early-return.
 *
 * This is authoritative (DB-backed) rather than JWT-claim-based so that
 * demoting a master admin takes effect immediately for in-flight tokens.
 */
export async function requireMasterAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  jwtSecret: string,
): Promise<{ auth: JwtPayload; user: UserDoc } | null> {
  const auth = await requireAuth(request, reply, jwtSecret);
  if (!auth) {
    return null;
  }
  let oid: ObjectId;
  try {
    oid = new ObjectId(auth.sub);
  } catch {
    await reply.status(401).send({ error: "Invalid session" });
    return null;
  }
  const user = (await getUsersCollection().findOne({ _id: oid })) as UserDoc | null;
  if (!user || user.isMasterAdmin !== true) {
    await reply.status(403).send({ error: "Master admin role required" });
    return null;
  }
  return { auth, user };
}

/**
 * First-run promotion: if `ARCHON_MASTER_ADMIN_EMAIL` is set and the user's
 * email matches (case-insensitive), flip `isMasterAdmin` to true the first
 * time they authenticate. Idempotent — repeated logins are a no-op once set.
 */
export async function maybePromoteMasterAdmin(
  userIdHex: string,
  email: string,
): Promise<void> {
  const configured = (process.env.ARCHON_MASTER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!configured || configured !== email.trim().toLowerCase()) {
    return;
  }
  let oid: ObjectId;
  try {
    oid = new ObjectId(userIdHex);
  } catch {
    return;
  }
  await getUsersCollection().updateOne(
    { _id: oid, $or: [{ isMasterAdmin: { $exists: false } }, { isMasterAdmin: { $ne: true } }] },
    { $set: { isMasterAdmin: true } },
  );
}
