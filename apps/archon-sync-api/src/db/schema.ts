/**
 * Drizzle schema for sync-api on Postgres. Mirrors the 22 Mongo collections
 * from `mongodump-pre-cutover-20260425-162501/nodex_sync/` plus a `note_edges`
 * table (for backfilled cross-links per Q2=a) and a `legacy_object_id_map`
 * table (for ObjectId→UUID translation per Q1=B).
 *
 * Conventions:
 *  - All entity primary keys are `uuid`. WPN tables (workspaces/projects/notes)
 *    inherit their UUIDs from the source data; ObjectId-keyed entities are
 *    reissued at import time and the legacy hex is stored in
 *    `legacy_object_id_map` for boundary translation.
 *  - Timestamp fields keep their existing flavor: epoch-ms `bigint` for fields
 *    that were `created_at_ms` / `updated_at_ms` in the Mongo schema; PG
 *    `timestamptz` for fields that were Mongo `Date` objects (createdAt,
 *    updatedAt, ts, etc.). The importer translates accordingly.
 *  - Uniqueness constraints mirror the Mongo `ensureIndexes` setup in
 *    apps/archon-sync-api/src/db.ts (around lines 180–290).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

// ---------- legacy_object_id_map (Q1=B) ----------

export const legacyObjectIdMap = pgTable(
  "legacy_object_id_map",
  {
    scope: text("scope").notNull(),
    legacyId: text("legacy_id").notNull(),
    newId: uuid("new_id").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scope, t.legacyId] }),
    byScopeNewId: index("legacy_object_id_map_scope_new_id_idx").on(t.scope, t.newId),
  }),
);

// ---------- identity ----------

/**
 * `users.refreshSessions` is `RefreshSessionDoc[]` ({ jti, createdAt }) in Mongo;
 * stored as `jsonb` here. `lastActiveSpaceByOrg` keeps its keyed-object shape.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    activeRefreshJti: text("active_refresh_jti"),
    refreshSessions: jsonb("refresh_sessions").$type<{ jti: string; createdAt: string }[]>(),
    defaultOrgId: uuid("default_org_id"),
    lastActiveOrgId: uuid("last_active_org_id"),
    lastActiveSpaceId: uuid("last_active_space_id"),
    lastActiveSpaceByOrg: jsonb("last_active_space_by_org").$type<Record<string, string>>(),
    lockedOrgId: uuid("locked_org_id"),
    isMasterAdmin: boolean("is_master_admin"),
    disabled: boolean("disabled"),
    displayName: text("display_name"),
    mustSetPassword: boolean("must_set_password"),
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
    masterAdminPartial: index("users_is_master_admin_idx").on(t.isMasterAdmin),
  }),
);

export const mcpDeviceSessions = pgTable(
  "mcp_device_sessions",
  {
    id: uuid("id").primaryKey().notNull(),
    userCode: text("user_code").notNull(),
    deviceCodeHash: text("device_code_hash").notNull(),
    status: text("status").notNull(),
    clientIp: inet("client_ip").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    boundUserId: uuid("bound_user_id"),
    issuedAccessToken: text("issued_access_token"),
    issuedRefreshToken: text("issued_refresh_token"),
  },
  (t) => ({
    userCodeUnique: uniqueIndex("mcp_device_sessions_user_code_unique").on(t.userCode),
    deviceCodeHashUnique: uniqueIndex("mcp_device_sessions_device_code_hash_unique").on(
      t.deviceCodeHash,
    ),
    boundStatusExpires: index("mcp_device_sessions_bound_status_expires_idx").on(
      t.boundUserId,
      t.status,
      t.expiresAt,
    ),
  }),
);

// ---------- orgs / spaces / teams ----------

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex("organizations_slug_unique").on(t.slug),
    byOwner: index("organizations_owner_user_id_idx").on(t.ownerUserId),
  }),
);

export const orgMemberships = pgTable(
  "org_memberships",
  {
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(), // 'admin' | 'member'
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    byUser: index("org_memberships_user_id_idx").on(t.userId),
  }),
);

export const orgInvites = pgTable(
  "org_invites",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(), // 'admin' | 'member'
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull(), // 'pending' | 'accepted' | 'revoked' | 'declined' | 'expired'
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id"),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declinedByUserId: uuid("declined_by_user_id"),
    spaceGrants: jsonb("space_grants").$type<{ spaceId: string; role: string }[]>(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("org_invites_token_hash_unique").on(t.tokenHash),
    pendingUnique: uniqueIndex("org_invites_pending_unique")
      .on(t.orgId, t.email, t.status)
      .where(sql`status = 'pending'`),
  }),
);

export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // 'default' | 'normal'
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    hidden: boolean("hidden"),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    hiddenByUserId: uuid("hidden_by_user_id"),
  },
  (t) => ({
    byOrg: index("spaces_org_id_idx").on(t.orgId),
    defaultPerOrg: index("spaces_default_per_org_idx")
      .on(t.orgId, t.kind)
      .where(sql`kind = 'default'`),
  }),
);

export const spaceMemberships = pgTable(
  "space_memberships",
  {
    spaceId: uuid("space_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(), // 'owner' | 'member' | 'viewer'
    addedByUserId: uuid("added_by_user_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.spaceId, t.userId] }),
    byUser: index("space_memberships_user_id_idx").on(t.userId),
  }),
);

export const spaceAnnouncements = pgTable(
  "space_announcements",
  {
    id: uuid("id").primaryKey().notNull(),
    spaceId: uuid("space_id").notNull(),
    authorUserId: uuid("author_user_id").notNull(),
    title: text("title").notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    bySpacePinnedCreated: index("space_announcements_space_pinned_created_idx").on(
      t.spaceId,
      t.pinned,
      t.createdAt,
    ),
  }),
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    colorToken: text("color_token"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgNameUnique: uniqueIndex("teams_org_id_name_unique").on(t.orgId, t.name),
  }),
);

export const teamMemberships = pgTable(
  "team_memberships",
  {
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    addedByUserId: uuid("added_by_user_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.userId] }),
    byUser: index("team_memberships_user_id_idx").on(t.userId),
  }),
);

export const teamSpaceGrants = pgTable(
  "team_space_grants",
  {
    teamId: uuid("team_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    role: text("role").notNull(), // SpaceRole
    grantedByUserId: uuid("granted_by_user_id").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.spaceId] }),
    bySpace: index("team_space_grants_space_id_idx").on(t.spaceId),
  }),
);

// ---------- sharing ----------

export const workspaceShares = pgTable(
  "workspace_shares",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(), // 'reader' | 'writer'
    addedByUserId: uuid("added_by_user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    workspaceUserUnique: uniqueIndex("workspace_shares_workspace_user_unique").on(
      t.workspaceId,
      t.userId,
    ),
    byUser: index("workspace_shares_user_id_idx").on(t.userId),
  }),
);

export const projectShares = pgTable(
  "project_shares",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(), // 'reader' | 'writer'
    addedByUserId: uuid("added_by_user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    projectUserUnique: uniqueIndex("project_shares_project_user_unique").on(
      t.projectId,
      t.userId,
    ),
    byUser: index("project_shares_user_id_idx").on(t.userId),
  }),
);

// ---------- WPN (workspace / project / note tree + cross-link edges) ----------

export const wpnWorkspaces = pgTable(
  "wpn_workspaces",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id"),
    spaceId: uuid("space_id"),
    visibility: text("visibility"), // 'public' | 'private' | 'shared'
    creatorUserId: uuid("creator_user_id"),
    name: text("name").notNull(),
    sortIndex: integer("sort_index").notNull(),
    colorToken: text("color_token"),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    settings: jsonb("settings"),
  },
  (t) => ({
    idUserUnique: uniqueIndex("wpn_workspaces_id_user_unique").on(t.id, t.userId),
    byUserSort: index("wpn_workspaces_user_sort_idx").on(t.userId, t.sortIndex),
    byOrgSpaceSort: index("wpn_workspaces_org_space_sort_idx").on(
      t.orgId,
      t.spaceId,
      t.sortIndex,
    ),
  }),
);

export const wpnProjects = pgTable(
  "wpn_projects",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id"),
    spaceId: uuid("space_id"),
    workspaceId: uuid("workspace_id").notNull(),
    visibility: text("visibility"), // 'public' | 'private' | 'shared'
    creatorUserId: uuid("creator_user_id"),
    name: text("name").notNull(),
    sortIndex: integer("sort_index").notNull(),
    colorToken: text("color_token"),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    settings: jsonb("settings"),
  },
  (t) => ({
    idUserUnique: uniqueIndex("wpn_projects_id_user_unique").on(t.id, t.userId),
    byUserWorkspace: index("wpn_projects_user_workspace_sort_idx").on(
      t.userId,
      t.workspaceId,
      t.sortIndex,
    ),
    byOrgSpaceWorkspace: index("wpn_projects_org_space_workspace_sort_idx").on(
      t.orgId,
      t.spaceId,
      t.workspaceId,
      t.sortIndex,
    ),
  }),
);

export const wpnNotes = pgTable(
  "wpn_notes",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id"),
    spaceId: uuid("space_id"),
    createdByUserId: uuid("created_by_user_id"),
    updatedByUserId: uuid("updated_by_user_id"),
    projectId: uuid("project_id").notNull(),
    parentId: uuid("parent_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata"),
    siblingIndex: integer("sibling_index").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    deleted: boolean("deleted"),
  },
  (t) => ({
    idUserUnique: uniqueIndex("wpn_notes_id_user_unique").on(t.id, t.userId),
    byProjectParentSibling: index("wpn_notes_project_parent_sibling_idx").on(
      t.userId,
      t.projectId,
      t.parentId,
      t.siblingIndex,
    ),
    byOrgSpaceProject: index("wpn_notes_org_space_project_idx").on(
      t.orgId,
      t.spaceId,
      t.projectId,
      t.parentId,
      t.siblingIndex,
    ),
  }),
);

export const wpnExplorerState = pgTable(
  "wpn_explorer_state",
  {
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id"),
    spaceId: uuid("space_id"),
    projectId: uuid("project_id").notNull(),
    expandedIds: jsonb("expanded_ids").$type<string[]>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.projectId] }),
    byOrgSpaceProject: index("wpn_explorer_state_org_space_project_idx").on(
      t.orgId,
      t.spaceId,
      t.projectId,
    ),
  }),
);

/**
 * Cross-link graph layer (Q2=a). Tree edges stay on `wpn_notes.parent_id`;
 * `note_edges` holds backfilled and future explicit links.
 */
