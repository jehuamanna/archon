/**
 * Importer test (item 24): exercises runImporter against an in-memory
 * BSON fixture written to a tmp directory.
 *
 * Coverage:
 *   - UUID minting + legacy_object_id_map population (Pass 1).
 *   - FK translation across collections (Pass 2): wpn_workspaces.
 *     creatorUserId points at the new UUID for the legacy hex.
 *   - User-pointer resolution (Pass 2.5): users.defaultOrgId / lockedOrgId
 *     are translated to the new org UUID.
 *   - note_edges backfill (Pass 3): markdown #/n/<uuid> cross-links land
 *     as (src, dst, kind='link') rows.
 *   - Parity check passes when counts match.
 *   - Parity check fails when an artificial mismatch is introduced.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BSON } from "bson";
import { eq } from "drizzle-orm";
import "../src/load-root-env.js";
import { ensurePgConnected, getDb } from "../src/pg.js";
import {
  legacyObjectIdMap,
  noteEdges,
  organizations,
  spaceMemberships,
  spaces,
  users,
  wpnNotes,
  wpnProjects,
  wpnWorkspaces,
} from "../src/db/schema.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "../src/test-pg-helper.js";
import { runImporter } from "./import-mongo-to-pg.js";

/** Generate a 24-char ObjectId-shaped lowercase hex string. */
function fakeObjectIdHex(): string {
  return randomBytes(12).toString("hex");
}

interface FixturePlan {
  user1Id: string;
  user2Id: string;
  org1Id: string;
  space1Id: string;
  workspaceId: string;
  projectId: string;
  note1Id: string;
  note2Id: string;
}

/**
 * Write a tiny mongodump-shaped directory tree to a tmp folder and return
 * its path + the legacy ObjectId hex strings the importer will translate.
 */
