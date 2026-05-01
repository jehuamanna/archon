/**
 * Note checkpoint routes — manual user-triggered snapshots of a note's full
 * Y.Doc state. The server reads its own authoritative Y.Doc via Hocuspocus'
 * direct connection, so clients never upload state and the live CRDT is
 * never raced by REST writes.
 *
 * Surface:
 *   POST   /wpn/notes/:id/checkpoints              — snapshot live Y.Doc
 *   GET    /wpn/notes/:id/checkpoints              — list (no bytes)
 *   GET    /wpn/notes/:id/checkpoints/:cid         — single checkpoint with bytes
 *   POST   /wpn/notes/:id/checkpoints/:cid/restore — apply-as-diff restore
 *   PATCH  /wpn/notes/:id/checkpoints/:cid         — edit label, toggle pinned
 *   DELETE /wpn/notes/:id/checkpoints/:cid         — remove a checkpoint
 *
 * Auto-prune: after each create, unpinned rows beyond `MAX_CHECKPOINTS_PER_NOTE`
 * are deleted oldest-first. Pinned rows are excluded from the cap entirely so a
 * heavy pinning user can't be silently capped at a stale subset.
 *
 * See note `c39afaf8-b50e-421a-a802-b856f589e4f0` for the full spec.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID, createHash } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { getDb } from "./pg.js";
import { noteCheckpoints, users } from "./db/schema.js";
import {
  assertCanReadProjectForNote,
  assertCanWriteProjectForNote,
} from "./permission-resolver.js";
import { isUuid } from "./db/legacy-id-map.js";
import {
  decodeCheckpointContent,
  isYjsServerConfigured,
  replaceYjsDocContent,
  snapshotYjsDocForNote,
} from "./realtime/yjs-ws.js";

const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024; // 2 MB compressed Y.Doc state
const DEDUPE_WINDOW_MS = 30_000;
const MAX_LABEL_LEN = 200;
const MAX_CHECKPOINTS_PER_NOTE = 100;

const createCheckpointBody = z
  .object({
    label: z.string().trim().max(MAX_LABEL_LEN).optional(),
  })
  .strict();

const restoreCheckpointBody = z
  .object({
    snapshotBeforeRestore: z.boolean().optional(),
    preRestoreLabel: z.string().trim().max(MAX_LABEL_LEN).optional(),
  })
  .strict();

const patchCheckpointBody = z
  .object({
    // `label: null` clears the label; omitted leaves it untouched.
    label: z.string().trim().max(MAX_LABEL_LEN).nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

type CheckpointMetadata = {
  id: string;
  noteId: string;
  createdByUserId: string | null;
  createdByEmail: string | null;
  createdByDisplayName: string | null;
  label: string | null;
  pinned: boolean;
  contentText: string;
  contentSha256: string;
  sizeBytes: number;
  createdAtMs: number;
};

type CheckpointJoinedRow = {
  id: string;
  noteId: string;
  createdByUserId: string | null;
  label: string | null;
  pinned: boolean;
  contentText: string;
  contentSha256: string;
  sizeBytes: number;
  createdAtMs: number;
  createdByEmail: string | null;
  createdByDisplayName: string | null;
};

function projectMetadata(row: CheckpointJoinedRow): CheckpointMetadata {
  return {
    id: row.id,
    noteId: row.noteId,
    createdByUserId: row.createdByUserId,
    createdByEmail: row.createdByEmail,
    createdByDisplayName: row.createdByDisplayName,
    label: row.label,
    pinned: row.pinned,
    contentText: row.contentText,
    contentSha256: row.contentSha256,
    sizeBytes: row.sizeBytes,
    createdAtMs: row.createdAtMs,
  };
}

const checkpointSelectFields = {
  id: noteCheckpoints.id,
  noteId: noteCheckpoints.noteId,
  createdByUserId: noteCheckpoints.createdByUserId,
  label: noteCheckpoints.label,
  pinned: noteCheckpoints.pinned,
  contentText: noteCheckpoints.contentText,
  contentSha256: noteCheckpoints.contentSha256,
  sizeBytes: noteCheckpoints.sizeBytes,
  createdAtMs: noteCheckpoints.createdAtMs,
  createdByEmail: users.email,
  createdByDisplayName: users.displayName,
} as const;

/**
 * Auto-prune: delete the oldest unpinned checkpoints for `noteId` that fall
 * past `MAX_CHECKPOINTS_PER_NOTE`. Pinned rows are excluded from the cap
 * entirely (they're protected from auto-prune by definition). Called inline
 * after every create so the table never grows unbounded — no separate cron
 * needed.
 *
 * Single round-trip: an in-SQL OFFSET subquery picks the IDs to delete and
 * the outer DELETE removes them atomically.
 */
