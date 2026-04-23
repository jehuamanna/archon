import {
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
  type MongoClientOptions,
} from "mongodb";
import type {
  AuditEventDoc,
  MigrationDoc,
  OrgDoc,
  OrgInviteDoc,
  OrgMembershipDoc,
  ProjectShareDoc,
  ProjectVisibility,
  SpaceAnnouncementDoc,
  SpaceDoc,
  SpaceMembershipDoc,
  TeamDoc,
  TeamMembershipDoc,
  TeamSpaceGrantDoc,
  WorkspaceShareDoc,
  WorkspaceVisibility,
} from "./org-schemas.js";
import type { NotificationDoc } from "./notification-schemas.js";
import { ensureMdxStateIndexes } from "./mdx-state/schema.js";

export type SyncNoteDoc = {
  id: string;
  userId: string;
  updatedAt: number;
  deleted: boolean;
  version: number;
  title: string;
  content: string;
  type: "markdown" | "text" | "code" | "image";
};

/** WPN workspace row (Mongo); aligns with {@link WpnWorkspaceRow} in repo `wpn-v2-types`. */
export type WpnWorkspaceDoc = {
  id: string;
  userId: string;
  /** Phase 2: Organization the workspace belongs to. Backfilled by m_002. */
  orgId?: string;
  /** Phase 2: Space the workspace belongs to. Backfilled by m_002. */
  spaceId?: string;
  /** Phase 4: visibility within the space. Backfilled by m_004 to "public". */
  visibility?: WorkspaceVisibility;
  /** Phase 4: original creator (for `private` and `shared` access checks). */
  creatorUserId?: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  /** Arbitrary UI/settings blob (GET/PATCH `/wpn/workspaces/:id/settings`). */
  settings?: Record<string, unknown> | null;
};

export type WpnProjectDoc = {
  id: string;
  userId: string;
  orgId?: string;
  spaceId?: string;
  workspace_id: string;
  /** Phase 8: visibility within the parent workspace. Backfilled by m_008 to "public". */
  visibility?: ProjectVisibility;
  /** Phase 8: original creator (for `private` and `shared` project access checks). */
  creatorUserId?: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  settings?: Record<string, unknown> | null;
};

export type WpnNoteDoc = {
  id: string;
  userId: string;
  orgId?: string;
  spaceId?: string;
  /** Phase 6: original creator (backfilled by m_006 from `userId`). */
  created_by_user_id?: string;
  /** Phase 6: last editor (backfilled by m_006 from `userId`). */
  updated_by_user_id?: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  sibling_index: number;
  created_at_ms: number;
  updated_at_ms: number;
  /** Soft-delete for future sync; reads ignore when true. */
  deleted?: boolean;
};

export type WpnExplorerStateDoc = {
  userId: string;
  orgId?: string;
  spaceId?: string;
  project_id: string;
  expanded_ids: string[];
};

/** Per-user UI chrome persisted from web (shell layout, etc.). */
export type UserPrefsDoc = {
  userId: string;
  shellLayout: unknown | null;
  updatedAtMs: number;
};

/** MCP browser device login (OAuth-style); TTL via `expiresAt`. */
export type McpDeviceSessionDoc = {
  _id?: ObjectId;
  userCode: string;
  deviceCodeHash: string;
  status: "awaiting_user" | "awaiting_mcp" | "consumed";
  clientIp: string;
  createdAt: Date;
  expiresAt: Date;
  boundUserId?: string;
  issuedAccessToken?: string | null;
  issuedRefreshToken?: string | null;
};

let client: MongoClient | null = null;
let db: Db | null = null;
let connectInFlight: Promise<Db> | null = null;

function mongoClientOptions(): MongoClientOptions {
  const serverless =
    process.env.VERCEL === "1" || process.env.ARCHON_SYNC_API_SERVERLESS === "1";
  return {
    maxPoolSize: serverless ? 10 : 100,
    minPoolSize: serverless ? 0 : undefined,
    serverSelectionTimeoutMS: 10_000,
  };
}

export async function connectMongo(uri: string, dbName: string): Promise<Db> {
  if (db) {
    return db;
  }
  connectInFlight ??= (async () => {
    const c = new MongoClient(uri, mongoClientOptions());
    await c.connect();
    client = c;
    const database = c.db(dbName);
    await ensureIndexes(database);
    db = database;
    return database;
  })();
  try {
    return await connectInFlight;
  } finally {
    connectInFlight = null;
  }
}