async function buildFixture(): Promise<{ dumpDir: string; ids: FixturePlan }> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "archon-importer-"));
  const dumpDir = path.join(tmpRoot, "fixture");
  await fs.mkdir(dumpDir, { recursive: true });

  const ids: FixturePlan = {
    user1Id: fakeObjectIdHex(),
    user2Id: fakeObjectIdHex(),
    org1Id: fakeObjectIdHex(),
    space1Id: fakeObjectIdHex(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    note1Id: randomUUID(),
    note2Id: randomUUID(),
  };

  const writeBson = async (
    name: string,
    docs: Record<string, unknown>[],
  ): Promise<void> => {
    const buffers = docs.map((d) => Buffer.from(BSON.serialize(d)));
    const merged = Buffer.concat(buffers);
    await fs.writeFile(path.join(dumpDir, `${name}.bson`), merged);
  };

  // Helper to construct a BSON ObjectId-shaped binary value via BSON's API.
  // bson.ObjectId.createFromHexString gives us back an ObjectId instance that
  // serializes round-trip as a 12-byte BSON ObjectId.
  const objId = (hex: string): unknown =>
    BSON.ObjectId.createFromHexString(hex);

  // users
  await writeBson("users", [
    {
      _id: objId(ids.user1Id),
      email: "alice@fixture.test",
      passwordHash: "$2a$10$placeholder.alice",
      defaultOrgId: ids.org1Id,
      lockedOrgId: ids.org1Id,
    },
    {
      _id: objId(ids.user2Id),
      email: "bob@fixture.test",
      passwordHash: "$2a$10$placeholder.bob",
    },
  ]);

  // organizations
  await writeBson("organizations", [
    {
      _id: objId(ids.org1Id),
      name: "Fixture Org",
      slug: `fixture-${randomBytes(3).toString("hex")}`,
      ownerUserId: ids.user1Id,
      createdAt: new Date(),
    },
  ]);

  // org_memberships
  await writeBson("org_memberships", [
    {
      _id: objId(fakeObjectIdHex()),
      orgId: ids.org1Id,
      userId: ids.user1Id,
      role: "admin",
      joinedAt: new Date(),
    },
    {
      _id: objId(fakeObjectIdHex()),
      orgId: ids.org1Id,
      userId: ids.user2Id,
      role: "member",
      joinedAt: new Date(),
    },
  ]);

  // spaces
  await writeBson("spaces", [
    {
      _id: objId(ids.space1Id),
      orgId: ids.org1Id,
      name: "Default",
      kind: "default",
      createdByUserId: ids.user1Id,
      createdAt: new Date(),
    },
  ]);

  // space_memberships
  await writeBson("space_memberships", [
    {
      _id: objId(fakeObjectIdHex()),
      spaceId: ids.space1Id,
      userId: ids.user1Id,
      role: "owner",
      addedByUserId: ids.user1Id,
      joinedAt: new Date(),
    },
  ]);

  // wpn_workspaces (already-uuid id, FKs reference legacy hex strings)
  await writeBson("wpn_workspaces", [
    {
      id: ids.workspaceId,
      userId: ids.user1Id,
      orgId: ids.org1Id,
      spaceId: ids.space1Id,
      visibility: "public",
      creatorUserId: ids.user1Id,
      name: "Fixture WS",
      sort_index: 0,
      color_token: null,
      created_at_ms: 1700000000000,
      updated_at_ms: 1700000000000,
      settings: {},
    },
  ]);

  // wpn_projects
  await writeBson("wpn_projects", [
    {
      id: ids.projectId,
      userId: ids.user1Id,
      orgId: ids.org1Id,
      spaceId: ids.space1Id,
      workspace_id: ids.workspaceId,
      visibility: "public",
      creatorUserId: ids.user1Id,
      name: "Fixture Project",
      sort_index: 0,
      color_token: null,
      created_at_ms: 1700000000000,
      updated_at_ms: 1700000000000,
      settings: {},
    },
  ]);

  // wpn_notes — note1 references note2 via #/n/<uuid> markdown link
  await writeBson("wpn_notes", [
    {
      id: ids.note1Id,
      userId: ids.user1Id,
      orgId: ids.org1Id,
      spaceId: ids.space1Id,
      created_by_user_id: ids.user1Id,
      updated_by_user_id: ids.user1Id,
      project_id: ids.projectId,
      parent_id: null,
      type: "markdown",
      title: "Note One",
      content: `See [the other](#/n/${ids.note2Id})`,
      metadata: null,
      sibling_index: 0,
      created_at_ms: 1700000000000,
      updated_at_ms: 1700000000000,
    },
    {
      id: ids.note2Id,
      userId: ids.user1Id,
      orgId: ids.org1Id,
      spaceId: ids.space1Id,
      created_by_user_id: ids.user1Id,
      updated_by_user_id: ids.user1Id,
      project_id: ids.projectId,
      parent_id: null,
      type: "markdown",
      title: "Note Two",
      content: "Hello",
      metadata: null,
      sibling_index: 1,
      created_at_ms: 1700000000000,
      updated_at_ms: 1700000000000,
    },
  ]);

  return { dumpDir, ids };
}

