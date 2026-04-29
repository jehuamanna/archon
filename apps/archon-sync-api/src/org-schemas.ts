import { z } from "zod";

// ----- Roles -----

export type OrgRole = "admin" | "member";
export type DepartmentRole = "admin" | "member";
export type TeamMembershipRole = "admin" | "member";
/** Per-team role on a project. Folded by `getEffectiveProjectRoles` taking
 * the strongest of (owner > contributor > viewer) when a user belongs to
 * multiple teams that share a project. */
export type ProjectRole = "owner" | "contributor" | "viewer";

export const orgRoleSchema = z.enum(["admin", "member"]);
export const departmentRoleSchema = z.enum(["admin", "member"]);
export const teamMembershipRoleSchema = z.enum(["admin", "member"]);
export const projectRoleSchema = z.enum(["owner", "contributor", "viewer"]);

// ----- Org -----

export type OrgDoc = {
  _id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  createdAt: Date;
};

export type OrgMembershipDoc = {
  _id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: Date;
};

export const createOrgBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .optional(),
});

export const updateOrgBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .optional(),
});

export const setActiveOrgBody = z.object({
  orgId: z.string().min(1),
});

export const setMemberRoleBody = z.object({
  role: orgRoleSchema,
});

export const createOrgMemberBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
  role: orgRoleSchema.default("member"),
});

export const resetMemberPasswordBody = z.object({
  password: z.string().min(8).max(256),
});

// ----- Org invites — carry optional team grants -----

export type OrgInviteStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "declined"
  | "expired";

/** Pre-attaches the invited user to a team on accept. */
export type InviteTeamGrant = {
  teamId: string;
  role: TeamMembershipRole;
};

export type OrgInviteDoc = {
  _id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  tokenHash: string;
  status: OrgInviteStatus;
  invitedByUserId: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedByUserId?: string;
  declinedAt?: Date;
  declinedByUserId?: string;
  /** Teams to auto-join on accept, each with a team_membership role. */
  teamGrants?: InviteTeamGrant[];
};

export const inviteTeamGrantSchema = z.object({
  teamId: z.string().min(1),
  role: teamMembershipRoleSchema,
});

export const createInviteBody = z.object({
  email: z.string().email(),
  role: orgRoleSchema.default("member"),
  teamGrants: z.array(inviteTeamGrantSchema).max(50).optional(),
});

export const declineInviteBody = z
  .object({
    token: z.string().min(10),
  })
  .strict();

export const acceptInviteBody = z
  .object({
    token: z.string().min(10),
    /** Required when accepting on a brand-new account (mustSetPassword). */
    password: z.string().min(8).max(256).optional(),
    /** Optional display name set on first password setup. */
    displayName: z.string().trim().max(120).optional(),
  })
  .strict();

// ----- Departments -----

export type DepartmentDoc = {
  _id: string;
  orgId: string;
  name: string;
  colorToken: string | null;
  createdByUserId: string;
  createdAt: Date;
};

export type DepartmentMembershipDoc = {
  _id: string;
  departmentId: string;
  userId: string;
  role: DepartmentRole;
  addedByUserId: string;
  joinedAt: Date;
};

export const createDepartmentBody = z.object({
  name: z.string().trim().min(1).max(120),
  colorToken: z.string().trim().max(32).nullable().optional(),
});

export const updateDepartmentBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  colorToken: z.string().trim().max(32).nullable().optional(),
});

export const addDepartmentMemberBody = z.object({
  userId: z.string().min(1),
  role: departmentRoleSchema.default("member"),
});

export const setDepartmentMemberRoleBody = z.object({
  role: departmentRoleSchema,
});

// ----- Teams -----

export type TeamDoc = {
  _id: string;
  orgId: string;
  departmentId: string;
  name: string;
  /** Free-form color identifier (e.g. "amber", "#A45A52") for chips. */
  colorToken: string | null;
  createdByUserId: string;
  createdAt: Date;
};

export type TeamMembershipDoc = {
  _id: string;
  teamId: string;
  userId: string;
  role: TeamMembershipRole;
  addedByUserId: string;
  joinedAt: Date;
};

export const createTeamBody = z.object({
  departmentId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  colorToken: z.string().trim().max(32).nullable().optional(),
});

export const updateTeamBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  colorToken: z.string().trim().max(32).nullable().optional(),
  /** Move a team to a different department within the same org. */
  departmentId: z.string().min(1).optional(),
});

export const addTeamMemberBody = z.object({
  userId: z.string().min(1),
  role: teamMembershipRoleSchema.default("member"),
});

export const setTeamMemberRoleBody = z.object({
  role: teamMembershipRoleSchema,
});

export const setActiveTeamBody = z.object({
  teamId: z.string().min(1),
});

// ----- Team ↔ Project bridge -----

/** Grants a team a per-project role; user effective role is the strongest
 * across teams they're on that share a project. */
export type TeamProjectDoc = {
  _id: string;
  teamId: string;
  projectId: string;
  role: ProjectRole;
  grantedByUserId: string;
  grantedAt: Date;
};

export const grantTeamProjectBody = z.object({
  projectId: z.string().min(1),
  role: projectRoleSchema.default("contributor"),
});

export const setTeamProjectRoleBody = z.object({
  role: projectRoleSchema,
});

// ----- Audit -----

export type AuditAction =
  | "org.create"
  | "org.update"
  | "org.delete"
  | "org.member.role_change"
  | "org.member.remove"
  | "org.member.create_with_password"
  | "org.member.password_reset"
  | "org.invite.create"
  | "org.invite.revoke"
  | "org.invite.regenerate"
  | "org.invite.accept"
  | "org.invite.decline"
  | "department.create"
  | "department.update"
  | "department.delete"
  | "department.member.add"
  | "department.member.role_change"
  | "department.member.remove"
  | "team.create"
  | "team.update"
  | "team.delete"
  | "team.member.add"
  | "team.member.role_change"
  | "team.member.remove"
  | "team.project.grant"
  | "team.project.role_change"
  | "team.project.revoke"
  | "project.create"
  | "project.update"
  | "project.delete"
  | "master.org_admin.create_with_password"
  | "master.org_admin.promote"
  | "master.org_admin.demote"
  | "master.user.password_reset"
  | "master.user.disable"
  | "master.user.enable"
  | "master.invite.create"
  | "master.invite.revoke"
  | "master.invite.regenerate"
  | "master.invite.accept";

export type AuditEventDoc = {
  _id: string;
  orgId: string;
  actorUserId: string;
  action: AuditAction;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown> | null;
  ts: Date;
};

export type MigrationDoc = {
  _id: string;
  key: string;
  ranAt: Date;
};

// ----- Inferred input types -----

export type CreateOrgInput = z.infer<typeof createOrgBody>;
export type CreateInviteInput = z.infer<typeof createInviteBody>;
export type AcceptInviteInput = z.infer<typeof acceptInviteBody>;
export type DeclineInviteInput = z.infer<typeof declineInviteBody>;
export type InviteTeamGrantInput = z.infer<typeof inviteTeamGrantSchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentBody>;
export type CreateTeamInput = z.infer<typeof createTeamBody>;
export type GrantTeamProjectInput = z.infer<typeof grantTeamProjectBody>;