/**
 * Idempotent Mongo connect using `MONGODB_URI` / `MONGODB_DB` (or dev defaults).
 * Safe for serverless: concurrent invocations share one in-flight connect.
 */
export async function ensureMongoConnected(): Promise<Db> {
  const uri =
    typeof process.env.MONGODB_URI === "string" && process.env.MONGODB_URI.trim()
      ? process.env.MONGODB_URI.trim()
      : "mongodb://127.0.0.1:27017";
  const dbName =
    typeof process.env.MONGODB_DB === "string" && process.env.MONGODB_DB.trim()
      ? process.env.MONGODB_DB.trim()
      : "archon_sync";
  return connectMongo(uri, dbName);
}

async function ensureIndexes(database: Db): Promise<void> {
  await database.collection("users").createIndex({ email: 1 }, { unique: true });
  await database
    .collection("users")
    .createIndex(
      { isMasterAdmin: 1 },
      { partialFilterExpression: { isMasterAdmin: true } },
    );
  const notes = database.collection<SyncNoteDoc>("notes");
  await notes.createIndex({ id: 1, userId: 1 }, { unique: true });
  await notes.createIndex({ userId: 1, updatedAt: 1 });

  const wpnWs = database.collection<WpnWorkspaceDoc>("wpn_workspaces");
  await wpnWs.createIndex({ id: 1, userId: 1 }, { unique: true });
  await wpnWs.createIndex({ userId: 1, sort_index: 1 });

  const wpnProj = database.collection<WpnProjectDoc>("wpn_projects");
  await wpnProj.createIndex({ id: 1, userId: 1 }, { unique: true });
  await wpnProj.createIndex({ userId: 1, workspace_id: 1, sort_index: 1 });

  const wpnNotes = database.collection<WpnNoteDoc>("wpn_notes");
  await wpnNotes.createIndex({ id: 1, userId: 1 }, { unique: true });
  await wpnNotes.createIndex({ userId: 1, project_id: 1, parent_id: 1, sibling_index: 1 });

  const wpnEx = database.collection<WpnExplorerStateDoc>("wpn_explorer_state");
  await wpnEx.createIndex({ userId: 1, project_id: 1 }, { unique: true });

  const prefs = database.collection<UserPrefsDoc>("user_prefs");
  await prefs.createIndex({ userId: 1 }, { unique: true });

  const notifications = database.collection<NotificationDoc>("notifications");
  await notifications.createIndex({ userId: 1, createdAt: -1 });
  await notifications.createIndex({ userId: 1, status: 1, createdAt: -1 });
  await notifications.createIndex(
    { dedupeKey: 1 },
    { unique: true, partialFilterExpression: { dedupeKey: { $exists: true } } },
  );

  const mcpDev = database.collection<McpDeviceSessionDoc>("mcp_device_sessions");
  await mcpDev.createIndex({ userCode: 1 }, { unique: true });
  await mcpDev.createIndex({ deviceCodeHash: 1 }, { unique: true });
  await mcpDev.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await mcpDev.createIndex({ boundUserId: 1, status: 1, expiresAt: 1 });

  const orgs = database.collection<OrgDoc>("organizations");
  await orgs.createIndex({ slug: 1 }, { unique: true });
  await orgs.createIndex({ ownerUserId: 1 });

  const orgMembers = database.collection<OrgMembershipDoc>("org_memberships");
  await orgMembers.createIndex({ orgId: 1, userId: 1 }, { unique: true });
  await orgMembers.createIndex({ userId: 1 });

  const orgInvites = database.collection<OrgInviteDoc>("org_invites");
  await orgInvites.createIndex(
    { orgId: 1, email: 1, status: 1 },
    {
      unique: true,
      partialFilterExpression: { status: "pending" },
    },
  );
  await orgInvites.createIndex({ tokenHash: 1 }, { unique: true });
  await orgInvites.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { status: "pending" } },
  );

  const spaces = database.collection<SpaceDoc>("spaces");
  await spaces.createIndex({ orgId: 1 });
  await spaces.createIndex(
    { orgId: 1, kind: 1 },
    { partialFilterExpression: { kind: "default" } },
  );

  const spaceMembers = database.collection<SpaceMembershipDoc>("space_memberships");
  await spaceMembers.createIndex({ spaceId: 1, userId: 1 }, { unique: true });
  await spaceMembers.createIndex({ userId: 1 });

  const teams = database.collection<TeamDoc>("teams");
  await teams.createIndex({ orgId: 1, name: 1 }, { unique: true });

  const teamMembers = database.collection<TeamMembershipDoc>("team_memberships");
  await teamMembers.createIndex({ teamId: 1, userId: 1 }, { unique: true });
  await teamMembers.createIndex({ userId: 1 });

  const teamGrants = database.collection<TeamSpaceGrantDoc>("team_space_grants");
  await teamGrants.createIndex({ teamId: 1, spaceId: 1 }, { unique: true });
  await teamGrants.createIndex({ spaceId: 1 });

  // Phase 4
  const wsShares = database.collection<WorkspaceShareDoc>("workspace_shares");
  await wsShares.createIndex({ workspaceId: 1, userId: 1 }, { unique: true });
  await wsShares.createIndex({ userId: 1 });

  // Phase 8
  const projShares = database.collection<ProjectShareDoc>("project_shares");
  await projShares.createIndex({ projectId: 1, userId: 1 }, { unique: true });
  await projShares.createIndex({ userId: 1 });

  // Phase 5
  const announcements = database.collection<SpaceAnnouncementDoc>("space_announcements");
  await announcements.createIndex({ spaceId: 1, pinned: -1, createdAt: -1 });

  // Phase 7
  const audit = database.collection<AuditEventDoc>("audit_events");
  await audit.createIndex({ orgId: 1, ts: -1 });
  await audit.createIndex({ targetType: 1, targetId: 1, ts: -1 });

  // Phase 2: compound indexes for org+space scoped reads (alongside legacy userId).
  await wpnWs.createIndex({ orgId: 1, spaceId: 1, sort_index: 1 });
  await wpnProj.createIndex({ orgId: 1, spaceId: 1, workspace_id: 1, sort_index: 1 });
  await wpnNotes.createIndex({ orgId: 1, spaceId: 1, project_id: 1, parent_id: 1, sibling_index: 1 });
  await wpnEx.createIndex({ orgId: 1, spaceId: 1, project_id: 1 });

  const migrations = database.collection<MigrationDoc>("_migrations");
  await migrations.createIndex({ key: 1 }, { unique: true });

  await ensureMdxStateIndexes(database);

  await runIdempotentMigrations(database);
}

