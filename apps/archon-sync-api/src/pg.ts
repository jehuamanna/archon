/**
 * Postgres connection layer for sync-api.
 *
 * The pool is a singleton; `LISTEN` connections in `mdx-state/ws.ts` use
 * dedicated `pg.Client` instances acquired separately because LISTEN holds
 * the connection.
 */
// `pg` ships CJS exports; under TS NodeNext + esModuleInterop we re-import the
// module namespace to access the runtime classes (Pool, Client) and types.
import * as pgNs from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./db/schema.js";

const { Pool } = pgNs as unknown as { Pool: typeof PgPool };

let pool: PgPool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;
let connectInFlight: Promise<NodePgDatabase<typeof schema>> | null = null;

function pgPoolOptions(): PoolConfig {
  const serverless =
    process.env.VERCEL === "1" || process.env.ARCHON_SYNC_API_SERVERLESS === "1";
  const rawConnectionString =
    (typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim()) ||
    "postgres://archon:archon@localhost:5432/archon_sync";
  // Managed Postgres providers (Supabase, Neon, Railway, Heroku, RDS w/o
  // bundled CA) speak TLS but their intermediate certs aren't in Node's
  // built-in CA bundle — pg-connection-string ≥3 maps `sslmode=require`
  // to `verify-full`, which then fails with `SELF_SIGNED_CERT_IN_CHAIN`.
  // Strip the `sslmode` query param so pg-connection-string doesn't derive
  // its own ssl config (which would override our explicit one), then drive
  // TLS exclusively from the `ssl` field below. Strict mode is opt-in via
  // `sslmode=verify-ca` / `verify-full` — those we leave on the URL so the
  // strict path still takes effect.
  const lc = rawConnectionString.toLowerCase();
  const wantsRelaxedTls = /[?&]sslmode=(require|prefer|no-verify)\b/.test(lc);
  const strictTls = /[?&]sslmode=(verify-ca|verify-full)\b/.test(lc);
  let connectionString = rawConnectionString;
  let ssl: PoolConfig["ssl"];
  if (wantsRelaxedTls && !strictTls) {
    connectionString = stripSslmode(rawConnectionString);
    ssl = { rejectUnauthorized: false };
  }
  return {
    connectionString,
    ...(ssl ? { ssl } : {}),
    max: serverless ? 10 : 100,
    min: serverless ? 0 : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

/** Remove `sslmode=…` from a Postgres URL's query string. Preserves all other params. */
function stripSslmode(url: string): string {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return url;
  const base = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  const kept = query
    .split("&")
    .filter((p) => !/^sslmode=/i.test(p))
    .join("&");
  return kept.length > 0 ? `${base}?${kept}` : base;
}

/**
 * Idempotent PG connect using `DATABASE_URL` (or the local-pg dev default).
 * Concurrent invocations share one in-flight connect.
 */
export async function ensurePgConnected(): Promise<NodePgDatabase<typeof schema>> {
  if (db) return db;
  connectInFlight ??= (async () => {
    const p = new Pool(pgPoolOptions());
    // Verify the pool can hand us a connection before we declare ready.
    const client = await p.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
    pool = p;
    db = drizzle(p, { schema });
    return db;
  })();
  try {
    return await connectInFlight;
  } finally {
    connectInFlight = null;
  }
}

/** Returns the connected db or throws if `ensurePgConnected()` has not run. */
export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    throw new Error("Postgres not connected — call ensurePgConnected() first");
  }
  return db;
}

/** Direct pool access for code paths that need raw `pg` (LISTEN/NOTIFY, custom queries). */
export function getPool(): PgPool {
  if (!pool) {
    throw new Error("Postgres pool not initialized — call ensurePgConnected() first");
  }
  return pool;
}

/**
 * Run `fn` inside a transaction. Equivalent to drizzle's `db.transaction(...)`
 * but accepts a callback that returns a value, matching the API of `withTx`
 * helpers elsewhere in the codebase.
 */
export async function withTx<T>(
  fn: (tx: NodePgDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const d = getDb();
  return d.transaction(async (tx) => fn(tx as NodePgDatabase<typeof schema>));
}

/**
 * Acquire a dedicated `pg.Client` from the pool — caller must release it.
 * Used by `LISTEN` subscribers in mdx-state/ws.ts where the connection must
 * stay open for the lifetime of the subscription.
 */
export async function acquireDedicatedClient(): Promise<PoolClient> {
  return getPool().connect();
}

/** Disconnect the pool — used in test teardown. Idempotent. */
export async function disconnectPg(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
    connectInFlight = null;
  }
}

// Re-export the drizzle `sql` template tag for callers that need raw SQL
// (recursive CTEs, LISTEN/NOTIFY, parity-check counts, etc.).
export { sql };
export { schema };