async function autoPruneNoteCheckpoints(noteId: string): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM note_checkpoints
    WHERE id IN (
      SELECT id FROM note_checkpoints
      WHERE note_id = ${noteId}::uuid
        AND pinned = false
      ORDER BY created_at_ms DESC
      OFFSET ${MAX_CHECKPOINTS_PER_NOTE}
    )
  `);
}

export function registerNoteCheckpointsRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  /**
   * Snapshot the current Y.Doc for `:id` and persist it. The server reads
   * its own authoritative state — request body only carries an optional
   * label.
   */
  app.post("/wpn/notes/:id/checkpoints", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      return reply.status(400).send({ error: "Invalid note id" });
    }
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    const project = await assertCanWriteProjectForNote(reply, auth, id);
    if (!project) return;

    const parsed = createCheckpointBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const label = parsed.data.label && parsed.data.label.length > 0
      ? parsed.data.label
      : null;

    if (!isYjsServerConfigured()) {
      return reply
        .status(503)
        .send({ error: "Realtime server not available; cannot snapshot Y.Doc" });
    }

    let stateBytes: Buffer;
    let contentText: string;
    try {
      const snap = await snapshotYjsDocForNote(id);
      stateBytes = snap.stateBytes;
      contentText = snap.contentText;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[note-checkpoints] snapshot failed", id, (err as Error).message);
      return reply.status(500).send({ error: "Snapshot failed" });
    }

    if (contentText.length === 0) {
      return reply
        .status(400)
        .send({ error: "Note is empty; nothing to checkpoint" });
    }
    if (stateBytes.length > MAX_CHECKPOINT_BYTES) {
      return reply.status(413).send({
        error: "Checkpoint exceeds size limit",
        sizeBytes: stateBytes.length,
        limitBytes: MAX_CHECKPOINT_BYTES,
      });
    }

    const contentSha256 = createHash("sha256").update(stateBytes).digest("hex");
    const nowMs = Date.now();

    // Dedupe rapid double-clicks: same note + same content hash within 30s
    // returns the existing row instead of writing a new one.
    const recent = await getDb()
      .select(checkpointSelectFields)
      .from(noteCheckpoints)
      .leftJoin(users, eq(users.id, noteCheckpoints.createdByUserId))
      .where(
        and(
          eq(noteCheckpoints.noteId, id),
          eq(noteCheckpoints.contentSha256, contentSha256),
          gte(noteCheckpoints.createdAtMs, nowMs - DEDUPE_WINDOW_MS),
        ),
      )
      .orderBy(desc(noteCheckpoints.createdAtMs))
      .limit(1);
    if (recent[0]) {
      return reply.status(200).send({ checkpoint: projectMetadata(recent[0]), deduped: true });
    }

    const checkpointId = randomUUID();
    await getDb().insert(noteCheckpoints).values({
      id: checkpointId,
      noteId: id,
      createdByUserId: auth.sub,
      label,
      pinned: false,
      yjsState: stateBytes,
      contentText,
      contentSha256,
      sizeBytes: stateBytes.length,
      createdAtMs: nowMs,
    });

    // Auto-prune oldest unpinned beyond the per-note cap. Best-effort: if the
    // prune query fails we still return the newly created checkpoint — the
    // worst case is the table grows by one extra row this round.
    try {
      await autoPruneNoteCheckpoints(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[note-checkpoints] auto-prune failed",
        id,
        (err as Error).message,
      );
    }

    // Re-read with the users join so the response includes the author's
    // email + displayName. Cheap (single-row PK lookup) and keeps the
    // create response shape identical to list rows.
    const fetched = await getDb()
      .select(checkpointSelectFields)
      .from(noteCheckpoints)
      .leftJoin(users, eq(users.id, noteCheckpoints.createdByUserId))
      .where(eq(noteCheckpoints.id, checkpointId))
      .limit(1);
    if (!fetched[0]) {
      // Should not happen — the row we just inserted is gone. Surface as 500.
      return reply.status(500).send({ error: "Checkpoint disappeared after insert" });
    }
    return reply.status(201).send({ checkpoint: projectMetadata(fetched[0]) });
  });

  /**
   * List checkpoints for a note, newest first. Returns metadata + content
   * text for cheap preview rendering; raw `yjs_state` bytes are excluded —
   * fetch them via the single-checkpoint endpoint.
   */
  app.get("/wpn/notes/:id/checkpoints", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      return reply.status(400).send({ error: "Invalid note id" });
    }
    const project = await assertCanReadProjectForNote(reply, auth, id);
    if (!project) return;

    const rows = await getDb()
      .select(checkpointSelectFields)
      .from(noteCheckpoints)
      .leftJoin(users, eq(users.id, noteCheckpoints.createdByUserId))
      .where(eq(noteCheckpoints.noteId, id))
      .orderBy(desc(noteCheckpoints.pinned), desc(noteCheckpoints.createdAtMs));

    return reply.send({ checkpoints: rows.map(projectMetadata) });
  });

  /**
   * Restore the live Y.Doc to a checkpoint's content. Implementation:
   *   1. (default) Snapshot the current live state into a new auto-checkpoint
   *      labelled "Auto-snapshot before restore" so the action is reversible
   *      via the UI's "Undo" toast (caller can opt out with
   *      `snapshotBeforeRestore: false`).
   *   2. Decode the target checkpoint's `yjs_state` bytes; extract its
   *      `Y.Text("content")` value.
   *   3. Open a Hocuspocus direct connection and replace the live
   *      `Y.Text("content")` inside one transaction. Hocuspocus broadcasts
   *      the diff to every connected editor live.
   *
   * The restore transaction's origin is the Hocuspocus direct connection,
   * NOT any client's YSyncConfig, so per-user `Y.UndoManager` instances
   * ignore it — no collaborator's Cmd-Z can retract the restore.
   *
   * Returns:
   *   {
   *     ok: true,
   *     restoredFromCheckpointId,         // the checkpoint we restored TO
   *     preRestoreCheckpointId | null,    // the auto-snapshot of pre-restore state
   *     restoredAtMs,
   *   }
   */
  app.post("/wpn/notes/:id/checkpoints/:cid/restore", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id, cid } = request.params as { id: string; cid: string };
    if (!isUuid(id) || !isUuid(cid)) {
      return reply.status(400).send({ error: "Invalid id" });
    }
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    const project = await assertCanWriteProjectForNote(reply, auth, id);
    if (!project) return;

    const parsed = restoreCheckpointBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const snapshotBefore = parsed.data.snapshotBeforeRestore !== false;
    const preRestoreLabel = parsed.data.preRestoreLabel?.length
      ? parsed.data.preRestoreLabel
      : "Auto-snapshot before restore";

    if (!isYjsServerConfigured()) {
      return reply
        .status(503)
        .send({ error: "Realtime server not available; cannot restore" });
    }

    const targetRows = await getDb()
      .select()
      .from(noteCheckpoints)
      .where(
        and(eq(noteCheckpoints.id, cid), eq(noteCheckpoints.noteId, id)),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      return reply.status(404).send({ error: "Checkpoint not found" });
    }

    let restoreText: string;
    try {
      restoreText = decodeCheckpointContent(Buffer.from(target.yjsState));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[note-checkpoints] decode failed", cid, (err as Error).message);
      return reply.status(500).send({ error: "Failed to decode checkpoint" });
    }

    // Step 1: optional pre-restore auto-checkpoint of the current live state.
    // We snapshot first (best-effort): if it fails we still proceed with the
    // restore but report null preRestoreCheckpointId so the UI knows there's
    // no Undo target. Failure modes here are mostly "doc is empty" — skipping
    // an empty pre-snapshot is fine.
    let preRestoreCheckpointId: string | null = null;
    if (snapshotBefore) {
      try {
        const snap = await snapshotYjsDocForNote(id);
        if (
          snap.contentText.length > 0 &&
          snap.stateBytes.length <= MAX_CHECKPOINT_BYTES
        ) {
          const sha = createHash("sha256").update(snap.stateBytes).digest("hex");
          // Skip pre-snapshot if it would be identical to the target — restoring
          // a checkpoint to itself is a no-op and we'd just be duplicating rows.
          if (sha !== target.contentSha256) {
            const newId = randomUUID();
            await getDb().insert(noteCheckpoints).values({
              id: newId,
              noteId: id,
              createdByUserId: auth.sub,
              label: preRestoreLabel,
              pinned: false,
              yjsState: snap.stateBytes,
              contentText: snap.contentText,
              contentSha256: sha,
              sizeBytes: snap.stateBytes.length,
              createdAtMs: Date.now(),
            });
            preRestoreCheckpointId = newId;
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[note-checkpoints] pre-restore snapshot failed",
          id,
          (err as Error).message,
        );
        // fall through — restore still proceeds
      }
    }

    // Step 2 + 3: replace live Y.Doc content. Errors here MUST surface — we
    // don't want a silent "restore" that didn't actually apply.
    try {
      await replaceYjsDocContent(id, restoreText);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[note-checkpoints] restore apply failed", id, (err as Error).message);
      return reply.status(500).send({
        error: "Restore failed",
        preRestoreCheckpointId,
      });
    }

    return reply.send({
      ok: true,
      restoredFromCheckpointId: cid,
      preRestoreCheckpointId,
      restoredAtMs: Date.now(),
    });
  });

  /**
   * Fetch a single checkpoint including raw Y.Doc state bytes (base64-encoded
   * for JSON transport). Useful for inspection / debugging / future
   * client-side branch creation.
   */
  app.get("/wpn/notes/:id/checkpoints/:cid", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id, cid } = request.params as { id: string; cid: string };
    if (!isUuid(id) || !isUuid(cid)) {
      return reply.status(400).send({ error: "Invalid id" });
    }
    const project = await assertCanReadProjectForNote(reply, auth, id);
    if (!project) return;

    // Two reads: one with the users join for metadata, one for raw bytes.
    // Doing both in a single SELECT would force the bytes to flow through the
    // JSON projection helper unnecessarily.
    const metaRows = await getDb()
      .select(checkpointSelectFields)
      .from(noteCheckpoints)
      .leftJoin(users, eq(users.id, noteCheckpoints.createdByUserId))
      .where(
        and(eq(noteCheckpoints.id, cid), eq(noteCheckpoints.noteId, id)),
      )
      .limit(1);
    const meta = metaRows[0];
    if (!meta) {
      return reply.status(404).send({ error: "Checkpoint not found" });
    }
    const bytesRows = await getDb()
      .select({ yjsState: noteCheckpoints.yjsState })
      .from(noteCheckpoints)
      .where(eq(noteCheckpoints.id, cid))
      .limit(1);
    return reply.send({
      checkpoint: {
        ...projectMetadata(meta),
        yjsStateBase64: bytesRows[0]
          ? Buffer.from(bytesRows[0].yjsState).toString("base64")
          : "",
      },
    });
  });

  /**
   * Patch a checkpoint's metadata: edit `label` (set to null to clear) and/or
   * toggle `pinned`. Pinned rows are excluded from the per-note auto-prune
   * cap. Any user with write access to the note can edit any checkpoint —
   * pinning + label edits are collaborative actions, not creator-restricted.
   */
  app.patch("/wpn/notes/:id/checkpoints/:cid", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id, cid } = request.params as { id: string; cid: string };
    if (!isUuid(id) || !isUuid(cid)) {
      return reply.status(400).send({ error: "Invalid id" });
    }
    const project = await assertCanWriteProjectForNote(reply, auth, id);
    if (!project) return;

    const parsed = patchCheckpointBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const patch = parsed.data;
    if (patch.label === undefined && patch.pinned === undefined) {
      return reply.status(400).send({ error: "No fields to update" });
    }

    const setFields: Record<string, unknown> = {};
    if (patch.label !== undefined) {
      setFields.label =
        patch.label === null || patch.label.length === 0 ? null : patch.label;
    }
    if (patch.pinned !== undefined) {
      setFields.pinned = patch.pinned;
    }

    const updated = await getDb()
      .update(noteCheckpoints)
      .set(setFields)
      .where(
        and(eq(noteCheckpoints.id, cid), eq(noteCheckpoints.noteId, id)),
      )
      .returning({ id: noteCheckpoints.id });
    if (updated.length === 0) {
      return reply.status(404).send({ error: "Checkpoint not found" });
    }

    const fetched = await getDb()
      .select(checkpointSelectFields)
      .from(noteCheckpoints)
      .leftJoin(users, eq(users.id, noteCheckpoints.createdByUserId))
      .where(eq(noteCheckpoints.id, cid))
      .limit(1);
    if (!fetched[0]) {
      return reply.status(500).send({ error: "Checkpoint disappeared after update" });
    }
    return reply.send({ checkpoint: projectMetadata(fetched[0]) });
  });

  /**
   * Delete a checkpoint. Any user with write access to the note can delete
   * any checkpoint, including pinned ones (pinning protects against
   * auto-prune, not against deliberate deletion).
   */
  app.delete("/wpn/notes/:id/checkpoints/:cid", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id, cid } = request.params as { id: string; cid: string };
    if (!isUuid(id) || !isUuid(cid)) {
      return reply.status(400).send({ error: "Invalid id" });
    }
    const project = await assertCanWriteProjectForNote(reply, auth, id);
    if (!project) return;

    const deleted = await getDb()
      .delete(noteCheckpoints)
      .where(
        and(eq(noteCheckpoints.id, cid), eq(noteCheckpoints.noteId, id)),
      )
      .returning({ id: noteCheckpoints.id });
    if (deleted.length === 0) {
      return reply.status(404).send({ error: "Checkpoint not found" });
    }
    return reply.status(204).send();
  });
}