/**
 * Lazy backfills run on every connect; cheap when there's nothing to do.
 * Only the first execution writes its key to `_migrations` — subsequent runs
 * skip the bulk scan but new users still get inline org creation via
 * {@link ensureUserHasDefaultOrg}.
 */
async function runIdempotentMigrations(database: Db): Promise<void> {
  await m_001_default_org_per_user(database);
  await m_002_default_space_per_org(database);
  await m_004_workspace_visibility(database);
  await m_006_note_authorship(database);
  await m_007_workspace_share_role(database);
  await m_008_project_visibility(database);
}

/**
 * Phase 8: legacy `workspace_shares` rows predate per-member roles. Default to
 * "reader" so nobody silently gains write — writes only expand on explicit
 * admin action via PATCH .../shares/:userId.
 */
async function m_007_workspace_share_role(database: Db): Promise<void> {
  const key = "m_007_workspace_share_role";
  const migrations = database.collection<MigrationDoc>("_migrations");
  const ran = await migrations.findOne({ key });
  if (ran) {
    return;
  }
  await database
    .collection<WorkspaceShareDoc>("workspace_shares")
    .updateMany({ role: { $exists: false } }, { $set: { role: "reader" } });
  await migrations.updateOne(
    { key },
    { $setOnInsert: { key, ranAt: new Date() } },
    { upsert: true },
  );
}

/**
 * Phase 8: stamp existing projects with visibility "public" and creatorUserId
 * (fallback to `userId`) so the new project-ACL checks can short-circuit
 * cleanly. Mirrors {@link m_004_workspace_visibility}.
 */
async function m_008_project_visibility(database: Db): Promise<void> {
  const key = "m_008_project_visibility";
  const migrations = database.collection<MigrationDoc>("_migrations");
  const ran = await migrations.findOne({ key });
  if (ran) {
    return;
  }
  await database.collection<WpnProjectDoc>("wpn_projects").updateMany(
    { visibility: { $exists: false } },
    [
      {
        $set: {
          visibility: "public",
          creatorUserId: { $ifNull: ["$creatorUserId", "$userId"] },
        },
      },
    ],
  );
  await migrations.updateOne(
    { key },
    { $setOnInsert: { key, ranAt: new Date() } },
    { upsert: true },
  );
}

