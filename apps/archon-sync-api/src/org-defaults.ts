/**
 * Default-org / default-department / default-team scaffolding.
 *
 * Idempotent helpers invoked when a user first lands without a usable
 * Org/Team context. Migration state itself is owned by drizzle-kit; these
 * helpers only do row inserts.
 *
 * Bootstrap chain for a brand-new user:
 *   ensureUserHasDefaultOrg
 *     → creates org + admin org_membership
 *     → calls ensureDefaultDepartmentForOrg (creates "General" department)
 *     → calls ensureDefaultTeamForOrg (creates "Default" team in General +
 *       admin team_membership for the owner)
 *     → stamps users.default_org_id
 *
 * The Department layer is NOT NULL on `teams.department_id`, so every team
 * needs one. We auto-create a single "General" department per org rather
 * than forcing the user to think about departments before they've created
 * anything.
 */
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb, withTx } from "./pg.js";
import {
  departmentMemberships,
  departments,
  organizations,
  orgMemberships,
  teamMemberships,
  teams,
  users,
} from "./db/schema.js";
import { isUuid } from "./db/legacy-id-map.js";

const DEFAULT_DEPARTMENT_NAME = "General";
const DEFAULT_TEAM_NAME = "Default";

function deriveSlugCandidate(email: string): string {
  const local = email.split("@", 1)[0] ?? email;
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length >= 2 ? cleaned.slice(0, 56) : `org-${cleaned || "x"}`;
}

/**
 * Look up the org's default-named department id. Returns null when none
 * exists; callers that need it created should use `ensureDefaultDepartmentForOrg`.
 */
export async function getDefaultDepartmentIdForOrg(
  orgId: string,
): Promise<string | null> {
  if (!isUuid(orgId)) return null;
  const rows = await getDb()
    .select({ id: departments.id })
    .from(departments)
    .where(
      and(eq(departments.orgId, orgId), eq(departments.name, DEFAULT_DEPARTMENT_NAME)),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Look up the default team id for an org — the team named `DEFAULT_TEAM_NAME`
 * inside the org's default department. Returns null if either is missing.
 */
export async function getDefaultTeamIdForOrg(orgId: string): Promise<string | null> {
  if (!isUuid(orgId)) return null;
  const rows = await getDb()
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.name, DEFAULT_TEAM_NAME)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Idempotent: returns the org's "General" department id, creating it and
 * enrolling `ownerUserId` as admin if missing.
 */
export async function ensureDefaultDepartmentForOrg(
  orgId: string,
  ownerUserId: string,
): Promise<{ departmentId: string; created: boolean }> {
  return withTx(async (tx) => {
    const existing = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(
        and(
          eq(departments.orgId, orgId),
          eq(departments.name, DEFAULT_DEPARTMENT_NAME),
        ),
      )
      .limit(1);
    let departmentId = existing[0]?.id;
    let created = false;
    if (!departmentId) {
      departmentId = randomUUID();
      await tx.insert(departments).values({
        id: departmentId,
        orgId,
        name: DEFAULT_DEPARTMENT_NAME,
        colorToken: null,
        createdByUserId: ownerUserId,
        createdAt: new Date(),
      });
      created = true;
    }
    await tx
      .insert(departmentMemberships)
      .values({
        departmentId,
        userId: ownerUserId,
        role: "admin",
        addedByUserId: ownerUserId,
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [departmentMemberships.departmentId, departmentMemberships.userId],
      });
    return { departmentId, created };
  });
}

/**
 * Idempotent: returns the org's "Default" team id, creating it (under the
 * org's default department) and enrolling `ownerUserId` as admin if missing.
 * Auto-creates the default department if it doesn't exist yet.
 */
export async function ensureDefaultTeamForOrg(
  orgId: string,
  ownerUserId: string,
): Promise<{ teamId: string; departmentId: string; created: boolean }> {
  const { departmentId } = await ensureDefaultDepartmentForOrg(orgId, ownerUserId);
  return withTx(async (tx) => {
    const existing = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, orgId), eq(teams.name, DEFAULT_TEAM_NAME)))
      .limit(1);
    let teamId = existing[0]?.id;
    let created = false;
    if (!teamId) {
      teamId = randomUUID();
      await tx.insert(teams).values({
        id: teamId,
        orgId,
        departmentId,
        name: DEFAULT_TEAM_NAME,
        colorToken: null,
        createdByUserId: ownerUserId,
        createdAt: new Date(),
      });
      created = true;
    }
    await tx
      .insert(teamMemberships)
      .values({
        teamId,
        userId: ownerUserId,
        role: "admin",
        addedByUserId: ownerUserId,
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [teamMemberships.teamId, teamMemberships.userId],
      });
    return { teamId, departmentId, created };
  });
}

/**
 * Idempotent: ensures `userId` has a `default_org_id`. If they already do,
 * returns it. Otherwise creates an Org + admin membership + default
 * department + default team and stamps the user. Slug collisions are
 * resolved by appending a random suffix.
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
  await ensureDefaultTeamForOrg(orgId, userId);
  return { orgId, created: true };
}
