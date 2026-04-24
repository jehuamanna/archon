import type { ObjectId } from "mongodb";
import { z } from "zod";

export type OrgRole = "admin" | "member";
export type SpaceRole = "owner" | "member" | "viewer";

export type SpaceKind = "default" | "normal";

export type SpaceDoc = {
  _id: ObjectId;
  orgId: string;
  name: string;
  kind: SpaceKind;
  createdByUserId: string;
  createdAt: Date;
};

export type SpaceMembershipDoc = {
  _id: ObjectId;
  spaceId: string;
  userId: string;
  role: SpaceRole;
  addedByUserId: string;
  joinedAt: Date;
};

export const spaceRoleSchema = z.enum(["owner", "member", "viewer"]);

export const createSpaceBody = z.object({
  name: z.string().trim().min(1).max(120),
});

export const updateSpaceBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

export const addSpaceMemberBody = z.object({
  userId: z.string().min(1),
  role: spaceRoleSchema.default("member"),
});

export const setSpaceMemberRoleBody = z.object({
  role: spaceRoleSchema,
});

export const setActiveSpaceBody = z.object({
  spaceId: z.string().min(1),
});

// ----- Phase 3: Teams -----

export type TeamDoc = {
  _id: ObjectId;
  orgId: string;
  name: string;
  /** Free-form color identifier (e.g. "amber", "#A45A52") for chips. */
  colorToken: string | null;
  createdByUserId: string;
  createdAt: Date;
};

export type TeamMembershipDoc = {
  _id: ObjectId;
  teamId: string;
  userId: string;
  addedByUserId: string;
  joinedAt: Date;
};

/** Grants a Team a role in a Space; merged with direct memberships at read. */
export type TeamSpaceGrantDoc = {
  _id: ObjectId;
  teamId: string;
  spaceId: string;
  role: SpaceRole;
  grantedByUserId: string;
  grantedAt: Date;
};

export const createTeamBody = z.object({
  name: z.string().trim().min(1).max(120),
  colorToken: z.string().trim().max(32).optional(),
});

export const updateTeamBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  colorToken: z.string().trim().max(32).nullable().optional(),
});

export const addTeamMemberBody = z.object({
  userId: z.string().min(1),
});

export const grantTeamSpaceBody = z.object({
  spaceId: z.string().min(1),
  role: spaceRoleSchema.default("member"),
});

// ----- Phase 4: Workspace visibility -----

export type WorkspaceVisibility = "public" | "private" | "shared";

/** Phase 8: per-member role stamped on workspace/project share rows. */
export type ShareRole = "reader" | "writer";

export const shareRoleSchema = z.enum(["reader", "writer"]);

export type WorkspaceShareDoc = {
  _id: ObjectId;
  workspaceId: string;
  userId: string;
  /** Phase 8: reader (default) grants read-only; writer grants write. Backfilled by m_007 to "reader". */
  role: ShareRole;
  addedByUserId: string;
  addedAt: Date;
};

export const workspaceVisibilitySchema = z.enum(["public", "private", "shared"]);

export const setWorkspaceVisibilityBody = z.object({
  visibility: workspaceVisibilitySchema,
});

export const moveWorkspaceToSpaceBody = z.object({
  targetSpaceId: z.string().min(1),
});

export const addWorkspaceShareBody = z.object({
  userId: z.string().min(1),
  role: shareRoleSchema.default("reader"),
});

export const updateWorkspaceShareBody = z.object({
  role: shareRoleSchema,
});

// ----- Phase 8: Project visibility + shares -----

export type ProjectVisibility = "public" | "private" | "shared";

export type ProjectShareDoc = {
  _id: ObjectId;
  projectId: string;
  userId: string;
  role: ShareRole;
  addedByUserId: string;
  addedAt: Date;
};

export const projectVisibilitySchema = z.enum(["public", "private", "shared"]);

export const setProjectVisibilityBody = z.object({
  visibility: projectVisibilitySchema,
});

export const addProjectShareBody = z.object({
  userId: z.string().min(1),
  role: shareRoleSchema.default("reader"),
});

export const updateProjectShareBody = z.object({
  role: shareRoleSchema,
});

// ----- Phase 5: Announcements -----

export type SpaceAnnouncementDoc = {
  _id: ObjectId;
  spaceId: string;
  authorUserId: string;
  title: string;
  contentMarkdown: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const createAnnouncementBody = z.object({
  title: z.string().trim().min(1).max(200),
  contentMarkdown: z.string().max(50_000),
  pinned: z.boolean().optional(),
});

export const updateAnnouncementBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  contentMarkdown: z.string().max(50_000).optional(),
  pinned: z.boolean().optional(),
});

// ----- Phase 7: Audit -----

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
  | "org.invite.accept"
  | "org.invite.decline"
  | "space.create"
  | "space.delete"
  | "space.rename"
  | "space.member.add"
  | "space.member.role_change"
  | "space.member.remove"
  | "team.create"
  | "team.update"
  | "team.delete"
  | "team.member.add"
  | "team.member.remove"
  | "team.grant.set"
  | "team.grant.revoke"
  | "workspace.visibility.set"
  | "workspace.move_to_space"
  | "workspace.share.add"
  | "workspace.share.update"
  | "workspace.share.remove"
  | "project.visibility.set"
  | "project.share.add"
  | "project.share.update"
  | "project.share.remove"
  | "announcement.create"
  | "announcement.update"
  | "announcement.delete"
  | "master.org_admin.create_with_password"
  | "master.org_admin.promote"
  | "master.org_admin.demote";

export type AuditEventDoc = {
  _id: ObjectId;
  orgId: string;
  actorUserId: string;
  action: AuditAction;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown> | null;
  ts: Date;
};

export type OrgDoc = {
  _id: ObjectId;
  name: string;
  slug: string;
  ownerUserId: string;
  createdAt: Date;
};

export type OrgMembershipDoc = {
  _id: ObjectId;
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: Date;
};

export type OrgInviteStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "declined"
  | "expired";

export type InviteSpaceGrant = {
  spaceId: string;
  role: SpaceRole;
};

export type OrgInviteDoc = {
  _id: ObjectId;
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
  /** Phase 8: spaces to auto-join on accept, with per-space role. */
  spaceGrants?: InviteSpaceGrant[];
};

export type MigrationDoc = {
  _id: ObjectId;
  key: string;
  ranAt: Date;
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

export const orgRoleSchema = z.enum(["admin", "member"]);

export const inviteSpaceGrantSchema = z.object({
  spaceId: z.string().min(1),
  role: spaceRoleSchema,
});

export const createInviteBody = z.object({
  email: z.string().email(),
  role: orgRoleSchema.default("member"),
  spaceGrants: z.array(inviteSpaceGrantSchema).max(50).optional(),
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

export type CreateOrgInput = z.infer<typeof createOrgBody>;
export type CreateInviteInput = z.infer<typeof createInviteBody>;
export type AcceptInviteInput = z.infer<typeof acceptInviteBody>;
export type DeclineInviteInput = z.infer<typeof declineInviteBody>;
export type InviteSpaceGrantInput = z.infer<typeof inviteSpaceGrantSchema>;
