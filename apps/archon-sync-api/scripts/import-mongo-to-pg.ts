#!/usr/bin/env tsx
/**
 * One-shot Mongo→Postgres importer (Q1=B uniform UUIDs + Q2=a note_edges
 * backfill at import per the seed prompt rev 2).
 *
 * Source: a `mongodump` directory (default
 *   `mongodump-pre-cutover-20260425-162501/nodex_sync/`).
 * Destination: the Postgres database referenced by `DATABASE_URL`.
 *
 * Four passes:
 *   1. UUID minting — every ObjectId-keyed collection (users,
 *      organizations, memberships, audit_events, etc.) gets a fresh uuid;
 *      `legacy_object_id_map(scope, legacy_id, new_id)` is populated so
 *      pre-cutover JWTs and audit refs can be translated at the auth/MCP
 *      boundary.
 *   2. Translated insert per collection — every FK column known to
 *      reference an ObjectId-keyed entity is rewritten via the map;
 *      WPN-tree entities (workspaces/projects/notes/explorer) keep their
 *      source UUID `id`s and only translate their FK fields.
 *   3. note_edges backfill — every `wpn_notes` row is parsed for
 *      `[…](#/n/<id>)` references via the shared
 *      `collectReferencedNoteIdsFromMarkdown` helper. Resolved targets
 *      land as `(src, dst, kind='link')` rows. VFS-path links
 *      (`#/w/<vfsPath>`) are skipped — they need workspace/project/title
 *      resolution and are deferred to a follow-up.
 *   4. Parity check — for every (collection, table) pair, the post-import
 *      PG row count must equal the count of documents read from the BSON
 *      file. Non-match → `process.exit(1)` (and the CLI prints the diff).
 *
 * Idempotent: pass `--reset` to TRUNCATE every PG table before importing
 * (fresh state). Without `--reset`, re-running checks for an existing
 * non-empty schema and exits unless `--force`.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { BSON } from "bson";
import { ensurePgConnected, getDb, withTx, disconnectPg } from "../src/pg.js";
import * as schema from "../src/db/schema.js";
import { sql } from "drizzle-orm";

// ---------- collection→table map ----------

/**
 * Mongo collection name → drizzle table object + metadata for the importer.
 * `keyMode = "uuid"` means the source `_id` is already a UUID string and
 * passes through unchanged. `keyMode = "objectId"` triggers Pass-1 minting.
 * `keyMode = "composite"` means the source has no single PK and we use
 * (a, b) — only `_migrations` and `notes` (legacy 0-row) have this.
 */
type CollectionMap = {
  collection: string;
  table?: typeof schema.users;
  keyMode: "uuid" | "objectId" | "composite" | "skip";
  /**
   * Per-column FK manifest: column on the *PG* row (camel/snake via schema)
   * → scope name in `legacy_object_id_map` whose ObjectId hex is rewritten
   * to UUID. WPN-tree entities use the source-doc Mongo field name (e.g.
   * `creatorUserId`); `userId` is the column on every WPN row that maps
   * to `legacy_object_id_map.scope='users'`.
   */
  fks?: Record<string, string>;
  /** Map raw Mongo doc to PG insert row. */
  toRow: (
    doc: Record<string, unknown>,
    translate: (scope: string, legacyId: string) => string,
    newRowId?: string,
  ) => Record<string, unknown> | null;
};

function mapDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function objectIdHexFromAny(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return /^[0-9a-f]{24}$/i.test(v) ? v : null;
  // BSON ObjectId from the bson package has .toHexString().
  if (typeof v === "object" && "toHexString" in (v as object)) {
    try {
      const hex = (v as { toHexString: () => string }).toHexString();
      return /^[0-9a-f]{24}$/i.test(hex) ? hex : null;
    } catch {
      return null;
    }
  }
  return null;
}

