/**
 * Modal that captures an optional label and invokes the create-checkpoint
 * endpoint. The server snapshots the live Y.Doc on the backend — the label
 * is the only client-supplied input.
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createNoteCheckpoint,
  type CheckpointMetadata,
} from "./note-checkpoints-api";

export interface NoteCheckpointSaveModalProps {
  open: boolean;
  noteId: string;
  onClose: () => void;
  onSaved: (checkpoint: CheckpointMetadata, deduped: boolean) => void;
}

export function NoteCheckpointSaveModal({
  open,
  noteId,
  onClose,
  onSaved,
}: NoteCheckpointSaveModalProps): React.ReactElement | null {
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setLabel("");
      setError(null);
      setSaving(false);
      return;
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !saving) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const { checkpoint, deduped } = await createNoteCheckpoint(noteId, {
        label,
      });
      onSaved(checkpoint, deduped);
      onClose();
    } catch (err) {
      setError((err as Error).message ?? "Failed to save checkpoint");
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 p-4 pt-[18vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Save checkpoint"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="border-b border-border px-3 py-2.5">
          <p className="text-[13px] font-medium text-foreground">Save checkpoint</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Snapshots the current contents server-side. Restorable later from
            the history panel.
          </p>
        </div>
        <div className="px-3 py-3">
          <label className="block text-[11px] font-medium text-muted-foreground">
            Label{" "}
            <span className="text-muted-foreground/70">(optional)</span>
          </label>
          <input
            ref={inputRef}
            type="text"
            className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="e.g. before refactor"
            value={label}
            maxLength={200}
            onChange={(e) => setLabel(e.target.value)}
            disabled={saving}
          />
          {error ? (
            <p className="mt-2 text-[11px] text-destructive">{error}</p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md border border-border bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
