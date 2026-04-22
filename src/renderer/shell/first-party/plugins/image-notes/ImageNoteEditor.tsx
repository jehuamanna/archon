import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import type { Note } from "@archon/ui-types";
import type { AppDispatch } from "../../../../store";
import { patchNoteMetadata } from "../../../../store/notesSlice";
import { useSignedAssetUrl } from "./useSignedAssetUrl";
import { uploadImageAsset } from "./upload-image-asset";
import { ImageViewerSurface } from "./ImageViewerSurface";
import { generateImageThumbnail, THUMBNAIL_CONSTANTS } from "./generate-thumbnail";
import { getArchon } from "../../../../../shared/archon-host-access";
import type { WpnBacklinkSourceItem } from "../../../../../shared/wpn-v2-types";
import { dispatchWpnTreeChanged } from "../notes-explorer/wpnExplorerEvents";

type ImageMetadata = {
  metadataVersion: 1;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  originalFilename?: string;
  thumbKey?: string;
  thumbMime?: string;
  thumbSizeBytes?: number;
  altText?: string;
  caption?: string;
};

function readImageMetadata(note: Note): ImageMetadata | null {
  const m = (note.metadata ?? null) as Record<string, unknown> | null;
  if (!m) return null;
  const r2Key = typeof m.r2Key === "string" ? m.r2Key : null;
  const mimeType = typeof m.mimeType === "string" ? m.mimeType : null;
  const sizeBytes = typeof m.sizeBytes === "number" ? m.sizeBytes : null;
  if (!r2Key || !mimeType || sizeBytes == null) return null;
  return {
    metadataVersion: 1,
    r2Key,
    mimeType,
    sizeBytes,
    width: typeof m.width === "number" ? m.width : undefined,
    height: typeof m.height === "number" ? m.height : undefined,
    originalFilename: typeof m.originalFilename === "string" ? m.originalFilename : undefined,
    thumbKey: typeof m.thumbKey === "string" ? m.thumbKey : undefined,
    thumbMime: typeof m.thumbMime === "string" ? m.thumbMime : undefined,
    thumbSizeBytes: typeof m.thumbSizeBytes === "number" ? m.thumbSizeBytes : undefined,
    altText: typeof m.altText === "string" ? m.altText : undefined,
    caption: typeof m.caption === "string" ? m.caption : undefined,
  };
}

async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const direct = Array.from(dt.files ?? []).filter(
    (f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name),
  );
  if (direct.length > 0) return direct;
  const uriList = dt.getData("text/uri-list");
  if (!uriList.trim()) return [];
  const urls = uriList
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const out: File[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) continue;
      const filename = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "image";
      out.push(new File([blob], filename, { type: blob.type }));
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * PLAN-06 slice 4d: regenerate a missing thumbnail client-side.
 *
 * Fires once per (noteId, r2Key) pair when `r2Key` is set but `thumbKey`
 * is missing — covers pre-PLAN-04 image notes and fresh post-import
 * notes whose thumbKey was dropped during the v2 import re-upload.
 * No-ops when the note is read-only, when the signed URL hasn't arrived
 * yet, or when the same pair has already been processed this session.
 */
