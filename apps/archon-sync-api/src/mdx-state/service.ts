/**
 * Per-project mdx-state service on Postgres.
 *
 * Replaces the Mongo replica-set/standalone fork: PG transactions are
 * uniform, so the inline + chunked write paths are both wrapped in a
 * single `withTx`. Readers protect themselves from torn state by filtering
 * chunks on `headVersion`, same contract as the Mongo path.
 *
 * Notification: every successful put fires `pg_notify('mdx:<projectId>', …)`
 * via mdx-state/notify.ts so the WS subscriber re-fetches the head row.
 */
import { and, asc, eq, lt } from "drizzle-orm";
import { getDb, withTx } from "../pg.js";
import { mdxStateChunks, mdxStateHead } from "../db/schema.js";
import {
  CHUNK_SIZE_BYTES,
  INLINE_THRESHOLD_BYTES,
  KEY_MAX_BYTES,
  MAX_KEYS_PER_PROJECT,
  serializedSize,
} from "./schema.js";
import { notifyMdxState } from "./notify.js";

export interface Actor {
  userId: string;
  email: string;
}

export class MdxStateConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("version conflict");
    this.name = "MdxStateConflictError";
  }
}

export class MdxStateTooLargeError extends Error {
  constructor(readonly totalBytes: number) {
    super("state value exceeds per-key cap");
    this.name = "MdxStateTooLargeError";
  }
}

export class MdxStateKeyLimitError extends Error {
  constructor(readonly keyCount: number) {
    super("project state key-count cap reached");
    this.name = "MdxStateKeyLimitError";
  }
}

export interface GetResult<T = unknown> {
  value: T | undefined;
  version: number;
  mode: "inline" | "chunked" | "absent";
}

export interface KeyMeta {
  key: string;
  version: number;
  mode: "inline" | "chunked";
  totalBytes: number;
  updatedAt: Date;
}

export interface PutResult {
  version: number;
  mode: "inline" | "chunked";
  totalBytes: number;
}

export class MdxStateService {
  async list(projectId: string): Promise<KeyMeta[]> {
    const rows = await getDb()
      .select({
        key: mdxStateHead.key,
        version: mdxStateHead.version,
        mode: mdxStateHead.mode,
        totalBytes: mdxStateHead.totalBytes,
        updatedAt: mdxStateHead.updatedAt,
      })
      .from(mdxStateHead)
      .where(eq(mdxStateHead.projectId, projectId));
    return rows.map((d) => ({
      key: d.key,
      version: d.version,
      mode: d.mode as "inline" | "chunked",
      totalBytes: d.totalBytes,
      updatedAt: d.updatedAt,
    }));
  }