const COLLECTIONS: CollectionMap[] = [
  // ObjectId-keyed entities — minted in Pass 1.
  {
    collection: "users",
    table: schema.users,
    keyMode: "objectId",
    fks: {},
    toRow: (d, _t, newId) => ({
      id: newId!,
      email: asString(d.email) ?? "",
      passwordHash: asString(d.passwordHash) ?? "",
      activeRefreshJti: asString(d.activeRefreshJti),
      refreshSessions: Array.isArray(d.refreshSessions)
        ? (d.refreshSessions as { jti?: string; createdAt?: Date }[]).map(
            (s) => ({
              jti: typeof s.jti === "string" ? s.jti : "",
              createdAt:
                s.createdAt instanceof Date
                  ? s.createdAt.toISOString()
                  : new Date(0).toISOString(),
            }),
          )
        : null,
      defaultOrgId: null, // resolved in Pass 2 via map
      lastActiveOrgId: null,
      lastActiveSpaceId: null,
      lastActiveSpaceByOrg: (d.lastActiveSpaceByOrg ??
        null) as Record<string, string> | null,
      lockedOrgId: null,
      isMasterAdmin: typeof d.isMasterAdmin === "boolean" ? d.isMasterAdmin : null,
      disabled: typeof d.disabled === "boolean" ? d.disabled : null,
      displayName: asString(d.displayName),
      mustSetPassword:
        typeof d.mustSetPassword === "boolean" ? d.mustSetPassword : null,
    }),
  },
  {
    collection: "organizations",
    table: schema.organizations,
    keyMode: "objectId",
    fks: { ownerUserId: "users" },
    toRow: (d, t, newId) => {
      const ownerLegacy = asString(d.ownerUserId);
      return {
        id: newId!,
        name: asString(d.name) ?? "",
        slug: asString(d.slug) ?? "",
        ownerUserId: ownerLegacy ? t("users", ownerLegacy) : "",
        createdAt: mapDate(d.createdAt) ?? new Date(0),
      };
    },
  },
  {
    collection: "org_memberships",
    table: schema.orgMemberships,
    keyMode: "objectId",
    fks: { orgId: "organizations", userId: "users" },
    toRow: (d, t) => ({
      orgId: t("organizations", asString(d.orgId) ?? ""),
      userId: t("users", asString(d.userId) ?? ""),
      role: asString(d.role) ?? "member",
      joinedAt: mapDate(d.joinedAt) ?? new Date(0),
    }),
  },
  {
    collection: "org_invites",
    table: schema.orgInvites,
    keyMode: "objectId",
    fks: {
      orgId: "organizations",
      invitedByUserId: "users",
      acceptedByUserId: "users",
      declinedByUserId: "users",
    },
    toRow: (d, t, newId) => {
      const orgIdLegacy = asString(d.orgId);
      const invitedByLegacy = asString(d.invitedByUserId);
      const acceptedByLegacy = asString(d.acceptedByUserId);
      const declinedByLegacy = asString(d.declinedByUserId);
      return {
        id: newId!,
        orgId: orgIdLegacy ? t("organizations", orgIdLegacy) : "",
        email: asString(d.email) ?? "",
        role: asString(d.role) ?? "member",
        tokenHash: asString(d.tokenHash) ?? "",
        status: asString(d.status) ?? "pending",
        invitedByUserId: invitedByLegacy ? t("users", invitedByLegacy) : "",
        createdAt: mapDate(d.createdAt) ?? new Date(0),
        expiresAt: mapDate(d.expiresAt) ?? new Date(0),
        acceptedAt: mapDate(d.acceptedAt),
        acceptedByUserId: acceptedByLegacy ? t("users", acceptedByLegacy) : null,
        declinedAt: mapDate(d.declinedAt),
        declinedByUserId: declinedByLegacy ? t("users", declinedByLegacy) : null,
        spaceGrants: (Array.isArray(d.spaceGrants) ? d.spaceGrants : null) as
          | { spaceId: string; role: string }[]
          | null,
      };
    },
  },
  {
    collection: "spaces",
    table: schema.spaces,
    keyMode: "objectId",
    fks: { orgId: "organizations", createdByUserId: "users", hiddenByUserId: "users" },
    toRow: (d, t, newId) => {
      const orgLegacy = asString(d.orgId);
      const creatorLegacy = asString(d.createdByUserId);
      const hiddenByLegacy = asString(d.hiddenByUserId);
      return {
        id: newId!,
        orgId: orgLegacy ? t("organizations", orgLegacy) : "",
        name: asString(d.name) ?? "",
        kind: asString(d.kind) ?? "normal",
        createdByUserId: creatorLegacy ? t("users", creatorLegacy) : "",
        createdAt: mapDate(d.createdAt) ?? new Date(0),
        hidden: typeof d.hidden === "boolean" ? d.hidden : null,
        hiddenAt: mapDate(d.hiddenAt),
        hiddenByUserId: hiddenByLegacy ? t("users", hiddenByLegacy) : null,
      };
    },
  },
  {
    collection: "space_memberships",
    table: schema.spaceMemberships,
    keyMode: "objectId",
    fks: { spaceId: "spaces", userId: "users", addedByUserId: "users" },
    toRow: (d, t) => {
      const addedByLegacy = asString(d.addedByUserId);
      return {
        spaceId: t("spaces", asString(d.spaceId) ?? ""),
        userId: t("users", asString(d.userId) ?? ""),
        role: asString(d.role) ?? "member",
        addedByUserId: addedByLegacy ? t("users", addedByLegacy) : "",
        joinedAt: mapDate(d.joinedAt) ?? new Date(0),
      };
    },
  },
  {
    collection: "space_announcements",
    table: schema.spaceAnnouncements,
    keyMode: "objectId",
    fks: { spaceId: "spaces", authorUserId: "users" },
    toRow: (d, t, newId) => ({
      id: newId!,
      spaceId: t("spaces", asString(d.spaceId) ?? ""),
      authorUserId: t("users", asString(d.authorUserId) ?? ""),
      title: asString(d.title) ?? "",
      contentMarkdown: asString(d.contentMarkdown) ?? "",
      pinned: typeof d.pinned === "boolean" ? d.pinned : false,
      createdAt: mapDate(d.createdAt) ?? new Date(0),
      updatedAt: mapDate(d.updatedAt) ?? new Date(0),
    }),
  },
  {
    collection: "teams",
    table: schema.teams,
    keyMode: "objectId",
    fks: { orgId: "organizations", createdByUserId: "users" },
    toRow: (d, t, newId) => ({
      id: newId!,
      orgId: t("organizations", asString(d.orgId) ?? ""),
      name: asString(d.name) ?? "",
      colorToken: asString(d.colorToken),
      createdByUserId: t("users", asString(d.createdByUserId) ?? ""),
      createdAt: mapDate(d.createdAt) ?? new Date(0),
    }),
  },
  {
    collection: "team_memberships",
    table: schema.teamMemberships,
    keyMode: "objectId",
    fks: { teamId: "teams", userId: "users", addedByUserId: "users" },
    toRow: (d, t) => ({
      teamId: t("teams", asString(d.teamId) ?? ""),
      userId: t("users", asString(d.userId) ?? ""),
      addedByUserId: t("users", asString(d.addedByUserId) ?? ""),
      joinedAt: mapDate(d.joinedAt) ?? new Date(0),
    }),
  },
  {
    collection: "team_space_grants",
    table: schema.teamSpaceGrants,
    keyMode: "objectId",
    fks: { teamId: "teams", spaceId: "spaces", grantedByUserId: "users" },
    toRow: (d, t) => ({
      teamId: t("teams", asString(d.teamId) ?? ""),
      spaceId: t("spaces", asString(d.spaceId) ?? ""),
      role: asString(d.role) ?? "member",
      grantedByUserId: t("users", asString(d.grantedByUserId) ?? ""),
      grantedAt: mapDate(d.grantedAt) ?? new Date(0),
    }),
  },
  {
    collection: "workspace_shares",
    table: schema.workspaceShares,
    keyMode: "objectId",
    fks: { userId: "users", addedByUserId: "users" },
    toRow: (d, t, newId) => ({
      id: newId!,
      workspaceId: asString(d.workspaceId) ?? "",
      userId: t("users", asString(d.userId) ?? ""),
      role: asString(d.role) ?? "reader",
      addedByUserId: t("users", asString(d.addedByUserId) ?? ""),
      addedAt: mapDate(d.addedAt) ?? new Date(0),
    }),
  },
  {
    collection: "project_shares",
    table: schema.projectShares,
    keyMode: "objectId",
    fks: { userId: "users", addedByUserId: "users" },
    toRow: (d, t, newId) => ({
      id: newId!,
      projectId: asString(d.projectId) ?? "",
      userId: t("users", asString(d.userId) ?? ""),
      role: asString(d.role) ?? "reader",
      addedByUserId: t("users", asString(d.addedByUserId) ?? ""),
      addedAt: mapDate(d.addedAt) ?? new Date(0),
    }),
  },
  {
    collection: "audit_events",
    table: schema.auditEvents,
    keyMode: "objectId",
    fks: { orgId: "organizations", actorUserId: "users" },
    toRow: (d, t, newId) => ({
      id: newId!,
      orgId: t("organizations", asString(d.orgId) ?? ""),
      actorUserId: t("users", asString(d.actorUserId) ?? ""),
      action: asString(d.action) ?? "",
      targetType: asString(d.targetType) ?? "",
      targetId: asString(d.targetId) ?? "",
      metadata: (d.metadata ?? null) as Record<string, unknown> | null,
      ts: mapDate(d.ts) ?? new Date(0),
    }),
  },
  {
    collection: "user_prefs",
    table: schema.userPrefs,
    keyMode: "skip", // userId-keyed natural; populated in Pass 2 after users land
    fks: { userId: "users" },
    toRow: (d, t) => ({
      userId: t("users", asString(d.userId) ?? ""),
      shellLayout: d.shellLayout ?? null,
      updatedAtMs: asNumber(d.updatedAtMs) ?? 0,
    }),
  },
  {
    collection: "notifications",
    table: schema.notifications,
    keyMode: "objectId",
    fks: { userId: "users" },
    toRow: (d, t, newId) => ({
      id: newId!,
      userId: t("users", asString(d.userId) ?? ""),
      type: asString(d.type) ?? "",
      // payload is NOT NULL in the schema; coerce missing to {} to import
      // legacy rows that predate the field.
      payload:
        (d.payload && typeof d.payload === "object"
          ? (d.payload as Record<string, unknown>)
          : {}) as Record<string, unknown>,
      link: asString(d.link) ?? "",
      status: asString(d.status) ?? "unread",
      createdAt: mapDate(d.createdAt) ?? new Date(0),
      readAt: mapDate(d.readAt),
      consumedAt: mapDate(d.consumedAt),
      dismissedAt: mapDate(d.dismissedAt),
      dedupeKey: asString(d.dedupeKey),
    }),
  },
  {
    collection: "mcp_device_sessions",
    table: schema.mcpDeviceSessions,
    keyMode: "objectId",
    fks: { boundUserId: "users" },
    toRow: (d, t, newId) => {
      const boundLegacy = asString(d.boundUserId);
      return {
        id: newId!,
        userCode: asString(d.userCode) ?? "",
        deviceCodeHash: asString(d.deviceCodeHash) ?? "",
        status: asString(d.status) ?? "awaiting_user",
        clientIp: asString(d.clientIp) ?? "0.0.0.0",
        createdAt: mapDate(d.createdAt) ?? new Date(0),
        expiresAt: mapDate(d.expiresAt) ?? new Date(0),
        boundUserId: boundLegacy ? t("users", boundLegacy) : null,
        issuedAccessToken: asString(d.issuedAccessToken),
        issuedRefreshToken: asString(d.issuedRefreshToken),
      };
    },
  },
  // WPN-tree entities — already UUID-keyed.
  {
    collection: "wpn_workspaces",
    table: schema.wpnWorkspaces,
    keyMode: "uuid",
    fks: {
      userId: "users",
      orgId: "organizations",
      spaceId: "spaces",
      creatorUserId: "users",
    },
    toRow: (d, t) => ({
      id: asString(d.id) ?? "",
      userId: t("users", asString(d.userId) ?? ""),
      orgId: asString(d.orgId) ? t("organizations", asString(d.orgId)!) : null,
      spaceId: asString(d.spaceId) ? t("spaces", asString(d.spaceId)!) : null,
      visibility: asString(d.visibility),
      creatorUserId: asString(d.creatorUserId)
        ? t("users", asString(d.creatorUserId)!)
        : null,
      name: asString(d.name) ?? "",
      sort_index: asNumber(d.sort_index) ?? 0,
      color_token: asString(d.color_token),
      created_at_ms: asNumber(d.created_at_ms) ?? 0,
      updated_at_ms: asNumber(d.updated_at_ms) ?? 0,
      settings: (d.settings ?? null) as Record<string, unknown> | null,
    }),
  },
  {
    collection: "wpn_projects",
    table: schema.wpnProjects,
    keyMode: "uuid",
    fks: {
      userId: "users",
      orgId: "organizations",
      spaceId: "spaces",
      creatorUserId: "users",
    },
    toRow: (d, t) => ({
      id: asString(d.id) ?? "",
      userId: t("users", asString(d.userId) ?? ""),
      orgId: asString(d.orgId) ? t("organizations", asString(d.orgId)!) : null,
      spaceId: asString(d.spaceId) ? t("spaces", asString(d.spaceId)!) : null,
      workspace_id: asString(d.workspace_id) ?? "",
      visibility: asString(d.visibility),
      creatorUserId: asString(d.creatorUserId)
        ? t("users", asString(d.creatorUserId)!)
        : null,
      name: asString(d.name) ?? "",
      sort_index: asNumber(d.sort_index) ?? 0,
      color_token: asString(d.color_token),
      created_at_ms: asNumber(d.created_at_ms) ?? 0,
      updated_at_ms: asNumber(d.updated_at_ms) ?? 0,
      settings: (d.settings ?? null) as Record<string, unknown> | null,
    }),
  },
  {
    collection: "wpn_notes",
    table: schema.wpnNotes,
    keyMode: "uuid",
    fks: {
      userId: "users",
      orgId: "organizations",
      spaceId: "spaces",
      created_by_user_id: "users",
      updated_by_user_id: "users",
    },
    toRow: (d, t) => ({
      id: asString(d.id) ?? "",
      userId: t("users", asString(d.userId) ?? ""),
      orgId: asString(d.orgId) ? t("organizations", asString(d.orgId)!) : null,
      spaceId: asString(d.spaceId) ? t("spaces", asString(d.spaceId)!) : null,
      created_by_user_id: asString(d.created_by_user_id)
        ? t("users", asString(d.created_by_user_id)!)
        : null,
      updated_by_user_id: asString(d.updated_by_user_id)
        ? t("users", asString(d.updated_by_user_id)!)
        : null,
      project_id: asString(d.project_id) ?? "",
      parent_id: asString(d.parent_id),
      type: asString(d.type) ?? "markdown",
      title: asString(d.title) ?? "",
      content: asString(d.content) ?? "",
      metadata: (d.metadata ?? null) as Record<string, unknown> | null,
      sibling_index: asNumber(d.sibling_index) ?? 0,
      created_at_ms: asNumber(d.created_at_ms) ?? 0,
      updated_at_ms: asNumber(d.updated_at_ms) ?? 0,
      deleted: typeof d.deleted === "boolean" ? d.deleted : null,
    }),
  },
  {
    collection: "wpn_explorer_state",
    table: schema.wpnExplorerState,
    keyMode: "skip", // composite (userId, project_id); both already known
    fks: { userId: "users", orgId: "organizations", spaceId: "spaces" },
    toRow: (d, t) => ({
      userId: t("users", asString(d.userId) ?? ""),
      orgId: asString(d.orgId) ? t("organizations", asString(d.orgId)!) : null,
      spaceId: asString(d.spaceId) ? t("spaces", asString(d.spaceId)!) : null,
      project_id: asString(d.project_id) ?? "",
      expanded_ids: Array.isArray(d.expanded_ids) ? (d.expanded_ids as string[]) : [],
    }),
  },
  // mdx-state — keep projectId source-shape (likely already UUID).
  {
    collection: "mdx_state_head",
    table: schema.mdxStateHead,
    keyMode: "skip",
    fks: {},
    toRow: (d, t) => {
      const updatedBy =
        d.updatedBy && typeof d.updatedBy === "object"
          ? (d.updatedBy as Record<string, unknown>)
          : null;
      const legacyUserId = updatedBy ? asString(updatedBy.userId) : null;
      return {
        projectId: asString(d.projectId) ?? "",
        key: asString(d.key) ?? "",
        mode: asString(d.mode) ?? "inline",
        value: d.value ?? null,
        totalChunks: asNumber(d.totalChunks),
        totalBytes: asNumber(d.totalBytes) ?? 0,
        version: asNumber(d.version) ?? 0,
        updatedAt: mapDate(d.updatedAt) ?? new Date(0),
        // updatedByUserId in the Mongo doc is the user's ObjectId hex —
        // translate to the new uuid like every other FK.
        updatedByUserId: legacyUserId ? t("users", legacyUserId) : "",
        updatedByEmail: updatedBy ? asString(updatedBy.email) ?? "" : "",
      };
    },
  },
  // Skipped collections — _migrations retires under drizzle ownership;
  // notes (legacy) has 0 rows in the dump; mdx_state_chunks/cursors are
  // 0-row in the dump too.
  { collection: "_migrations", keyMode: "skip", toRow: () => null },
  { collection: "notes", keyMode: "skip", toRow: () => null },
  { collection: "mdx_state_chunks", keyMode: "skip", toRow: () => null },
  { collection: "mdx_state_ws_cursors", keyMode: "skip", toRow: () => null },
];