function useThumbnailRegen(args: {
  noteId: string;
  r2Key: string | null;
  thumbKey: string | null;
  signedUrl: string | null;
  persist: boolean;
}): void {
  const { noteId, r2Key, thumbKey, signedUrl, persist } = args;
  const dispatch = useDispatch<AppDispatch>();
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!persist) return;
    if (!r2Key || thumbKey) return;
    if (!signedUrl) return;
    const pairKey = `${noteId}::${r2Key}`;
    if (pendingRef.current === pairKey) return;
    pendingRef.current = pairKey;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(signedUrl, { credentials: "omit" });
        if (!resp.ok) {
          throw new Error(`Fetch failed: ${resp.status}`);
        }
        const blob = await resp.blob();
        const file = new File([blob], "source", { type: blob.type });
        const thumb = await generateImageThumbnail(file);
        if (cancelled) return;
        const thumbFile = new File(
          [thumb.blob],
          `regen.thumb.${THUMBNAIL_CONSTANTS.MIME.split("/")[1] ?? "webp"}`,
          { type: thumb.mime },
        );
        const up = await uploadImageAsset({
          noteId,
          file: thumbFile,
          variant: "thumb",
        });
        if (cancelled) return;
        await dispatch(
          patchNoteMetadata({
            noteId,
            patch: {
              thumbKey: up.r2Key,
              thumbMime: up.mimeType,
              thumbSizeBytes: up.sizeBytes,
              width: thumb.sourceWidth,
              height: thumb.sourceHeight,
            },
          }),
        ).unwrap();
      } catch (err) {
        if (pendingRef.current === pairKey) pendingRef.current = null;
        console.warn(
          "[image-notes] on-open thumbnail regen failed; continuing",
          err,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, r2Key, thumbKey, signedUrl, persist, dispatch]);
}

