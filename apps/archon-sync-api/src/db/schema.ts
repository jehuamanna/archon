/**
 * Drizzle schema for sync-api on Postgres.
 *
 * Architecture (post Org/Department/Team migration):
 *
 *   Organisation (org_membership)
 *     └── Department (department_membership)
 *         └── Team (team_membership)
 *             └── ↔ Project   (team_projects: many-to-many)
 *                  └── Note (parent_id: self-tree) ↔ Note (note_edges: graph)
 *
 * - Spaces / Workspaces are gone. Project ↔ Team is many-to-many; access flows
 *   `note → project → team_projects → team_memberships → user`.
 * - Each project / note exists as a single canonical row (no per-user copy).
 * - Real FK constraints enforce hierarchy. ON DELETE policies favour RESTRICT
 *   on parent-of-content edges (org → dept → team → project) so orphans never
 *   appear silently, CASCADE on child-of-content edges (note → project,
 *   note_edges → notes, yjs_state → notes) so deletes propagate.
 *
 * Conventions:
 *  - All entity primary keys are `uuid`.
 *  - Epoch-ms `bigint` for `*_at_ms` timestamps; PG `timestamptz` for
 *    `*At` / `joined_at` / `granted_at`.
 *  - WPN-tree TS field names use snake_case for indexed structural fields.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
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

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

// ---------- legacy_object_id_map ----------

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
 * `users.refreshSessions` is an array of `{ jti, createdAt }` stored as `jsonb`.
 * `lastActiveTeamByOrg` keys orgId → teamId for the per-org "last team I was on"
 * pin used by the explorer. Org/department aren't pinned because departments
 * are derived from the team selection.
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
    lastActiveTeamId: uuid("last_active_team_id"),
    lastActiveTeamByOrg: jsonb("last_active_team_by_org").$type<Record<string, string>>(),
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
    boundUserId: uuid("bound_user_id").references(() => users.id, { onDelete: "cascade" }),
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

// ---------- orgs / departments / teams ----------

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
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
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'admin' | 'member'
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    byUser: index("org_memberships_user_id_idx").on(t.userId),
  }),
);

/**
 * Org invites carry optional team grants — the inviter pre-attaches the new
 * member to one or more teams in the org so they land on a useful project
 * view. `teamGrants` is a `[{ teamId, role }]` array; `role` here is the
 * team_membership role ('admin' | 'member'), not a project role.
 */
export const orgInvites = pgTable(
  "org_invites",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(), // 'admin' | 'member'
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull(), // 'pending' | 'accepted' | 'revoked' | 'declined' | 'expired'
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declinedByUserId: uuid("declined_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    teamGrants: jsonb("team_grants").$type<{ teamId: string; role: string }[]>(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("org_invites_token_hash_unique").on(t.tokenHash),
    pendingUnique: uniqueIndex("org_invites_pending_unique")
      .on(t.orgId, t.email, t.status)
      .where(sql`status = 'pending'`),
  }),
);

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    colorToken: text("color_token"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgNameUnique: uniqueIndex("departments_org_id_name_unique").on(t.orgId, t.name),
  }),
);

export const departmentMemberships = pgTable(
  "department_memberships",
  {
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'admin' | 'member'
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.departmentId, t.userId] }),
    byUser: index("department_memberships_user_id_idx").on(t.userId),
  }),
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    colorToken: text("color_token"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgNameUnique: uniqueIndex("teams_org_id_name_unique").on(t.orgId, t.name),
    byDepartment: index("teams_department_id_idx").on(t.departmentId),
  }),
);

export const teamMemberships = pgTable(
  "team_memberships",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'admin' | 'member'
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.userId] }),
    byUser: index("team_memberships_user_id_idx").on(t.userId),
  }),
);

// ---------- projects / notes ----------

/**
 * One canonical row per project. Access flows through `team_projects`; there
 * is no per-user shadow row, no `visibility`, and no workspace parent.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    creatorUserId: uuid("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    sortIndex: integer("sort_index").notNull(),
    colorToken: text("color_token"),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    settings: jsonb("settings"),
  },
  (t) => ({
    byOrgSort: index("projects_org_sort_idx").on(t.orgId, t.sortIndex),
  }),
);

/**
 * Bridge table: a project belongs to one or more teams. `role` is per-team:
 * a team can be a project owner (full control), contributor (read/write), or
 * viewer (read-only). The user's effective role on a project is the max of
 * the roles of the teams they're on that have access.
 */
