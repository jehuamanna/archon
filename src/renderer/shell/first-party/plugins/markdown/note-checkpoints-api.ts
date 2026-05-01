/**
 * Renderer-side client for the checkpoint endpoints registered by
 * `apps/archon-sync-api/src/note-checkpoints-routes.ts`. Goes through
 * `authedFetch` so 401s recover transparently via the renderer's standard
 * single-flight refresh primitive.
 *
 * Server returns the same `CheckpointMetadata` shape from create / list /
 * single-fetch — the single-fetch endpoint additionally bundles
 * `yjsStateBase64`, but that field is only consumed by future flows
 * (client-side branching), not by the history panel.
 */
import { createSyncBaseUrlResolver } from "@archon/platform";
import { authedFetch } from "../../../../auth/auth-retry";

const resolveSyncBase = createSyncBaseUrlResolver();

export interface CheckpointMetadata {
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
}

export interface RestoreResult {
  ok: true;
  restoredFromCheckpointId: string;
  preRestoreCheckpointId: string | null;
  restoredAtMs: number;
}

function syncBase(): string {
  return resolveSyncBase().trim().replace(/\/$/, "");
}

async function readJsonOrThrow<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`${ctx}: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function createNoteCheckpoint(
  noteId: string,
  opts: { label?: string } = {},
): Promise<{ checkpoint: CheckpointMetadata; deduped: boolean }> {
  const base = syncBase();
  const body: Record<string, unknown> = {};
  if (opts.label && opts.label.trim().length > 0) {
    body.label = opts.label.trim();
  }
  const res = await authedFetch({
    method: "POST",
    url: `${base}/wpn/notes/${noteId}/checkpoints`,
    headersWithoutAuth: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await readJsonOrThrow<{
    checkpoint: CheckpointMetadata;
    deduped?: boolean;
  }>(res, "createNoteCheckpoint");
  return { checkpoint: json.checkpoint, deduped: json.deduped === true };
}

export async function listNoteCheckpoints(
  noteId: string,
): Promise<CheckpointMetadata[]> {
  const base = syncBase();
  const res = await authedFetch({
    method: "GET",
    url: `${base}/wpn/notes/${noteId}/checkpoints`,
    headersWithoutAuth: {},
  });
  const json = await readJsonOrThrow<{ checkpoints: CheckpointMetadata[] }>(
    res,
    "listNoteCheckpoints",
  );
  return json.checkpoints;
}

export async function patchNoteCheckpoint(
  noteId: string,
  checkpointId: string,
  patch: { label?: string | null; pinned?: boolean },
): Promise<CheckpointMetadata> {
  const base = syncBase();
  const body: Record<string, unknown> = {};
  if (patch.label !== undefined) {
    body.label =
      patch.label === null || patch.label.trim().length === 0
        ? null
        : patch.label.trim();
  }
  if (patch.pinned !== undefined) body.pinned = patch.pinned;
  const res = await authedFetch({
    method: "PATCH",
    url: `${base}/wpn/notes/${noteId}/checkpoints/${checkpointId}`,
    headersWithoutAuth: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await readJsonOrThrow<{ checkpoint: CheckpointMetadata }>(
    res,
    "patchNoteCheckpoint",
  );
  return json.checkpoint;
}

export async function deleteNoteCheckpoint(
  noteId: string,
  checkpointId: string,
): Promise<void> {
  const base = syncBase();
  const res = await authedFetch({
    method: "DELETE",
    url: `${base}/wpn/notes/${noteId}/checkpoints/${checkpointId}`,
    headersWithoutAuth: {},
  });
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `deleteNoteCheckpoint: HTTP ${res.status}${body ? ` — ${body}` : ""}`,
    );
  }
}

export async function restoreNoteCheckpoint(
  noteId: string,
  checkpointId: string,
  opts: { snapshotBeforeRestore?: boolean; preRestoreLabel?: string } = {},
): Promise<RestoreResult> {
  const base = syncBase();
  const body: Record<string, unknown> = {};
  if (opts.snapshotBeforeRestore === false) {
    body.snapshotBeforeRestore = false;
  }
  if (opts.preRestoreLabel && opts.preRestoreLabel.trim().length > 0) {
    body.preRestoreLabel = opts.preRestoreLabel.trim();
  }
  const res = await authedFetch({
    method: "POST",
    url: `${base}/wpn/notes/${noteId}/checkpoints/${checkpointId}/restore`,
    headersWithoutAuth: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<RestoreResult>(res, "restoreNoteCheckpoint");
}