async function m_004_workspace_visibility(database: Db): Promise<void> {
  const key = "m_004_workspace_visibility";
  const migrations = database.collection<MigrationDoc>("_migrations");
  const ran = await migrations.findOne({ key });
  if (ran) {
    return;
  }
  await database
    .collection<WpnWorkspaceDoc>("wpn_workspaces")
    .updateMany(
      { visibility: { $exists: false } },
      [
        {
          $set: {
            visibility: "public",
            creatorUserId: { $ifNull: ["$creatorUserId", "$userId"] },
          },
        },
      ],
    );
  await migrations.updateOne(
    { key },
    { $setOnInsert: { key, ranAt: new Date() } },
    { upsert: true },
  );
}

async function m_006_note_authorship(database: Db): Promise<void> {
  const key = "m_006_note_authorship";
  const migrations = database.collection<MigrationDoc>("_migrations");
  const ran = await migrations.findOne({ key });
  if (ran) {
    return;
  }
  await database
    .collection<WpnNoteDoc>("wpn_notes")
    .updateMany(
      { created_by_user_id: { $exists: false } },
      [
        {
          $set: {
            created_by_user_id: "$userId",
            updated_by_user_id: "$userId",
          },
        },
      ],
    );
  await migrations.updateOne(
    { key },
    { $setOnInsert: { key, ranAt: new Date() } },
    { upsert: true },
  );
}

async function m_001_default_org_per_user(database: Db): Promise<void> {
  const key = "m_001_default_org_per_user";
  const migrations = database.collection<MigrationDoc>("_migrations");
  const ran = await migrations.findOne({ key });
  if (ran) {
    return;
  }
  const users = database.collection<UserDoc>("users");
  const cursor = users.find({
    $or: [{ defaultOrgId: { $exists: false } }, { defaultOrgId: null }],
  });
  for await (const user of cursor) {
    await ensureUserHasDefaultOrg(database, user._id.toHexString(), user.email);
  }
  await migrations.updateOne(
    { key },
    { $setOnInsert: { key, ranAt: new Date() } },
    { upsert: true },
  );
}

function deriveSlugCandidate(email: string): string {
  const local = email.split("@", 1)[0] ?? email;
  const cleaned = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length >= 2 ? cleaned.slice(0, 56) : `org-${cleaned || "x"}`;
}

/**
 * Phase 2 backfill: every Org gets one default Space; every space gets the
 * org owner as Space Owner; every WPN doc owned by the org owner gets stamped
 * with `orgId` + `spaceId`. Idempotent and gated by `_migrations`.
 */
async function m_002_default_space_per_org(database: Db): Promise<void> {
  const key = "m_002_default_space_per_org";
  const migrations = database.collection<MigrationDoc>("_migrations");
  const ran = await migrations.findOne({ key });
  if (ran) {
    return;
  }
  const orgs = database.collection<OrgDoc>("organizations");
  const allOrgs = await orgs.find({}).toArray();
  for (const org of allOrgs) {
    await ensureDefaultSpaceForOrg(database, org._id.toHexString(), org.ownerUserId);
  }
  await migrations.updateOne(
    { key },
    { $setOnInsert: { key, ranAt: new Date() } },
    { upsert: true },
  );
}

/**
 * Idempotent: returns the org's default-kind Space, creating it if missing.
 * Also ensures `ownerUserId` is enrolled as a Space Owner and that any
 * existing WPN docs owned by `ownerUserId` are stamped with the resolved
 * `(orgId, spaceId)`. Subsequent calls are cheap.
 */
