/**
 * Default-org / default-space scaffolding.
 *
 * `ensureUserHasDefaultOrg` and `ensureDefaultSpaceForOrg` are idempotent
 * helpers invoked on demand when org-routes need to land a new user into a
 * sane default. Migration state is owned by drizzle-kit.
 */
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { getDb, withTx } from "./pg.js";
import {
  organizations,
  orgMemberships,
  spaceMemberships,
  spaces,
  users,
  wpnExplorerState,
  wpnNotes,
  wpnProjects,
  wpnWorkspaces,
} from "./db/schema.js";
import { isUuid } from "./db/legacy-id-map.js";

function deriveSlugCandidate(email: string): string {
  const local = email.split("@", 1)[0] ?? email;
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length >= 2 ? cleaned.slice(0, 56) : `org-${cleaned || "x"}`;
}

/**
 * Looks up the default-kind space id for an org. Returns `null` when the
 * org has no default space (unusual; normally created at first user-default
 * resolution time).
 */
export async function getDefaultSpaceIdForOrg(
  orgId: string,
): Promise<string | null> {
  if (!isUuid(orgId)) return null;
  const rows = await getDb()
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.kind, "default")))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Idempotent: returns the org's default-kind space, creating it if missing
 * and enrolling `ownerUserId` as Space Owner. Also stamps any legacy WPN
 * docs owned by `ownerUserId` (no `org_id` / `space_id`) with the resolved
 * pair so scope filters keep matching post-cutover.
 */
export async function ensureDefaultSpaceForOrg(
  orgId: string,
  ownerUserId: string,
): Promise<{ spaceId: string; created: boolean }> {
  return withTx(async (tx) => {
    const existing = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.orgId, orgId), eq(spaces.kind, "default")))
      .limit(1);
    let spaceId = existing[0]?.id;
    let created = false;
    if (!spaceId) {
      spaceId = randomUUID();
      await tx.insert(spaces).values({
        id: spaceId,
        orgId,
        name: "Default",
        kind: "default",
        createdByUserId: ownerUserId,
        createdAt: new Date(),
      });
      created = true;
    }
    await tx
      .insert(spaceMemberships)
      .values({
        spaceId,
        userId: ownerUserId,
        role: "owner",
        addedByUserId: ownerUserId,
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [spaceMemberships.spaceId, spaceMemberships.userId],
      });
    // Stamp legacy WPN docs lacking org/space scope.
    await tx
      .update(wpnWorkspaces)
      .set({ orgId, spaceId })
      .where(
        and(eq(wpnWorkspaces.userId, ownerUserId), sql`${wpnWorkspaces.orgId} IS NULL`),
      );
    await tx
      .update(wpnProjects)
      .set({ orgId, spaceId })
      .where(
        and(eq(wpnProjects.userId, ownerUserId), sql`${wpnProjects.orgId} IS NULL`),
      );
    await tx
      .update(wpnNotes)
      .set({ orgId, spaceId })
      .where(and(eq(wpnNotes.userId, ownerUserId), sql`${wpnNotes.orgId} IS NULL`));
    await tx
      .update(wpnExplorerState)
      .set({ orgId, spaceId })
      .where(
        and(
          eq(wpnExplorerState.userId, ownerUserId),
          sql`${wpnExplorerState.orgId} IS NULL`,
        ),
      );
    return { spaceId, created };
  });
}

/**
 * Idempotent: ensures `userId` has a `default_org_id`. If they already do,
 * returns it. Otherwise creates an Org + admin membership + default space
 * and stamps the user. Slug collisions are resolved by appending a random
 * suffix.
 */
export async function ensureUserHasDefaultOrg(
  userId: string,
  email: string,
): Promise<{ orgId: string; created: boolean }> {
  if (!isUuid(userId)) {
    throw new Error("ensureUserHasDefaultOrg: userId must be a uuid");
  }
  const existingRows = await getDb()
    .select({ defaultOrgId: users.defaultOrgId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const existing = existingRows[0];
  if (existing?.defaultOrgId) {
    return { orgId: existing.defaultOrgId, created: false };
  }
  const baseSlug = deriveSlugCandidate(email);
  let slug = baseSlug;
  for (let attempt = 0; attempt < 6; attempt++) {
    const taken = await getDb()
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (taken.length === 0) break;
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const orgId = randomUUID();
  await getDb().insert(organizations).values({
    id: orgId,
    name: `${email.split("@", 1)[0] ?? email}'s Org`,
    slug,
    ownerUserId: userId,
    createdAt: new Date(),
  });
  await getDb()
    .insert(orgMemberships)
    .values({
      orgId,
      userId,
      role: "admin",
      joinedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [orgMemberships.orgId, orgMemberships.userId],
    });
  await getDb()
    .update(users)
    .set({ defaultOrgId: orgId })
    .where(eq(users.id, userId));
  await ensureDefaultSpaceForOrg(orgId, userId);
  return { orgId, created: true };
}
