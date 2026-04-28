/**
 * mdx-state size + rate limit constants.
 *
 * The Postgres table definitions for `mdx_state_head`, `mdx_state_chunks`,
 * and `mdx_state_ws_cursors` live in `apps/archon-sync-api/src/db/schema.ts`.
 * This module keeps the framework-agnostic constants and helpers that
 * service.ts + rate-limit.ts + the routes layer share.
 */

/** Size thresholds for inline vs chunked mdx-state values. */
export const INLINE_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const KEY_MAX_BYTES = 256 * 1024 * 1024;
export const MAX_KEYS_PER_PROJECT = 1000;

/** Token-bucket per (project, user). */
export const WRITE_RATE_PER_SECOND = 20;
export const WRITE_RATE_BURST = 50;

/** Per-key state head (post-PG). */
export interface MdxStateHeadRow {
  projectId: string;
  key: string;
  mode: "inline" | "chunked";
  value?: unknown;
  totalChunks?: number;
  totalBytes: number;
  version: number;
  updatedAt: Date;
  updatedByUserId: string;
  updatedByEmail: string;
}

/** Per-chunk row for chunked-mode state. */
export interface MdxStateChunkRow {
  projectId: string;
  key: string;
  chunkIndex: number;
  headVersion: number;
  data: Buffer;
}

/** Per-WebSocket-connection LISTEN cursor for resumable subscribers. */
export interface MdxStateWsCursorRow {
  connectionId: string;
  projectId: string;
  resumeToken: unknown;
  updatedAt: Date;
}

/**
 * Heuristic size estimator. JSON-encoded UTF-8 byte count is a reasonable
 * upper bound on serialized payload size — used to reject oversize writes
 * early without serializing twice.
 */
export function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}