export function ImageNoteEditor({
  note,
  persist,
}: {
  note: Note;
  persist: boolean;
}): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const existing = useMemo(() => readImageMetadata(note), [note]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const signed = useSignedAssetUrl(existing?.r2Key ?? null);

  useThumbnailRegen({
    noteId: note.id,
    r2Key: existing?.r2Key ?? null,
    thumbKey: existing?.thumbKey ?? null,
    signedUrl: signed.status === "ready" ? signed.url : null,
    persist,
  });

  const uploadOne = useCallback(
    async (file: File) => {
      if (!persist) {
        setUploadError("This note is read-only.");
        return;
      }
      setUploading(true);
      setUploadError(null);
      try {
        const result = await uploadImageAsset({ noteId: note.id, file });
        const patch: ImageMetadata = {
          metadataVersion: 1,
          r2Key: result.r2Key,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          originalFilename: result.originalFilename,
        };
        await dispatch(
          patchNoteMetadata({ noteId: note.id, patch: patch as Record<string, unknown> }),
        ).unwrap();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [dispatch, note.id, persist],
  );

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file) return;
      await uploadOne(file);
    },
    [uploadOne],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!persist || uploading) return;
      const types = e.dataTransfer.types;
      if (!types.includes("Files") && !types.includes("text/uri-list")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropHover(true);
    },
    [persist, uploading],
  );

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const rel = e.relatedTarget as Node | null;
    const cur = e.currentTarget as HTMLElement;
    if (rel && cur.contains(rel)) return;
    setDropHover(false);
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDropHover(false);
      if (!persist || uploading) return;
      const files = await filesFromDrop(e.dataTransfer);
      if (files.length === 0) {
        setUploadError("No supported image in the drop payload.");
        return;
      }
      await uploadOne(files[0]);
    },
    [persist, uploading, uploadOne],
  );

  if (existing) {
    const altForViewer =
      existing.altText && existing.altText.trim().length > 0
        ? existing.altText
        : (existing.originalFilename ?? note.title);
    return (
      <div className="flex h-full w-full flex-col">
        <div className="min-h-0 flex-1">
          {signed.status === "ready" ? (
            <ImageViewerSurface src={signed.url} alt={altForViewer} />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted/20 p-4">
              {signed.status === "loading" && (
                <p className="text-sm text-muted-foreground">Loading image…</p>
              )}
              {signed.status === "error" && (
                <p className="text-sm text-destructive">Failed to load: {signed.error}</p>
              )}
            </div>
          )}
        </div>
        <ImageMetadataStrip
          noteId={note.id}
          altText={existing.altText ?? ""}
          caption={existing.caption ?? ""}
          disabled={!persist}
        />
        <ImageBacklinksRow noteId={note.id} />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div
        className={`w-full max-w-md rounded-sm border border-dashed p-6 text-center transition-colors ${
          dropHover ? "border-primary bg-primary/10" : "border-border bg-muted/20"
        }`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
      >
        <p className="text-sm font-medium text-foreground">
          {uploading
            ? "Uploading…"
            : dropHover
              ? "Drop to upload"
              : "Upload an image"}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          PNG, JPEG, GIF, or WebP — up to 25 MiB. Drop a file here or use the button.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          onChange={(e) => void onFiles(e.currentTarget.files)}
          disabled={uploading || !persist}
          data-testid="image-note-file-input"
        />
        <button
          type="button"
          className="mt-4 rounded-sm border border-border bg-background px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          disabled={uploading || !persist}
          onClick={() => inputRef.current?.click()}
        >
          Choose file
        </button>
        {uploadError && (
          <p className="mt-3 text-xs text-destructive">{uploadError}</p>
        )}
      </div>
    </div>
  );
}

function ImageMetadataStrip({
  noteId,
  altText,
  caption,
  disabled,
}: {
  noteId: string;
  altText: string;
  caption: string;
  disabled: boolean;
}): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const [altDraft, setAltDraft] = useState(altText);
  const [captionDraft, setCaptionDraft] = useState(caption);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the persisted value changes from outside (e.g. sync from another tab).
  const lastPersistedAlt = useRef(altText);
  const lastPersistedCaption = useRef(caption);
  if (lastPersistedAlt.current !== altText) {
    lastPersistedAlt.current = altText;
    setAltDraft(altText);
  }
  if (lastPersistedCaption.current !== caption) {
    lastPersistedCaption.current = caption;
    setCaptionDraft(caption);
  }

  const persistField = useCallback(
    async (key: "altText" | "caption", next: string, previous: string) => {
      if (next === previous) return;
      const trimmed = next.trim();
      try {
        await dispatch(
          patchNoteMetadata({
            noteId,
            patch: { [key]: trimmed.length === 0 ? undefined : trimmed } as Record<string, unknown>,
          }),
        ).unwrap();
        setError(null);
        // Explorer's flat note list carries server-built `search_hints` (alt/caption) used
        // by the sidebar filter. Without a refresh it keeps the pre-edit snapshot and the
        // search misses this note — nudge it to refetch.
        dispatchWpnTreeChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [dispatch, noteId],
  );

  return (
    <div className="border-t border-border bg-muted/10 p-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Alt text
          <input
            type="text"
            value={altDraft}
            disabled={disabled}
            placeholder="Short description for screen readers and search"
            className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50"
            onChange={(e) => setAltDraft(e.currentTarget.value)}
            onBlur={() => void persistField("altText", altDraft, altText)}
            data-testid="image-note-alt-text-input"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Caption
          <input
            type="text"
            value={captionDraft}
            disabled={disabled}
            placeholder="Optional longer caption"
            className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50"
            onChange={(e) => setCaptionDraft(e.currentTarget.value)}
            onBlur={() => void persistField("caption", captionDraft, caption)}
            data-testid="image-note-caption-input"
          />
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ImageBacklinksRow({
  noteId,
}: {
  noteId: string;
}): React.ReactElement {
  const [backlinks, setBacklinks] = useState<WpnBacklinkSourceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBacklinks(null);
    void (async () => {
      try {
        const archon = getArchon();
        if (!archon?.wpnListBacklinksToNote) {
          if (!cancelled) setBacklinks([]);
          return;
        }
        const { sources } = await archon.wpnListBacklinksToNote(noteId);
        if (!cancelled) setBacklinks(Array.isArray(sources) ? sources : []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setBacklinks([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  return (
    <div className="border-t border-border bg-muted/5 px-3 py-2 text-xs text-muted-foreground">
      <div className="mb-1 font-medium">Referenced by</div>
      {error ? (
        <div className="text-destructive">Could not load backlinks: {error}</div>
      ) : backlinks === null ? (
        <div>Loading…</div>
      ) : backlinks.length === 0 ? (
        <div>No notes reference this image yet.</div>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
          {backlinks.map((b) => (
            <li key={b.id}>
              <a
                href={`#/n/${b.id}`}
                className="text-foreground underline-offset-2 hover:underline"
                title={b.title}
              >
                {b.title.trim() || "Untitled"}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
