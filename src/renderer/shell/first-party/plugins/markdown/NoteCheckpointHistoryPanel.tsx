/**
 * Side panel that lists a note's checkpoints, previews them, and restores.
 * Mounted next to the editor flex row in MarkdownNoteEditor / MdxNoteEditor.
 *
 * Restore semantics:
 *   - Confirmation via `useArchonDialog().confirm`.
 *   - Default behaviour: server creates a pre-restore auto-checkpoint so the
 *     toast's "Undo" link can revert. The Undo path itself runs another
 *     restore with `snapshotBeforeRestore: false` (no point auto-snapping
 *     state we just clobbered).
 *   - Live editors auto-update via Hocuspocus broadcast — no imperative
 *     refresh needed here. The restore origin isn't any user's YSyncConfig
 *     so per-user Y.UndoManager (#4 fix) won't retract it via Cmd-Z.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Note } from "@archon/ui-types";
import { useToast } from "../../../../toast/ToastContext";
import { useArchonDialog } from "../../../../dialog/ArchonDialogProvider";
import MarkdownRenderer from "../../../../components/renderers/MarkdownRenderer";
import {
  deleteNoteCheckpoint,
  listNoteCheckpoints,
  patchNoteCheckpoint,
  restoreNoteCheckpoint,
  type CheckpointMetadata,
} from "./note-checkpoints-api";

export interface NoteCheckpointHistoryPanelProps {
  note: Note;
  onClose: () => void;
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function authorLabel(cp: CheckpointMetadata): string {
  if (cp.createdByDisplayName) return cp.createdByDisplayName;
  if (cp.createdByEmail) return cp.createdByEmail.split("@")[0];
  return "unknown";
}

export function NoteCheckpointHistoryPanel({
  note,
  onClose,
}: NoteCheckpointHistoryPanelProps): React.ReactElement {
  const [rows, setRows] = useState<CheckpointMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const { showToast } = useToast();
  const { confirm } = useArchonDialog();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listNoteCheckpoints(note.id);
      setRows(list);
      if (list.length > 0 && !list.find((r) => r.id === selectedId)) {
        setSelectedId(list[0].id);
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to load checkpoints");
    } finally {
      setLoading(false);
    }
  }, [note.id, selectedId]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  const previewNote: Note | null = useMemo(() => {
    if (!selected) return null;
    return {
      ...note,
      content: selected.contentText,
    };
  }, [note, selected]);

  const doRestore = useCallback(
    async (
      checkpointId: string,
      opts: { snapshotBeforeRestore: boolean },
    ): Promise<void> => {
      setRestoring(true);
      try {
        const result = await restoreNoteCheckpoint(note.id, checkpointId, opts);
        // Re-fetch list so the new pre-restore auto-checkpoint shows up at
        // the top. Live editor content updates via Hocuspocus on its own.
        await refresh();
        const undoTarget = result.preRestoreCheckpointId;
        showToast({
          severity: "info",
          message: undoTarget
            ? "Restored. Open history to undo."
            : "Restored.",
        });
      } catch (err) {
        showToast({
          severity: "error",
          message: `Restore failed: ${(err as Error).message ?? "unknown error"}`,
        });
      } finally {
        setRestoring(false);
      }
    },
    [note.id, refresh, showToast],
  );

  const onRestoreClick = useCallback(async (): Promise<void> => {
    if (!selected) return;
    const labelStr = selected.label
      ? `“${selected.label}”`
      : `from ${relativeTime(selected.createdAtMs)}`;
    const ok = await confirm({
      title: "Restore checkpoint",
      message: `Replace the current note with the checkpoint ${labelStr}?`,
      detail:
        "An auto-snapshot of the current state is saved first so this can be undone.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    await doRestore(selected.id, { snapshotBeforeRestore: true });
  }, [selected, confirm, doRestore]);

  const onTogglePin = useCallback(async (): Promise<void> => {
    if (!selected) return;
    try {
      const updated = await patchNoteCheckpoint(note.id, selected.id, {
        pinned: !selected.pinned,
      });
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      showToast({
        severity: "error",
        message: `Failed to ${selected.pinned ? "unpin" : "pin"}: ${
          (err as Error).message ?? "unknown error"
        }`,
      });
    }
  }, [note.id, selected, showToast]);

  const onDeleteClick = useCallback(async (): Promise<void> => {
    if (!selected) return;
    const labelStr = selected.label
      ? `“${selected.label}”`
      : `from ${relativeTime(selected.createdAtMs)}`;
    const ok = await confirm({
      title: "Delete checkpoint",
      message: `Permanently delete the checkpoint ${labelStr}?`,
      detail: selected.pinned
        ? "This checkpoint is pinned. Deleting still removes it permanently."
        : undefined,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await deleteNoteCheckpoint(note.id, selected.id);
      setRows((prev) => {
        const next = prev.filter((r) => r.id !== selected.id);
        // Keep something sensible selected: next row down, or top of list.
        if (next.length > 0) {
          const idx = prev.findIndex((r) => r.id === selected.id);
          const nextSel = next[Math.min(idx, next.length - 1)];
          setSelectedId(nextSel.id);
        } else {
          setSelectedId(null);
        }
        return next;
      });
    } catch (err) {
      showToast({
        severity: "error",
        message: `Delete failed: ${(err as Error).message ?? "unknown error"}`,
      });
    }
  }, [note.id, selected, confirm, showToast]);

  return (
    <div className="flex min-h-[240px] min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-background md:max-w-sm">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          History
        </span>
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          onClick={onClose}
          aria-label="Close history"
        >
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border">
          {loading ? (
            <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
              Loading…
            </p>
          ) : error ? (
            <p className="px-3 py-4 text-center text-[12px] text-destructive">
              {error}
            </p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
              No checkpoints yet. Use the “Checkpoint” button to save one.
            </p>
          ) : (
            <ul className="space-y-0.5 p-1" role="listbox">
              {rows.map((r) => {
                const isSel = r.id === selectedId;
                return (
                  <li key={r.id} role="none">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      className={`w-full rounded-md px-2 py-2 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        isSel
                          ? "bg-muted/60 text-foreground"
                          : "hover:bg-muted/40 text-foreground"
                      }`}
                      onClick={() => setSelectedId(r.id)}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="flex min-w-0 items-baseline gap-1.5 truncate">
                          {r.pinned ? (
                            <span
                              className="text-[10px] text-amber-600 dark:text-amber-400"
                              title="Pinned (excluded from auto-prune)"
                              aria-label="Pinned"
                            >
                              📌
                            </span>
                          ) : null}
                          <span className="truncate font-medium">
                            {r.label && r.label.length > 0
                              ? r.label
                              : relativeTime(r.createdAtMs)}
                          </span>
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {r.label ? relativeTime(r.createdAtMs) : ""}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                        <span className="truncate">by {authorLabel(r)}</span>
                        <span className="shrink-0">
                          {(r.sizeBytes / 1024).toFixed(1)} KB
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Preview
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted/40 disabled:opacity-50"
                onClick={() => void onTogglePin()}
                disabled={!selected || restoring}
                title={
                  selected?.pinned
                    ? "Unpin (allows auto-prune)"
                    : "Pin (excludes from auto-prune)"
                }
              >
                {selected?.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                onClick={() => void onDeleteClick()}
                disabled={!selected || restoring}
                title="Delete this checkpoint"
              >
                Delete
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted/40 disabled:opacity-50"
                onClick={() => void onRestoreClick()}
                disabled={!selected || restoring}
              >
                {restoring ? "Restoring…" : "Restore"}
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {previewNote ? (
              <MarkdownRenderer note={previewNote} />
            ) : (
              <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                Select a checkpoint to preview.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
