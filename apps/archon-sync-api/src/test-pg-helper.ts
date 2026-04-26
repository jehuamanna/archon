import "./load-root-env.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { ensurePgConnected, getDb, getPool, disconnectPg } from "./pg.js";

/**
 * Resolve the Postgres URL integration tests should target.
 *
 * Priority:
 *   1. `ARCHON_TEST_DATABASE_URL` — dedicated test database (recommended).
 *   2. `DATABASE_URL` — the live database the app uses. Tests share it but
 *      isolate per-test via search_path so cross-pollution is impossible.
 *   3. `postgres://archon:archon@localhost:5432/archon_test` — local dev
 *      default for the `local-pg` compose service.
 */
export function resolveTestDatabaseUrl(): string {
  return (
    process.env.ARCHON_TEST_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    "postgres://archon:archon@localhost:5432/archon_test"
  );
}

/**
 * Lazy-load + cache the baseline migration SQL so each per-test schema setup
 * doesn't re-read it from disk. The migration file is the single source of
 * truth for the schema layout.
 */
let _baselineSql: string | null = null;

async function loadBaselineSql(): Promise<string> {
  if (_baselineSql !== null) return _baselineSql;
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "db/migrations",
  );
  // Pick the lowest-numbered .sql file (drizzle-kit names them
  // 0000_baseline.sql, 0001_*.sql, etc.).
  const files = (await fs.readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const merged = await Promise.all(
    files.map((f) => fs.readFile(path.join(migrationsDir, f), "utf-8")),
  );
  _baselineSql = merged.join("\n--> statement-breakpoint\n");
  return _baselineSql;
}

/**
 * Apply the merged baseline migration SQL inside a single search_path.
 * drizzle-kit emits statements separated by `--> statement-breakpoint` —
 * we split on that marker and execute each statement individually.
 */
async function applyBaseline(schemaName: string): Promise<void> {
  const allSql = await loadBaselineSql();
  const statements = allSql
    .split(/--> statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const client = await getPool().connect();
  try {
    await client.query(`SET search_path TO "${schemaName}"`);
    for (const stmt of statements) {
      await client.query(stmt);
    }
  } finally {
    client.release();
  }
}

/**
 * Per-test PG schema isolation. Each test gets its own schema with a
 * random suffix; the schema is dropped in `teardown` no matter what (use
 * inside `t.after()` / `try/finally`). Multiple tests run safely in
 * parallel against the same `archon_test` database.
 *
 * Returned context exposes:
 *   - `schemaName`: the schema the test is pinned to.
 *   - `setSearchPath()`: re-applies search_path on a fresh connection (used
 *     internally; tests rarely need it directly).
 *   - `teardown()`: drops the schema and disconnects the pool. Idempotent.
 */
export interface TestPgSchemaContext {
  schemaName: string;
  setSearchPath: () => Promise<void>;
  teardown: () => Promise<void>;
}

// The current test schema. Read by the wrapped pool.connect so every
// checkout — including reused idle connections — lands on the active test's
// schema. Tests run serially within a Node-test-runner file, so this is
// safe.
let _currentTestSchema: string | null = null;
let _connectHookInstalled = false;

function ensureConnectHook(): void {
  if (_connectHookInstalled) return;
  const pool = getPool();
  // The 'connect' event fires only on NEW connections, not on reused idle
  // ones. We wrap pool.connect to force-set search_path on every checkout
  // — that's the only way to guarantee correctness when tests share a pool
  // and acquire connections that might have been bound to a previous test's
  // (now-dropped) schema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origConnect = (pool.connect as any).bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // node-postgres pool.connect supports both callback-form and Promise-form.
  // node-postgres's own pool.query() uses callback-form internally, and so
  // does drizzle when its session calls `this.client.query(...)` against a
  // Pool. The wrapper has to handle both forms — otherwise non-await
  // checkouts get a fresh client without search_path applied, and the
  // queries land in `public` instead of the per-test schema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connect = function (cb?: unknown): any {
    const setPath = async (client: any): Promise<void> => {
      if (!_currentTestSchema) return;
      try {
        await client.query(
          `SET search_path TO "${_currentTestSchema.replace(/"/g, '""')}", public`,
        );
      } catch {
        /* ignore */
      }
    };
    if (typeof cb === "function") {
      // callback form: callback receives (err, client, done).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origConnect((err: any, client: any, done: any) => {
        if (err || !client) {
          (cb as any)(err, client, done);
          return;
        }
        void setPath(client).then(() => (cb as any)(err, client, done));
      });
    }
    // Promise form
    return (async () => {
      const client = await origConnect();
      await setPath(client);
      return client;
    })();
  };
  _connectHookInstalled = true;
}

/**
 * Set up a fresh per-test schema. Caller is responsible for calling
 * `teardown()` (recommended via `t.after(() => ctx.teardown())`).
 *
 * Strategy: per-test schema + a wrapped pool.connect that force-sets
 * search_path on every checkout. drizzle's pool.query() path goes through
 * pool.connect internally so this catches both transactional and
 * single-statement queries. Tests run serially within a Node-test-runner
 * file, so the module-level _currentTestSchema is safe.
 *
 * Note: drizzle's `db.transaction(fn)` definitely goes through pool.connect.
 * If a test asserts on read-after-write through getDb().select() and gets a
 * stale pool client, the assertion may see 0 rows. The mitigation is in
 * ensureConnectHook(), which runs the SET search_path on every checkout
 * (not just new connections).
 */