// ---------- BSON parsing ----------

/** Read a BSON file and decode every document. */
async function readBsonDocs(filePath: string): Promise<Record<string, unknown>[]> {
  const buf = await fs.readFile(filePath);
  const docs: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const docSize = buf.readInt32LE(offset);
    if (docSize <= 0 || offset + docSize > buf.length) break;
    const slice = buf.subarray(offset, offset + docSize);
    docs.push(BSON.deserialize(slice) as Record<string, unknown>);
    offset += docSize;
  }
  return docs;
}

// ---------- runImporter (testable entry point) ----------

export interface RunImporterOptions {
  dumpDir: string;
  reset?: boolean;
  force?: boolean;
  /** When false, suppresses the importer's stdout chatter. Defaults to true. */
  verbose?: boolean;
}

export interface RunImporterResult {
  /** Per-collection BSON-doc counts read from the dump. */
  sourceCounts: Map<string, number>;
  /** Per-collection parity diff (only present for collections with a PG table). */
  parity: { collection: string; expected: number; actual: number; ok: boolean }[];
  /** True iff every collection's parity check passed. */
  parityOk: boolean;
  /** Number of note_edges rows inserted in Pass 3. */
  edgeCount: number;
}

/**
 * Test/programmatic entry point. Mirrors the CLI but returns a structured
 * result instead of calling process.exit, and never disconnects the pool —
 * caller is responsible for that.
 */