  async get<T = unknown>(
    projectId: string,
    key: string,
  ): Promise<GetResult<T>> {
    const rows = await getDb()
      .select()
      .from(mdxStateHead)
      .where(
        and(eq(mdxStateHead.projectId, projectId), eq(mdxStateHead.key, key)),
      )
      .limit(1);
    const doc = rows[0];
    if (!doc) {
      return { value: undefined, version: 0, mode: "absent" };
    }
    if (doc.mode === "inline") {
      return {
        value: doc.value as T,
        version: doc.version,
        mode: "inline",
      };
    }
    const chunks = await getDb()
      .select()
      .from(mdxStateChunks)
      .where(
        and(
          eq(mdxStateChunks.projectId, projectId),
          eq(mdxStateChunks.key, key),
          eq(mdxStateChunks.headVersion, doc.version),
        ),
      )
      .orderBy(asc(mdxStateChunks.chunkIndex));
    if (chunks.length === 0) {
      // Orphaned chunked head — chunks deleted but head not flipped. Treat
      // as absent (matches Mongo path).
      return { value: undefined, version: 0, mode: "absent" };
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.data as Buffer)));
    const text = buf.toString("utf8");
    if (text.length === 0) {
      return { value: undefined, version: 0, mode: "absent" };
    }
    let parsed: { v: T };
    try {
      parsed = JSON.parse(text) as { v: T };
    } catch {
      return { value: undefined, version: 0, mode: "absent" };
    }
    return { value: parsed.v, version: doc.version, mode: "chunked" };
  }

  async put<T>(
    projectId: string,
    key: string,
    value: T,
    expectedVersion: number,
    actor: Actor,
  ): Promise<PutResult> {
    const size = serializedSize(value);
    if (size > KEY_MAX_BYTES) {
      throw new MdxStateTooLargeError(size);
    }

    const result = await withTx(async (tx) => {
      const currentRows = await tx
        .select({ version: mdxStateHead.version })
        .from(mdxStateHead)
        .where(
          and(
            eq(mdxStateHead.projectId, projectId),
            eq(mdxStateHead.key, key),
          ),
        )
        .limit(1);
      const currentVersion = currentRows[0]?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        throw new MdxStateConflictError(currentVersion);
      }
      if (currentVersion === 0) {
        const keyCountRows = await tx
          .select({ key: mdxStateHead.key })
          .from(mdxStateHead)
          .where(eq(mdxStateHead.projectId, projectId));
        if (keyCountRows.length >= MAX_KEYS_PER_PROJECT) {
          throw new MdxStateKeyLimitError(keyCountRows.length);
        }
      }
      const nextVersion = currentVersion + 1;
      const updatedAt = new Date();

      if (size <= INLINE_THRESHOLD_BYTES) {
        await tx
          .insert(mdxStateHead)
          .values({
            projectId,
            key,
            mode: "inline",
            value: value as unknown,
            totalBytes: size,
            version: nextVersion,
            updatedAt,
            updatedByUserId: actor.userId,
            updatedByEmail: actor.email,
          })
          .onConflictDoUpdate({
            target: [mdxStateHead.projectId, mdxStateHead.key],
            set: {
              mode: "inline",
              value: value as unknown,
              totalChunks: null,
              totalBytes: size,
              version: nextVersion,
              updatedAt,
              updatedByUserId: actor.userId,
              updatedByEmail: actor.email,
            },
          });
        // GC any stale chunks (transition from chunked → inline).
        await tx
          .delete(mdxStateChunks)
          .where(
            and(
              eq(mdxStateChunks.projectId, projectId),
              eq(mdxStateChunks.key, key),
            ),
          );
        return { version: nextVersion, mode: "inline" as const, totalBytes: size };
      }

      // Chunked path.
      const serialized = Buffer.from(JSON.stringify({ v: value }), "utf8");
      const totalChunks = Math.ceil(serialized.length / CHUNK_SIZE_BYTES);
      const chunkRows: Array<{
        projectId: string;
        key: string;
        chunkIndex: number;
        headVersion: number;
        data: Buffer;
      }> = [];
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE_BYTES;
        const end = Math.min(start + CHUNK_SIZE_BYTES, serialized.length);
        chunkRows.push({
          projectId,
          key,
          chunkIndex: i,
          headVersion: nextVersion,
          data: serialized.subarray(start, end) as Buffer,
        });
      }
      await tx
        .insert(mdxStateHead)
        .values({
          projectId,
          key,
          mode: "chunked",
          value: null,
          totalChunks,
          totalBytes: size,
          version: nextVersion,
          updatedAt,
          updatedByUserId: actor.userId,
          updatedByEmail: actor.email,
        })
        .onConflictDoUpdate({
          target: [mdxStateHead.projectId, mdxStateHead.key],
          set: {
            mode: "chunked",
            value: null,
            totalChunks,
            totalBytes: size,
            version: nextVersion,
            updatedAt,
            updatedByUserId: actor.userId,
            updatedByEmail: actor.email,
          },
        });
      if (chunkRows.length > 0) {
        await tx.insert(mdxStateChunks).values(chunkRows);
      }
      // GC stale chunks for older versions.
      await tx
        .delete(mdxStateChunks)
        .where(
          and(
            eq(mdxStateChunks.projectId, projectId),
            eq(mdxStateChunks.key, key),
            lt(mdxStateChunks.headVersion, nextVersion),
          ),
        );
      return { version: nextVersion, mode: "chunked" as const, totalBytes: size };
    });

    // Best-effort fanout to LISTEN subscribers.
    void notifyMdxState(projectId, key, result.version);
    return result;
  }
}

/** Test hook compatibility — no-op on PG. */
export function __resetMdxStateReplicaDetectionForTests(): void {
  // No replica-set detection on PG; transactions are uniform.
}
