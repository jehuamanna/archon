import "./load-root-env.js";
import { getActiveDb } from "./db.js";

/**
 * Resolve the Mongo URI integration tests should target.
 *
 * Priority:
 *   1. `ARCHON_TEST_MONGODB_URI` — dedicated test cluster (recommended).
 *   2. `MONGODB_URI` — the live cluster the app uses. **Tests will share it.**
 *   3. `mongodb://127.0.0.1:27017` — local dev default.
 *
 * A short `serverSelectionTimeoutMS` is appended so tests skip fast when Mongo
 * is unreachable instead of hanging for 30s on the driver default.
 */
export function resolveTestMongoUri(): string {
  const candidate =
    process.env.ARCHON_TEST_MONGODB_URI?.trim() ||
    process.env.MONGODB_URI?.trim() ||
    "mongodb://127.0.0.1:27017";
  const sep = candidate.includes("?") ? "&" : "?";
  return `${candidate}${sep}serverSelectionTimeoutMS=2500`;
}

/**
 * Drop the currently-connected Mongo database. Called from each integration
 * test's `finally` block so test runs don't leak throwaway DBs into the
 * shared Atlas cluster (see memory: "Live Atlas cluster shared with app").
 *
 * Best-effort: swallows errors so an already-closed connection doesn't mask
 * a more informative test failure.
 */
export async function dropActiveMongoDb(): Promise<void> {
  try {
    await getActiveDb().dropDatabase();
  } catch {
    /* already closed / never connected */
  }
}