export async function runImporter(
  opts: RunImporterOptions,
): Promise<RunImporterResult> {
  const { dumpDir, reset = false, force = false, verbose = true } = opts;
  const log = (msg: string): void => {
    if (verbose) console.log(msg);
  };
  const warn = (msg: string): void => {
    if (verbose) console.warn(msg);
  };

  log(`[importer] source: ${dumpDir}`);
  await ensurePgConnected();
  const db = getDb();

  // Pre-flight: detect non-empty schema and bail unless reset/force.
  const userCountRow = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text as n FROM users`,
  );
  const userCountList =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (userCountRow as any).rows ?? userCountRow;
  const existing = Number(
    (userCountList as { n: string }[])[0]?.n ?? "0",
  );
  if (existing > 0 && !reset && !force) {
    throw new Error(
      `[importer] users table has ${existing} rows. Pass reset=true to TRUNCATE or force=true to overlay.`,
    );
  }

  if (reset) {
    log("[importer] reset: truncating all PG tables…");
    await db.execute(sql`TRUNCATE TABLE
      legacy_object_id_map,
      audit_events, notifications, user_prefs,
      mcp_device_sessions,
      mdx_state_ws_cursors, mdx_state_chunks, mdx_state_head,
      note_edges, wpn_explorer_state, wpn_notes, wpn_projects, wpn_workspaces,
      project_shares, workspace_shares,
      team_space_grants, team_memberships, teams,
      space_announcements, space_memberships, spaces,
      org_invites, org_memberships, organizations,
      users, notes
      RESTART IDENTITY CASCADE`);
  }

  // Pass 1: UUID minting + legacy_object_id_map.
  log("[importer] Pass 1 — UUID minting…");
  const idMap = new Map<string, string>(); // key=`scope:legacyHex` value=uuid
  function mapKey(scope: string, legacyId: string): string {
    return `${scope}:${legacyId}`;
  }
  const sourceCounts = new Map<string, number>();

  for (const cfg of COLLECTIONS) {
    const file = path.join(dumpDir, `${cfg.collection}.bson`);
    let docs: Record<string, unknown>[] = [];
    try {
      docs = await readBsonDocs(file);
    } catch {
      log(`[importer] skip ${cfg.collection} (no BSON file)`);
      sourceCounts.set(cfg.collection, 0);
      continue;
    }
    sourceCounts.set(cfg.collection, docs.length);
    if (cfg.keyMode !== "objectId") continue;
    const mintRows: { scope: string; legacyId: string; newId: string }[] = [];
    for (const d of docs) {
      const legacy = objectIdHexFromAny(d._id);
      if (!legacy) continue;
      const newId = randomUUID();
      idMap.set(mapKey(cfg.collection, legacy), newId);
      mintRows.push({
        scope: cfg.collection,
        legacyId: legacy,
        newId,
      });
    }
    if (mintRows.length > 0) {
      await db
        .insert(schema.legacyObjectIdMap)
        .values(mintRows)
        .onConflictDoNothing();
    }
    log(`[importer]   minted ${mintRows.length} uuid for ${cfg.collection}`);
  }

  // Pass 1.5 — synthesize placeholder users for orphan references.
  // The dump may carry dangling references to users that were deleted before
  // cutover (rare but real: 9 rows in the production dump pointed at a
  // missing user). Preserving those rows requires the FK to resolve, so we
  // mint a placeholder user per orphan and add it to legacy_object_id_map +
  // insert a minimal users row.
  log("[importer] Pass 1.5 — orphan placeholder synthesis…");
  const userOrphans = new Set<string>();
  for (const cfg of COLLECTIONS) {
    if (!cfg.fks) continue;
    const userFkColumns = Object.entries(cfg.fks)
      .filter(([, scope]) => scope === "users")
      .map(([col]) => col);
    if (userFkColumns.length === 0) continue;
    const file = path.join(dumpDir, `${cfg.collection}.bson`);
    let docs: Record<string, unknown>[] = [];
    try {
      docs = await readBsonDocs(file);
    } catch {
      continue;
    }
    for (const d of docs) {
      for (const col of userFkColumns) {
        const refs: unknown[] = [];
        // Some FKs are nested (mdx_state_head.updatedBy.userId).
        if (col === "userId" || col === "updated_by_user_id" || col === "created_by_user_id") {
          refs.push(d[col]);
        } else {
          refs.push(d[col]);
        }
        for (const v of refs) {
          const hex = asString(v);
          if (!hex || !/^[0-9a-f]{24}$/.test(hex)) continue;
          if (idMap.has(mapKey("users", hex))) continue;
          userOrphans.add(hex);
        }
      }
    }
    // Special case: mdx_state_head.updatedBy.userId is nested.
    if (cfg.collection === "mdx_state_head") {
      for (const d of docs) {
        const updatedBy =
          d.updatedBy && typeof d.updatedBy === "object"
            ? (d.updatedBy as Record<string, unknown>)
            : null;
        if (!updatedBy) continue;
        const hex = asString(updatedBy.userId);
        if (!hex || !/^[0-9a-f]{24}$/.test(hex)) continue;
        if (idMap.has(mapKey("users", hex))) continue;
        userOrphans.add(hex);
      }
    }
  }
  if (userOrphans.size > 0) {
    log(`[importer]   synthesizing ${userOrphans.size} placeholder user(s)`);
    const mintRows: { scope: string; legacyId: string; newId: string }[] = [];
    const userInsertRows: { id: string; email: string; passwordHash: string }[] = [];
    for (const hex of userOrphans) {
      const newId = randomUUID();
      idMap.set(mapKey("users", hex), newId);
      mintRows.push({ scope: "users", legacyId: hex, newId });
      userInsertRows.push({
        id: newId,
        email: `deleted-user-${hex}@archon.deleted`,
        passwordHash: "$2a$10$placeholder-for-deleted-user-............",
      });
    }
    await db.insert(schema.legacyObjectIdMap).values(mintRows).onConflictDoNothing();
    await db.insert(schema.users).values(userInsertRows).onConflictDoNothing();
    sourceCounts.set(
      "users",
      (sourceCounts.get("users") ?? 0) + userOrphans.size,
    );
  }

  // Pass 2: translated insert per collection.
  log("[importer] Pass 2 — translated inserts…");
  function translate(scope: string, legacyId: string): string {
    if (!legacyId) return "";
    const hit = idMap.get(mapKey(scope, legacyId));
    if (!hit) {
      throw new Error(
        `legacy id not in map: scope=${scope} id=${legacyId} (corrupt dump or missing source row?)`,
      );
    }
    return hit;
  }

  for (const cfg of COLLECTIONS) {
    if (!cfg.table) continue;
    const file = path.join(dumpDir, `${cfg.collection}.bson`);
    let docs: Record<string, unknown>[] = [];
    try {
      docs = await readBsonDocs(file);
    } catch {
      continue;
    }
    if (docs.length === 0) continue;
    const rowsToInsert: Record<string, unknown>[] = [];
    for (const d of docs) {
      let newRowId: string | undefined;
      if (cfg.keyMode === "objectId") {
        const legacy = objectIdHexFromAny(d._id);
        if (!legacy) continue;
        newRowId = idMap.get(mapKey(cfg.collection, legacy))!;
      }
      try {
        const row = cfg.toRow(d, translate, newRowId);
        if (row) rowsToInsert.push(row);
      } catch (err) {
        warn(
          `[importer]   skipped row in ${cfg.collection}: ${(err as Error).message}`,
        );
      }
    }
    if (rowsToInsert.length === 0) continue;
    // Batch in 500-row chunks for safety.
    const chunkSize = 500;
    for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
      const slice = rowsToInsert.slice(i, i + chunkSize);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.insert(cfg.table as any).values(slice as any);
    }
    log(
      `[importer]   inserted ${rowsToInsert.length}/${docs.length} into ${cfg.collection}`,
    );
  }

  // Resolve users.defaultOrgId / lockedOrgId / lastActiveOrgId / lastActiveSpaceId
  // (deferred from Pass 2 because the org/space rows had to land first).
  log("[importer] Pass 2.5 — resolve user pointers…");
  const userDocs = await readBsonDocs(path.join(dumpDir, "users.bson")).catch(
    () => [] as Record<string, unknown>[],
  );
  for (const d of userDocs) {
    const legacy = objectIdHexFromAny(d._id);
    if (!legacy) continue;
    const newUserId = idMap.get(mapKey("users", legacy));
    if (!newUserId) continue;
    const set: Record<string, unknown> = {};
    const def = asString(d.defaultOrgId);
    if (def) {
      const m = idMap.get(mapKey("organizations", def));
      if (m) set.defaultOrgId = m;
    }
    const locked = asString(d.lockedOrgId);
    if (locked) {
      const m = idMap.get(mapKey("organizations", locked));
      if (m) set.lockedOrgId = m;
    }
    const lastOrg = asString(d.lastActiveOrgId);
    if (lastOrg) {
      const m = idMap.get(mapKey("organizations", lastOrg));
      if (m) set.lastActiveOrgId = m;
    }
    const lastSpace = asString(d.lastActiveSpaceId);
    if (lastSpace) {
      const m = idMap.get(mapKey("spaces", lastSpace));
      if (m) set.lastActiveSpaceId = m;
    }
    if (
      d.lastActiveSpaceByOrg &&
      typeof d.lastActiveSpaceByOrg === "object" &&
      !Array.isArray(d.lastActiveSpaceByOrg)
    ) {
      const translated: Record<string, string> = {};
      for (const [orgKey, spaceVal] of Object.entries(
        d.lastActiveSpaceByOrg as Record<string, unknown>,
      )) {
        const orgUuid = idMap.get(mapKey("organizations", orgKey));
        const spaceUuid =
          typeof spaceVal === "string"
            ? idMap.get(mapKey("spaces", spaceVal)) ?? null
            : null;
        if (orgUuid && spaceUuid) translated[orgUuid] = spaceUuid;
      }
      if (Object.keys(translated).length > 0) set.lastActiveSpaceByOrg = translated;
    }
    if (Object.keys(set).length === 0) continue;
    await db.execute(
      sql`UPDATE users SET
        ${sql.raw(
          Object.keys(set)
            .map((k) => {
              const col =
                k === "defaultOrgId"
                  ? "default_org_id"
                  : k === "lockedOrgId"
                    ? "locked_org_id"
                    : k === "lastActiveOrgId"
                      ? "last_active_org_id"
                      : k === "lastActiveSpaceId"
                        ? "last_active_space_id"
                        : "last_active_space_by_org";
              return `${col} = ${
                k === "lastActiveSpaceByOrg"
                  ? `'${JSON.stringify(set[k]).replace(/'/g, "''")}'::jsonb`
                  : `'${(set[k] as string).replace(/'/g, "''")}'`
              }`;
            })
            .join(", "),
        )}
      WHERE id = ${newUserId}::uuid`,
    );
  }

  // Pass 3: note_edges backfill from wpn_notes.content markdown.
  log("[importer] Pass 3 — note_edges backfill…");
  const noteIds = new Set<string>();
  const wpnNotesDocs = await readBsonDocs(
    path.join(dumpDir, "wpn_notes.bson"),
  ).catch(() => [] as Record<string, unknown>[]);
  for (const d of wpnNotesDocs) {
    const id = asString(d.id);
    if (id) noteIds.add(id);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sharedLib = (await import(
    "../../../src/shared/markdown-internal-note-href.js" as any
  )) as {
    collectReferencedNoteIdsFromMarkdown: (text: string) => Set<string>;
  };
  let edgeCount = 0;
  for (const d of wpnNotesDocs) {
    const id = asString(d.id);
    const content = asString(d.content) ?? "";
    if (!id || content.length === 0) continue;
    const refs = sharedLib.collectReferencedNoteIdsFromMarkdown(content);
    if (refs.size === 0) continue;
    const rows: { src: string; dst: string; kind: string }[] = [];
    for (const dst of refs) {
      if (dst === id) continue;
      if (!noteIds.has(dst)) continue;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          dst,
        )
      ) {
        continue;
      }
      rows.push({ src: id, dst, kind: "link" });
    }
    if (rows.length > 0) {
      await db.insert(schema.noteEdges).values(rows).onConflictDoNothing();
      edgeCount += rows.length;
    }
  }
  log(`[importer]   inserted ${edgeCount} note_edges rows`);

  // Pass 4: parity check.
  log("[importer] Pass 4 — parity check…");
  const parity: RunImporterResult["parity"] = [];
  for (const cfg of COLLECTIONS) {
    if (!cfg.table) continue;
    const expected = sourceCounts.get(cfg.collection) ?? 0;
    const result = await db.execute<{ n: string }>(
      sql.raw(`SELECT count(*)::text AS n FROM "${cfg.collection}"`),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (result as any).rows ?? result;
    const actual = Number((list as { n: string }[])[0]?.n ?? "0");
    const ok = expected === actual;
    parity.push({ collection: cfg.collection, expected, actual, ok });
    log(
      `[importer]   ${cfg.collection.padEnd(28)} expected=${expected.toString().padStart(5)} actual=${actual.toString().padStart(5)} ${ok ? "✓" : "✗"}`,
    );
  }
  const parityOk = parity.every((p) => p.ok);

  if (!parityOk && verbose) {
    console.error("[importer] parity check FAILED.");
  }

  return { sourceCounts, parity, parityOk, edgeCount };
}

// ---------- CLI driver ----------

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const dumpDir =
    args.find((a) => !a.startsWith("--")) ??
    path.resolve(
      process.cwd(),
      "mongodump-pre-cutover-20260425-162501/nodex_sync",
    );
  const reset = args.includes("--reset");
  const force = args.includes("--force");
  let result: RunImporterResult | null = null;
  try {
    result = await runImporter({ dumpDir, reset, force, verbose: true });
  } catch (err) {
    console.error("[importer] fatal:", err);
    try {
      await disconnectPg();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
  await disconnectPg();
  if (!result.parityOk) process.exit(1);
  console.log("[importer] done.");
}

// Only run as a CLI when invoked directly (skip when imported by tests).
const isCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /\bimport-mongo-to-pg\.[mc]?[jt]s$/.test(process.argv[1]);
if (isCli) {
  void cli();
}
