/**
 * Postgres-backed persistence for Yjs documents.
 *
 * Two tables back the adapter:
 *   - `yjs_state`         — single snapshot per `noteId`. `version` advances
 *     on every snapshot rewrite; `doc_bytes` is the full encoded state.
 *   - `yjs_state_updates` — append-only log of incremental updates. The
 *     `sequence` per note is monotonic; replay-since-sequence drives reconnect
 *     resume between snapshots.
 *
 * The adapter exposes the minimum surface Hocuspocus needs:
 * `loadDoc` for `onLoadDocument`, `storeDoc` for `onStoreDocument`, and
 * `appendUpdate` / `loadUpdatesSince` for the optional reconnect-resume path
 * (tests rely on these even when Hocuspocus's snapshot debounce makes them
 * less load-bearing in production).
 *
 * `compactUpdates` is the periodic janitor: per note, drop any update rows
 * older than `keepCount` so the log doesn't grow unboundedly.
 */
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "../pg.js";
import { yjsState, yjsStateUpdates } from "../db/schema.js";

export interface YjsPgAdapter {
  loadDoc(noteId: string): Promise<Buffer | null>;
  storeDoc(noteId: string, bytes: Buffer): Promise<void>;
  appendUpdate(noteId: string, updateBytes: Buffer): Promise<bigint>;
  loadUpdatesSince(
    noteId: string,
    sinceSequence: bigint,
  ): Promise<{ sequence: bigint; updateBytes: Buffer }[]>;
  compactUpdates(opts: { keepCount: number; sinceMinutes?: number }): Promise<{
    notesCompacted: number;
    updatesDropped: number;
  }>;
  countUpdatesForNote(noteId: string): Promise<number>;
}

export function createYjsPgAdapter(): YjsPgAdapter {
  return {
    async loadDoc(noteId) {
      const rows = await getDb()
        .select({ docBytes: yjsState.docBytes })
        .from(yjsState)
        .where(eq(yjsState.noteId, noteId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return Buffer.isBuffer(row.docBytes)
        ? row.docBytes
        : Buffer.from(row.docBytes);
    },

    async storeDoc(noteId, bytes) {
      // Upsert: if the row exists bump version + updatedAt, else insert at
      // version 1. We keep `version` monotonic so `loadUpdatesSince` queries
      // can be expressed in terms of it later if needed.
      await getDb()
        .insert(yjsState)
        .values({
          noteId,
          docBytes: bytes,
          version: 1,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: yjsState.noteId,
          set: {
            docBytes: bytes,
            version: sql`${yjsState.version} + 1`,
            updatedAt: new Date(),
          },
        });
    },

    async appendUpdate(noteId, updateBytes) {
      // Allocate next sequence per note. Done in a single SQL round-trip via
      // a CTE that selects MAX(sequence)+1 and inserts the row atomically.
      const result = await getDb().execute(sql`
        WITH next_seq AS (
          SELECT COALESCE(MAX(sequence), 0)::bigint + 1 AS seq
          FROM yjs_state_updates
          WHERE note_id = ${noteId}::uuid
        )
        INSERT INTO yjs_state_updates (note_id, update_bytes, sequence)
        SELECT ${noteId}::uuid, ${updateBytes}::bytea, seq FROM next_seq
        RETURNING sequence
      `);
      // drizzle returns either { rows } or directly an array depending on driver;
      // node-postgres returns { rows }.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (result as any).rows ?? (result as any);
      const seq = rows?.[0]?.sequence;
      if (seq === undefined || seq === null) {
        throw new Error("appendUpdate: no sequence returned");
      }
      return BigInt(seq);
    },

    async loadUpdatesSince(noteId, sinceSequence) {
      const rows = await getDb()
        .select({
          sequence: yjsStateUpdates.sequence,
          updateBytes: yjsStateUpdates.updateBytes,
        })
        .from(yjsStateUpdates)
        .where(
          and(
            eq(yjsStateUpdates.noteId, noteId),
            gt(yjsStateUpdates.sequence, Number(sinceSequence)),
          ),
        )
        .orderBy(asc(yjsStateUpdates.sequence));
      return rows.map((r) => ({
        sequence: BigInt(r.sequence),
        updateBytes: Buffer.isBuffer(r.updateBytes)
          ? r.updateBytes
          : Buffer.from(r.updateBytes),
      }));
    },

    async compactUpdates({ keepCount, sinceMinutes }) {
      // Find notes that have more than `keepCount` updates AND, if
      // `sinceMinutes` is provided, whose newest update is older than that
      // window (so we don't fight live editing sessions). Then delete every
      // update with sequence ≤ (max_sequence - keepCount).
      const cutoffMs = sinceMinutes ? sinceMinutes * 60_000 : 0;
      const cutoffTs = new Date(Date.now() - cutoffMs);
      const candidates = await getDb()
        .select({
          noteId: yjsStateUpdates.noteId,
          maxSeq: sql<number>`MAX(${yjsStateUpdates.sequence})`.as("max_seq"),
          maxApplied: sql<Date>`MAX(${yjsStateUpdates.appliedAt})`.as(
            "max_applied",
          ),
          countRows: sql<number>`COUNT(*)`.as("count_rows"),
        })
        .from(yjsStateUpdates)
        .groupBy(yjsStateUpdates.noteId);
      let notesCompacted = 0;
      let updatesDropped = 0;
      for (const c of candidates) {
        if (c.countRows <= keepCount) continue;
        if (sinceMinutes && new Date(c.maxApplied as unknown as string) > cutoffTs) {
          continue;
        }
        const dropBelow = Number(c.maxSeq) - keepCount;
        if (dropBelow <= 0) continue;
        const deleted = await getDb()
          .delete(yjsStateUpdates)
          .where(
            and(
              eq(yjsStateUpdates.noteId, c.noteId),
              lt(yjsStateUpdates.sequence, dropBelow),
            ),
          );
        // drizzle's PgDelete returns no count; rerun a count query if needed.
        // For diagnostics we approximate via countRows - keepCount.
        notesCompacted++;
        updatesDropped += Math.max(0, c.countRows - keepCount);
        void deleted;
      }
      return { notesCompacted, updatesDropped };
    },

    async countUpdatesForNote(noteId) {
      const rows = await getDb()
        .select({ c: sql<number>`COUNT(*)` })
        .from(yjsStateUpdates)
        .where(eq(yjsStateUpdates.noteId, noteId));
      return Number(rows[0]?.c ?? 0);
    },
  };
}

// suppress unused-import warnings when desc() is wired in later.
void desc;