export const noteEdges = pgTable(
  "note_edges",
  {
    src: uuid("src").notNull(),
    dst: uuid("dst").notNull(),
    kind: text("kind").notNull().default("link"),
    meta: jsonb("meta"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.src, t.dst, t.kind] }),
    byDstKind: index("note_edges_dst_kind_idx").on(t.dst, t.kind),
  }),
);

// ---------- audit / announcements / prefs / notifications ----------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byOrgTs: index("audit_events_org_ts_idx").on(t.orgId, t.ts),
    byTargetTs: index("audit_events_target_ts_idx").on(t.targetType, t.targetId, t.ts),
  }),
);

export const userPrefs = pgTable("user_prefs", {
  userId: uuid("user_id").primaryKey().notNull(),
  shellLayout: jsonb("shell_layout"),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    link: text("link").notNull(),
    status: text("status").notNull(), // 'unread' | 'read' | 'consumed' | 'dismissed'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dedupeKey: text("dedupe_key"),
  },
  (t) => ({
    byUserCreated: index("notifications_user_created_idx").on(t.userId, t.createdAt),
    byUserStatusCreated: index("notifications_user_status_created_idx").on(
      t.userId,
      t.status,
      t.createdAt,
    ),
    dedupeKeyPartialUnique: uniqueIndex("notifications_dedupe_key_unique")
      .on(t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
  }),
);

// ---------- mdx-state ----------

/**
 * The mdx-state head/chunks/cursors moved to PG. Notification fanout is now
 * `pg_notify('mdx:'||workspaceId, chunkId)` (replaces Mongo Change Streams).
 */
export const mdxStateHead = pgTable(
  "mdx_state_head",
  {
    projectId: uuid("project_id").notNull(),
    key: text("key").notNull(),
    mode: text("mode").notNull(), // 'inline' | 'chunked'
    value: jsonb("value"),
    totalChunks: integer("total_chunks"),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    version: integer("version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    updatedByUserId: uuid("updated_by_user_id").notNull(),
    updatedByEmail: text("updated_by_email").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.key] }),
    byProjectUpdated: index("mdx_state_head_project_updated_idx").on(
      t.projectId,
      t.updatedAt,
    ),
  }),
);

