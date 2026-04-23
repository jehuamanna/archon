import type { Collection, Db, ObjectId } from "mongodb";

/** Thresholds — mirror `docs/mdx-notes/mongo-schema.md`. */
export const INLINE_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const KEY_MAX_BYTES = 256 * 1024 * 1024;
export const MAX_KEYS_PER_PROJECT = 1000;

/** Token-bucket per (project, user). */
export const WRITE_RATE_PER_SECOND = 20;
export const WRITE_RATE_BURST = 50;

export interface MdxStateHeadDoc {
  _id?: ObjectId;
  projectId: string;
  key: string;
  mode: "inline" | "chunked";
  value?: unknown;
  totalChunks?: number;
  totalBytes: number;
  version: number;
  updatedAt: Date;
  updatedBy: { userId: string; email: string };
}

export interface MdxStateChunkDoc {
  _id?: ObjectId;
  projectId: string;
  key: string;
  chunkIndex: number;
  headVersion: number;
  data: Buffer;
}

/** Per-WebSocket-connection Change Stream resume tokens. */
export interface MdxStateWsCursorDoc {
  _id?: ObjectId;
  connectionId: string;
  projectId: string;
  resumeToken: unknown;
  updatedAt: Date;
}

export function getMdxStateHead(db: Db): Collection<MdxStateHeadDoc> {
  return db.collection<MdxStateHeadDoc>("mdx_state_head");
}

export function getMdxStateChunks(db: Db): Collection<MdxStateChunkDoc> {
  return db.collection<MdxStateChunkDoc>("mdx_state_chunks");
}

export function getMdxStateWsCursors(db: Db): Collection<MdxStateWsCursorDoc> {
  return db.collection<MdxStateWsCursorDoc>("mdx_state_ws_cursors");
}

/**
 * Idempotent index setup for the mini-app state collections. Called once from
 * `connectMongo` alongside the existing `ensureIndexes` in `db.ts`.
 */
export async function ensureMdxStateIndexes(db: Db): Promise<void> {
  const head = getMdxStateHead(db);
  await head.createIndex({ projectId: 1, key: 1 }, { unique: true });
  await head.createIndex({ projectId: 1, updatedAt: -1 });

  const chunks = getMdxStateChunks(db);
  await chunks.createIndex(
    { projectId: 1, key: 1, chunkIndex: 1, headVersion: 1 },
    { unique: true },
  );
  await chunks.createIndex({ projectId: 1, key: 1, headVersion: 1 });

  const cursors = getMdxStateWsCursors(db);
  await cursors.createIndex({ connectionId: 1 }, { unique: true });
  await cursors.createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 7 },
  );
}

/**
 * Heuristic size estimator. JSON-encoded UTF-8 byte count is a reasonable upper
 * bound on BSON size for the value space we support (objects, arrays, strings,
 * numbers, booleans, null). We call this before the transaction to reject
 * oversize writes early.
 */
export function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}