export async function setupPgTestSchema(): Promise<TestPgSchemaContext> {
  await ensurePgConnected();
  ensureConnectHook();

  const schemaName = `test_${randomUUID().slice(0, 8)}`;
  const db = getDb();
  await db.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
  _currentTestSchema = schemaName;

  await applyBaseline(schemaName);

  const pool = getPool();
  return {
    schemaName,
    setSearchPath: async () => {
      const client = await pool.connect();
      try {
        await client.query(
          `SET search_path TO "${schemaName.replace(/"/g, '""')}", public`,
        );
      } finally {
        client.release();
      }
    },
    teardown: async () => {
      try {
        await getDb().execute(
          sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`),
        );
      } catch {
        /* schema may already be gone */
      }
      if (_currentTestSchema === schemaName) _currentTestSchema = null;
    },
  };
}

/**
 * Disconnect the pool — call once at the end of a test file's run (typically
 * in a top-level `t.after`) to release the dedicated connection.
 */
export async function disconnectPgForTests(): Promise<void> {
  await disconnectPg();
}

/**
 * Convenience helper: factory for a fresh user row inserted into the active
 * test schema. Returns the new uuid. Used by integration tests that need a
 * caller identity but don't care about the password (a placeholder bcrypt
 * hash is set so verifyToken-against-disabled-account paths can be exercised
 * without bcrypt overhead).
 */
export async function factoryUser(opts?: {
  email?: string;
  isMasterAdmin?: boolean;
  displayName?: string | null;
}): Promise<string> {
  const { users } = await import("./db/schema.js");
  const id = randomUUID();
  const email = opts?.email ?? `test-${id.slice(0, 8)}@example.test`;
  await getDb()
    .insert(users)
    .values({
      id,
      email,
      passwordHash: "$2a$10$placeholder.hash.for.test.fixtures..........",
      isMasterAdmin: opts?.isMasterAdmin ?? null,
      displayName: opts?.displayName ?? null,
    });
  return id;
}

/** Convenience: factory for a fresh organization row. */
export async function factoryOrg(args: {
  ownerUserId: string;
  name?: string;
  slug?: string;
}): Promise<string> {
  const { organizations } = await import("./db/schema.js");
  const id = randomUUID();
  await getDb()
    .insert(organizations)
    .values({
      id,
      name: args.name ?? `Test Org ${id.slice(0, 8)}`,
      slug: args.slug ?? `test-org-${id.slice(0, 8)}`,
      ownerUserId: args.ownerUserId,
      createdAt: new Date(),
    });
  return id;
}

/** Convenience: factory for a default-kind space + owner enrolment. */
export async function factorySpace(args: {
  orgId: string;
  ownerUserId: string;
  kind?: "default" | "normal";
  name?: string;
}): Promise<string> {
  const { spaces, spaceMemberships } = await import("./db/schema.js");
  const id = randomUUID();
  const kind = args.kind ?? "normal";
  await getDb()
    .insert(spaces)
    .values({
      id,
      orgId: args.orgId,
      name: args.name ?? `Test Space ${id.slice(0, 8)}`,
      kind,
      createdByUserId: args.ownerUserId,
      createdAt: new Date(),
    });
  await getDb()
    .insert(spaceMemberships)
    .values({
      spaceId: id,
      userId: args.ownerUserId,
      role: "owner",
      addedByUserId: args.ownerUserId,
      joinedAt: new Date(),
    });
  return id;
}

/** Convenience: factory for a fresh wpn_workspaces row. */
export async function factoryWorkspace(args: {
  userId: string;
  orgId?: string;
  spaceId?: string;
  name?: string;
}): Promise<string> {
  const { wpnWorkspaces } = await import("./db/schema.js");
  const id = randomUUID();
  await getDb()
    .insert(wpnWorkspaces)
    .values({
      id,
      userId: args.userId,
      orgId: args.orgId ?? null,
      spaceId: args.spaceId ?? null,
      visibility: "public",
      creatorUserId: args.userId,
      name: args.name ?? `Test Workspace ${id.slice(0, 8)}`,
      sort_index: 0,
      color_token: null,
      created_at_ms: Date.now(),
      updated_at_ms: Date.now(),
      settings: {},
    });
  return id;
}

/** Convenience: factory for a fresh wpn_projects row. */
export async function factoryProject(args: {
  userId: string;
  workspaceId: string;
  orgId?: string;
  spaceId?: string;
  name?: string;
}): Promise<string> {
  const { wpnProjects } = await import("./db/schema.js");
  const id = randomUUID();
  await getDb()
    .insert(wpnProjects)
    .values({
      id,
      userId: args.userId,
      orgId: args.orgId ?? null,
      spaceId: args.spaceId ?? null,
      workspace_id: args.workspaceId,
      visibility: "public",
      creatorUserId: args.userId,
      name: args.name ?? `Test Project ${id.slice(0, 8)}`,
      sort_index: 0,
      color_token: null,
      created_at_ms: Date.now(),
      updated_at_ms: Date.now(),
      settings: {},
    });
  return id;
}