export async function ensureDefaultSpaceForOrg(
  database: Db,
  orgIdHex: string,
  ownerUserIdHex: string,
): Promise<{ spaceId: string; created: boolean }> {
  const spaces = database.collection<SpaceDoc>("spaces");
  let spaceDoc = await spaces.findOne({ orgId: orgIdHex, kind: "default" });
  let created = false;
  if (!spaceDoc) {
    const ins = await spaces.insertOne({
      orgId: orgIdHex,
      name: "Default",
      kind: "default",
      createdByUserId: ownerUserIdHex,
      createdAt: new Date(),
    } as SpaceDoc);
    spaceDoc = (await spaces.findOne({ _id: ins.insertedId })) as SpaceDoc;
    created = true;
  }
  const spaceIdHex = spaceDoc._id.toHexString();
  const spaceMembers = database.collection<SpaceMembershipDoc>("space_memberships");
  await spaceMembers.updateOne(
    { spaceId: spaceIdHex, userId: ownerUserIdHex },
    {
      $setOnInsert: {
        spaceId: spaceIdHex,
        userId: ownerUserIdHex,
        role: "owner",
        addedByUserId: ownerUserIdHex,
        joinedAt: new Date(),
      },
    },
    { upsert: true },
  );
  await stampOrgSpaceOnLegacyWpnDocs(database, orgIdHex, spaceIdHex, ownerUserIdHex);
  return { spaceId: spaceIdHex, created };
}

/**
 * One-shot per (org, owner): set `orgId`/`spaceId` on existing WPN docs that
 * are still missing them. Cheap when nothing matches.
 */
async function stampOrgSpaceOnLegacyWpnDocs(
  database: Db,
  orgId: string,
  spaceId: string,
  userId: string,
): Promise<void> {
  const filter = { userId, orgId: { $exists: false } };
  const set = { $set: { orgId, spaceId } };
  await database.collection<WpnWorkspaceDoc>("wpn_workspaces").updateMany(filter, set);
  await database.collection<WpnProjectDoc>("wpn_projects").updateMany(filter, set);
  await database.collection<WpnNoteDoc>("wpn_notes").updateMany(filter, set);
  await database
    .collection<WpnExplorerStateDoc>("wpn_explorer_state")
    .updateMany(filter, set);
}

/**
 * Idempotent: if the user already has a `defaultOrgId`, returns the existing
 * Org. Otherwise creates an Org + admin membership and stamps the user.
 * Slug collisions are resolved by appending a random suffix.
 */
export async function ensureUserHasDefaultOrg(
  database: Db,
  userIdHex: string,
  email: string,
): Promise<{ orgId: string; created: boolean }> {
  const users = database.collection<UserDoc>("users");
  const userObjectId = new ObjectId(userIdHex);
  const existing = await users.findOne({ _id: userObjectId });
  if (existing && typeof existing.defaultOrgId === "string" && existing.defaultOrgId.length > 0) {
    return { orgId: existing.defaultOrgId, created: false };
  }
  const orgs = database.collection<OrgDoc>("organizations");
  const memberships = database.collection<OrgMembershipDoc>("org_memberships");
  const baseSlug = deriveSlugCandidate(email);
  let slug = baseSlug;
  for (let attempt = 0; attempt < 6; attempt++) {
    const exists = await orgs.findOne({ slug });
    if (!exists) {
      break;
    }
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const orgIns = await orgs.insertOne({
    name: `${email.split("@", 1)[0] ?? email}'s Org`,
    slug,
    ownerUserId: userIdHex,
    createdAt: new Date(),
  } as OrgDoc);
  const orgIdHex = orgIns.insertedId.toHexString();
  await memberships.insertOne({
    orgId: orgIdHex,
    userId: userIdHex,
    role: "admin",
    joinedAt: new Date(),
  } as OrgMembershipDoc);
  await users.updateOne(
    { _id: userObjectId },
    { $set: { defaultOrgId: orgIdHex } },
  );
  await ensureDefaultSpaceForOrg(database, orgIdHex, userIdHex);
  return { orgId: orgIdHex, created: true };
}

export function getNotesCollection(): Collection<SyncNoteDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<SyncNoteDoc>("notes");
}

export type RefreshSessionDoc = { jti: string; createdAt: Date };