export const mdxStateChunks = pgTable(
  "mdx_state_chunks",
  {
    projectId: uuid("project_id").notNull(),
    key: text("key").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    headVersion: integer("head_version").notNull(),
    data: customType<{ data: Buffer; driverData: Buffer }>({
      dataType() {
        return "bytea";
      },
    })("data").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.key, t.chunkIndex, t.headVersion] }),
    byProjectKeyVersion: index("mdx_state_chunks_project_key_version_idx").on(
      t.projectId,
      t.key,
      t.headVersion,
    ),
  }),
);

export const mdxStateWsCursors = pgTable(
  "mdx_state_ws_cursors",
  {
    connectionId: text("connection_id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    resumeToken: jsonb("resume_token"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byUpdatedAt: index("mdx_state_ws_cursors_updated_at_idx").on(t.updatedAt),
  }),
);

// ---------- legacy `notes` (0 docs in dump; schema preserved for round-tripping) ----------

export const notes = pgTable(
  "notes",
  {
    id: text("id").notNull(),
    userId: uuid("user_id").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    deleted: boolean("deleted").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    type: text("type").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.userId] }),
    byUserUpdated: index("notes_user_updated_idx").on(t.userId, t.updatedAt),
  }),
);

// ---------- type re-exports for convenience ----------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Org = typeof organizations.$inferSelect;
export type Space = typeof spaces.$inferSelect;
export type WpnWorkspace = typeof wpnWorkspaces.$inferSelect;
export type WpnProject = typeof wpnProjects.$inferSelect;
export type WpnNote = typeof wpnNotes.$inferSelect;
export type NoteEdge = typeof noteEdges.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type LegacyObjectIdMapRow = typeof legacyObjectIdMap.$inferSelect;