export const teamProjects = pgTable(
  "team_projects",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'owner' | 'contributor' | 'viewer'
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.projectId] }),
    byProject: index("team_projects_project_id_idx").on(t.projectId),
  }),
);

/**
 * Notes form a per-project tree via `parentId` (self-FK). Cross-project
 * graph links go through `noteEdges`. Single canonical row per note id;
 * access derives from the note's project.
 */
export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => notes.id, {
      onDelete: "cascade",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
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
    byProjectParentSibling: index("notes_project_parent_sibling_idx").on(
      t.projectId,
      t.parentId,
      t.siblingIndex,
    ),
  }),
);

/**
 * Per-user UI state for the explorer (which note ids are expanded). Scoped
 * per-project per-user — orgs/teams aren't pinned here because the explorer
 * already knows the active team from session state.
 */
export const explorerState = pgTable(
  "explorer_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    expandedIds: jsonb("expanded_ids").$type<string[]>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.projectId] }),
  }),
);

/**
 * Cross-link graph layer. Tree edges live on `notes.parentId`; explicit
 * note-to-note links / mentions / backlinks live here.
 */
export const noteEdges = pgTable(
  "note_edges",
  {
    src: uuid("src")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    dst: uuid("dst")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("link"),
    meta: jsonb("meta"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.src, t.dst, t.kind] }),
    byDstKind: index("note_edges_dst_kind_idx").on(t.dst, t.kind),
  }),
);

// ---------- audit / prefs / notifications ----------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
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
  userId: uuid("user_id")
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  shellLayout: jsonb("shell_layout"),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
 * mdx-state head/chunks/cursors live in PG. Notification fanout uses
 * `pg_notify('mdx:'||projectId, chunkId)`.
 */
export const mdxStateHead = pgTable(
  "mdx_state_head",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    mode: text("mode").notNull(), // 'inline' | 'chunked'
    value: jsonb("value"),
    totalChunks: integer("total_chunks"),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    version: integer("version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
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
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    headVersion: integer("head_version").notNull(),
    data: bytea("data").notNull(),
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
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    resumeToken: jsonb("resume_token"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byUpdatedAt: index("mdx_state_ws_cursors_updated_at_idx").on(t.updatedAt),
  }),
);

// ---------- realtime collab (yjs body state) ----------

/**
 * Snapshot per note: most recent compacted Y.Doc state. The Hocuspocus
 * `onLoadDocument` reads `docBytes` and replays any `yjsStateUpdates` whose
 * `sequence > version` to recover the live document. `version` advances on
 * snapshot rewrites.
 */
export const yjsState = pgTable("yjs_state", {
  noteId: uuid("note_id")
    .primaryKey()
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  docBytes: bytea("doc_bytes").notNull(),
  version: bigint("version", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Append-only log of Yjs updates between snapshots. `sequence` is a
 * monotonic per-note counter; the writer is responsible for allocating it
 * under a single transaction.
 */
export const yjsStateUpdates = pgTable(
  "yjs_state_updates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    updateBytes: bytea("update_bytes").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byNoteSeq: index("yjs_state_updates_note_seq_idx").on(t.noteId, t.sequence),
  }),
);

// ---------- type re-exports ----------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Org = typeof organizations.$inferSelect;
export type Department = typeof departments.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type TeamMembership = typeof teamMemberships.$inferSelect;
export type TeamProject = typeof teamProjects.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type NoteEdge = typeof noteEdges.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type YjsState = typeof yjsState.$inferSelect;
export type NewYjsState = typeof yjsState.$inferInsert;
export type YjsStateUpdate = typeof yjsStateUpdates.$inferSelect;
export type NewYjsStateUpdate = typeof yjsStateUpdates.$inferInsert;
export type LegacyObjectIdMapRow = typeof legacyObjectIdMap.$inferSelect;