describe("import-mongo-to-pg (item 24)", () => {
  test(
    "runImporter end-to-end: mints UUIDs, translates FKs, backfills note_edges, parity OK",
    { timeout: 30_000 },
    async (t) => {
      let ctx: TestPgSchemaContext | undefined;
      try {
        ctx = await setupPgTestSchema();
      } catch (err) {
        t.skip(`Postgres not reachable: ${String(err)}`);
        return;
      }
      try {
        await ensurePgConnected();
        const { dumpDir, ids } = await buildFixture();

        const result = await runImporter({
          dumpDir,
          reset: false,
          force: true, // schema is empty; force allows the importer to overlay
          verbose: false,
        });

        // Pass 1 — legacy_object_id_map populated for ObjectId-keyed scopes.
        const userMapRows = await getDb()
          .select()
          .from(legacyObjectIdMap)
          .where(eq(legacyObjectIdMap.scope, "users"));
        assert.equal(userMapRows.length, 2, "two users mapped");
        const user1Mapping = userMapRows.find((r) => r.legacyId === ids.user1Id);
        assert.ok(user1Mapping, "user1 mapped");
        assert.match(
          user1Mapping!.newId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          "user1 newId is a uuid",
        );

        const orgMapRows = await getDb()
          .select()
          .from(legacyObjectIdMap)
          .where(eq(legacyObjectIdMap.scope, "organizations"));
        assert.equal(orgMapRows.length, 1, "one org mapped");
        const org1Mapping = orgMapRows[0]!;

        // Pass 2 — wpn_workspaces.creatorUserId is the translated UUID.
        const wsRows = await getDb()
          .select()
          .from(wpnWorkspaces)
          .where(eq(wpnWorkspaces.id, ids.workspaceId));
        assert.equal(wsRows.length, 1);
        assert.equal(
          wsRows[0]!.creatorUserId,
          user1Mapping!.newId,
          "creatorUserId translated to new uuid",
        );
        assert.equal(
          wsRows[0]!.orgId,
          org1Mapping.newId,
          "orgId translated to new uuid",
        );
        assert.equal(wsRows[0]!.id, ids.workspaceId, "uuid id preserved");

        // Pass 2.5 — user.defaultOrgId / lockedOrgId resolved.
        const userRows = await getDb()
          .select()
          .from(users)
          .where(eq(users.id, user1Mapping!.newId));
        assert.equal(userRows.length, 1);
        assert.equal(
          userRows[0]!.defaultOrgId,
          org1Mapping.newId,
          "defaultOrgId resolved",
        );
        assert.equal(
          userRows[0]!.lockedOrgId,
          org1Mapping.newId,
          "lockedOrgId resolved",
        );

        // Spaces + memberships translated
        const spaceRows = await getDb().select().from(spaces);
        assert.equal(spaceRows.length, 1);
        assert.equal(spaceRows[0]!.orgId, org1Mapping.newId);
        const sm = await getDb().select().from(spaceMemberships);
        assert.equal(sm.length, 1);
        assert.equal(sm[0]!.userId, user1Mapping!.newId);

        // Pass 3 — note_edges backfilled (1 cross-link from note1 → note2).
        const edges = await getDb().select().from(noteEdges);
        assert.equal(edges.length, 1, "one note_edge from note1 → note2");
        assert.equal(edges[0]!.src, ids.note1Id);
        assert.equal(edges[0]!.dst, ids.note2Id);
        assert.equal(edges[0]!.kind, "link");

        // Pass 4 — parity OK across all known collections.
        assert.equal(result.parityOk, true, "parity check ok");
        assert.equal(result.edgeCount, 1, "result.edgeCount matches");
        const usersParity = result.parity.find((p) => p.collection === "users");
        assert.equal(usersParity?.expected, 2);
        assert.equal(usersParity?.actual, 2);
        const wpnNotesParity = result.parity.find(
          (p) => p.collection === "wpn_notes",
        );
        assert.equal(wpnNotesParity?.expected, 2);
        assert.equal(wpnNotesParity?.actual, 2);

        // Cleanup the tmp fixture.
        await fs.rm(path.dirname(dumpDir), { recursive: true, force: true });
      } finally {
        await ctx?.teardown();
      }
    },
  );

  test(
    "runImporter parity check FAILS when post-import row count is artificially mutated",
    { timeout: 30_000 },
    async (t) => {
      let ctx: TestPgSchemaContext | undefined;
      try {
        ctx = await setupPgTestSchema();
      } catch (err) {
        t.skip(`Postgres not reachable: ${String(err)}`);
        return;
      }
      try {
        await ensurePgConnected();
        const { dumpDir, ids } = await buildFixture();

        await runImporter({
          dumpDir,
          force: true,
          verbose: false,
        });

        // Sanity: parity was OK on first run.
        const initialNotes = await getDb().select().from(wpnNotes);
        assert.equal(initialNotes.length, 2);

        // Inject a stray row so re-running the parity-only logic detects drift.
        const strayId = randomUUID();
        await getDb().insert(wpnNotes).values({
          id: strayId,
          userId: initialNotes[0]!.userId,
          orgId: initialNotes[0]!.orgId,
          spaceId: initialNotes[0]!.spaceId,
          project_id: ids.projectId,
          parent_id: null,
          type: "markdown",
          title: "Stray",
          content: "stray",
          metadata: null,
          sibling_index: 999,
          created_at_ms: Date.now(),
          updated_at_ms: Date.now(),
        });

        // Re-run with reset=false force=true: importer overlays + re-checks.
        // Pass 4 should report wpn_notes mismatch (3 actual vs 2 expected).
        const result = await runImporter({
          dumpDir,
          force: true,
          verbose: false,
        });
        assert.equal(result.parityOk, false, "parity should fail with stray row");
        const wpnNotesParity = result.parity.find(
          (p) => p.collection === "wpn_notes",
        );
        assert.ok(wpnNotesParity, "wpn_notes parity entry present");
        assert.equal(wpnNotesParity!.expected, 2);
        assert.equal(wpnNotesParity!.actual, 3);
        assert.equal(wpnNotesParity!.ok, false);

        await fs.rm(path.dirname(dumpDir), { recursive: true, force: true });
      } finally {
        await ctx?.teardown();
      }
    },
  );

  test(
    "runImporter refuses to run on a non-empty users table without reset/force",
    { timeout: 15_000 },
    async (t) => {
      let ctx: TestPgSchemaContext | undefined;
      try {
        ctx = await setupPgTestSchema();
      } catch (err) {
        t.skip(`Postgres not reachable: ${String(err)}`);
        return;
      }
      try {
        await ensurePgConnected();
        // Seed a user row so the pre-flight check fires.
        await getDb().insert(users).values({
          id: randomUUID(),
          email: "preflight@example.test",
          passwordHash: "$2a$10$placeholder.preflight",
        });

        const { dumpDir } = await buildFixture();
        await assert.rejects(
          () => runImporter({ dumpDir, verbose: false }),
          /users table has \d+ rows/,
        );
        await fs.rm(path.dirname(dumpDir), { recursive: true, force: true });
      } finally {
        await ctx?.teardown();
      }
    },
  );

  test(
    "runImporter handles a dump with zero ObjectId-keyed rows gracefully",
    { timeout: 15_000 },
    async (t) => {
      let ctx: TestPgSchemaContext | undefined;
      try {
        ctx = await setupPgTestSchema();
      } catch (err) {
        t.skip(`Postgres not reachable: ${String(err)}`);
        return;
      }
      try {
        await ensurePgConnected();
        // Empty fixture: just an empty users.bson.
        const tmpRoot = await fs.mkdtemp(
          path.join(os.tmpdir(), "archon-importer-empty-"),
        );
        const dumpDir = path.join(tmpRoot, "fixture");
        await fs.mkdir(dumpDir, { recursive: true });
        await fs.writeFile(path.join(dumpDir, "users.bson"), Buffer.alloc(0));

        const result = await runImporter({
          dumpDir,
          force: true,
          verbose: false,
        });
        assert.equal(result.parityOk, true);
        assert.equal(result.sourceCounts.get("users") ?? 0, 0);

        const userRows = await getDb().select().from(users);
        assert.equal(userRows.length, 0);
        const mapRows = await getDb().select().from(legacyObjectIdMap);
        assert.equal(mapRows.length, 0);
        await fs.rm(tmpRoot, { recursive: true, force: true });
      } finally {
        await ctx?.teardown();
      }
    },
  );

  // Touch unused imports for some configs.
  void organizations;
  void wpnProjects;
});