export type UserDoc = {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  /** Legacy single-session field; migrated to `refreshSessions` on next login/refresh/MCP authorize. */
  activeRefreshJti?: string | null;
  /** Concurrent refresh token sessions (JTIs). */
  refreshSessions?: RefreshSessionDoc[] | null;
  /** Default Organization the user lands in after login (Phase 1: Org foundation). */
  defaultOrgId?: string | null;
  /** Most-recently-selected org; preserved across access-token refresh so reloads don't snap back to default. */
  lastActiveOrgId?: string | null;
  /** Most-recently-selected space (scoped to `lastActiveOrgId`); cleared when org changes. */
  lastActiveSpaceId?: string | null;
  /**
   * Per-org memory of the last space the user visited in each org. On `POST /orgs/active`
   * we prefer this over the org's default space so "switch away and come back" lands the
   * user where they left off. Keyed by orgId → spaceId.
   */
  lastActiveSpaceByOrg?: Record<string, string> | null;
  /** When set, the user was admin-created or admin-invited into this org and may not create new orgs. */
  lockedOrgId?: string | null;
  /**
   * Platform-wide master admin. Can create/demote other master admins and
   * create/promote org admins. Bootstrapped from `ARCHON_MASTER_ADMIN_EMAIL`
   * on first login. Always at least one master admin must remain on the system.
   */
  isMasterAdmin?: boolean | null;
  /** When true, login + refresh are rejected (soft account suspension). */
  disabled?: boolean | null;
  /** Optional human-friendly name displayed in UI; falls back to email local-part. */
  displayName?: string | null;
  /**
   * Set true for accounts created via admin invite that still need to choose
   * a password on first sign-in. Cleared by `/auth/accept-invite`.
   */
  mustSetPassword?: boolean | null;
};

export function getUsersCollection(): Collection {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection("users");
}

export function getWpnWorkspacesCollection(): Collection<WpnWorkspaceDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<WpnWorkspaceDoc>("wpn_workspaces");
}

export function getWpnProjectsCollection(): Collection<WpnProjectDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<WpnProjectDoc>("wpn_projects");
}

export function getWpnNotesCollection(): Collection<WpnNoteDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<WpnNoteDoc>("wpn_notes");
}

export function getWpnExplorerStateCollection(): Collection<WpnExplorerStateDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<WpnExplorerStateDoc>("wpn_explorer_state");
}

export function getUserPrefsCollection(): Collection<UserPrefsDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<UserPrefsDoc>("user_prefs");
}

export function getMcpDeviceSessionsCollection(): Collection<McpDeviceSessionDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<McpDeviceSessionDoc>("mcp_device_sessions");
}

export function getNotificationsCollection(): Collection<NotificationDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<NotificationDoc>("notifications");
}

export function getOrgsCollection(): Collection<OrgDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<OrgDoc>("organizations");
}

export function getOrgMembershipsCollection(): Collection<OrgMembershipDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<OrgMembershipDoc>("org_memberships");
}

export function getOrgInvitesCollection(): Collection<OrgInviteDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<OrgInviteDoc>("org_invites");
}

export function getSpacesCollection(): Collection<SpaceDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<SpaceDoc>("spaces");
}

/**
 * Read-only counterpart to `ensureDefaultSpaceForOrg`: returns the default
 * space id for an org, or `null` if none exists. Unlike `ensureDefaultSpaceForOrg`,
 * this does NOT create the space or enrol the caller as Space Owner — it is
 * safe to call for arbitrary org members looking up their active-org context
 * (org switch, invite accept, scope-resolution safety nets).
 */
export async function getDefaultSpaceIdForOrg(
  orgIdHex: string,
): Promise<string | null> {
  if (!/^[a-f0-9]{24}$/i.test(orgIdHex)) {
    return null;
  }
  const spaces = getSpacesCollection();
  const doc = await spaces.findOne({ orgId: orgIdHex, kind: "default" });
  return doc ? doc._id.toHexString() : null;
}

export function getSpaceMembershipsCollection(): Collection<SpaceMembershipDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<SpaceMembershipDoc>("space_memberships");
}

export function getTeamsCollection(): Collection<TeamDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<TeamDoc>("teams");
}

export function getTeamMembershipsCollection(): Collection<TeamMembershipDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<TeamMembershipDoc>("team_memberships");
}

export function getTeamSpaceGrantsCollection(): Collection<TeamSpaceGrantDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<TeamSpaceGrantDoc>("team_space_grants");
}

export function getWorkspaceSharesCollection(): Collection<WorkspaceShareDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<WorkspaceShareDoc>("workspace_shares");
}

export function getProjectSharesCollection(): Collection<ProjectShareDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<ProjectShareDoc>("project_shares");
}

export function getSpaceAnnouncementsCollection(): Collection<SpaceAnnouncementDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<SpaceAnnouncementDoc>("space_announcements");
}

export function getAuditEventsCollection(): Collection<AuditEventDoc> {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db.collection<AuditEventDoc>("audit_events");
}

export function getActiveDb(): Db {
  if (!db) {
    throw new Error("MongoDB not connected");
  }
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
