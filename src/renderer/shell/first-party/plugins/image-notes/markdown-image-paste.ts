import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { AppDispatch } from "../../../../store";
import { patchNoteMetadata } from "../../../../store/notesSlice";
import { markdownVfsNoteHrefSameProjectRelative } from "../../../../../shared/note-vfs-path";
import { createChildImageNote, deriveImageNoteTitle } from "./upload-image-asset";

export type ImagePasteToast = (args: {
  severity: "info" | "error";
  message: string;
}) => void;

type PlaceholderMark = {
  id: string;
  from: number;
  to: number;
};

const setPlaceholders = StateEffect.define<PlaceholderMark[]>();

/**
 * Tracks placeholder ranges (`![Uploading…](#uploading-<id>)`) so we can
 * rewrite them when the upload resolves. Ranges auto-shift as the user
 * keeps typing around them.
 */
const placeholderField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setPlaceholders)) {
        next = Decoration.set(
          effect.value.map((m) =>
            Decoration.mark({ class: "cm-image-paste-placeholder", attributes: { "data-id": m.id } }).range(m.from, m.to),
          ),
          true,
        );
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function placeholderTextFor(id: string): string {
  return `![Uploading…](#uploading-${id})`;
}

function extractImageFiles(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  const out: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    if (!item.type.startsWith("image/")) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/**
 * Drag payload → image `File[]`. Mirrors the explorer's file-drop logic:
 * prefer `dataTransfer.files` (OS file drag), fall back to fetching
 * entries in `text/uri-list` (webpage image drag).
 */
async function extractImageFilesFromDrop(dt: DataTransfer): Promise<File[]> {
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
      /* skip — a single URL failure shouldn't block the others */
    }
  }
  return out;
}

function locatePlaceholder(view: EditorView, id: string): { from: number; to: number } | null {
  const text = view.state.doc.toString();
  const needle = placeholderTextFor(id);
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  return { from: idx, to: idx + needle.length };
}

export type ImagePasteContext = {
  readOnly: boolean;
  parentNoteId: string;
  /** Optional: skip `/wpn/notes-with-context` round-trip if caller already has it. */
  projectId?: string | null;
  dispatch: AppDispatch;
  showToast: ImagePasteToast;
};

/**
 * Shared insertion pipeline for both paste and drop: inserts one
 * placeholder per file at `insertAt`, then kicks off the uploads. On
 * each success the placeholder is rewritten to a vFS reference; on
 * failure it's removed and the user gets a toast.
 */
function insertImagesAndUpload(
  view: EditorView,
  files: File[],
  insertAt: number,
  ctx: ImagePasteContext,
): void {
  const pos = Math.max(0, Math.min(insertAt, view.state.doc.length));
  const atLineStart = pos === 0 || view.state.doc.sliceString(pos - 1, pos) === "\n";
  const lineBreakBefore = atLineStart ? "" : "\n";

  let accumulated = "";
  const marks: PlaceholderMark[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const id = (globalThis.crypto?.randomUUID?.() ?? `p-${Date.now()}-${i}`).replace(/-/g, "").slice(0, 12);
    const prefix = i === 0 ? lineBreakBefore : "";
    const suffix = i === files.length - 1 ? "\n" : "\n\n";
    const placeholder = placeholderTextFor(id);
    const segment = `${prefix}${placeholder}${suffix}`;
    const markFrom = pos + accumulated.length + prefix.length;
    const markTo = markFrom + placeholder.length;
    marks.push({ id, from: markFrom, to: markTo });
    accumulated += segment;
  }

  view.dispatch({
    changes: { from: pos, to: pos, insert: accumulated },
    selection: { anchor: pos + accumulated.length },
    effects: setPlaceholders.of(marks),
    scrollIntoView: true,
  });

  files.forEach((file, i) => {
    const mark = marks[i];
    if (!mark) return;
    void (async () => {
      try {
        const { noteId: childNoteId, metadata } = await createChildImageNote({
          parentNoteId: ctx.parentNoteId,
          projectId: ctx.projectId ?? undefined,
          file,
        });
        await ctx.dispatch(
          patchNoteMetadata({
            noteId: childNoteId,
            patch: metadata as unknown as Record<string, unknown>,
          }),
        ).unwrap();
        const title = deriveImageNoteTitle(file.name);
        const href = markdownVfsNoteHrefSameProjectRelative(title);
        const replacement = `![${title}](${href})`;
        const loc = locatePlaceholder(view, mark.id);
        if (loc) {
          view.dispatch({
            changes: { from: loc.from, to: loc.to, insert: replacement },
          });
        }
      } catch (err) {
        const loc = locatePlaceholder(view, mark.id);
        if (loc) {
          const docLen = view.state.doc.length;
          const expandedTo = loc.to < docLen && view.state.doc.sliceString(loc.to, loc.to + 1) === "\n"
            ? loc.to + 1
            : loc.to;
          const expandedFrom = loc.from > 0 && view.state.doc.sliceString(loc.from - 1, loc.from) === "\n"
            ? loc.from - 1
            : loc.from;
          view.dispatch({
            changes: { from: expandedFrom, to: expandedTo, insert: "" },
          });
        }
        ctx.showToast({
          severity: "error",
          message: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();
  });
}

/**
 * CodeMirror extension that intercepts pastes and drops containing
 * `image/*` payloads, inserts an `![Uploading…](…)` placeholder at the
 * caret (paste) or drop point (drop), creates a child image note via
 * the sync API, uploads the blob, and rewrites the placeholder to a
 * vFS reference on success.
 *
 * Non-image pastes/drops (plain text, HTML, wiki-link triggers) fall
 * through to CodeMirror's default handling — critical for avoiding the
 * paste regression risk called out in Risks 1.5.
 */
export function createImagePasteExtension(ctxRef: {
  current: ImagePasteContext;
}): Extension {
  return [
    placeholderField,
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const files = extractImageFiles(event);
        if (files.length === 0) return false;

        const ctx = ctxRef.current;
        event.preventDefault();

        if (ctx.readOnly) {
          ctx.showToast({
            severity: "info",
            message: "This note is read-only — open the containing project to upload images.",
          });
          return true;
        }

        insertImagesAndUpload(view, files, view.state.selection.main.head, ctx);
        return true;
      },
      dragover: (event) => {
        const types = event.dataTransfer?.types;
        if (!types) return false;
        const hasFiles = Array.from(types).includes("Files");
        const hasUriList = Array.from(types).includes("text/uri-list");
        if (!hasFiles && !hasUriList) return false;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        return true;
      },
      drop: (event, view) => {
        const dt = event.dataTransfer;
        if (!dt) return false;
        const types = Array.from(dt.types);
        const hasFiles = types.includes("Files");
        const hasUriList = types.includes("text/uri-list");
        if (!hasFiles && !hasUriList) return false;

        const ctx = ctxRef.current;
        event.preventDefault();

        if (ctx.readOnly) {
          ctx.showToast({
            severity: "info",
            message: "This note is read-only — open the containing project to upload images.",
          });
          return true;
        }

        const dropPos =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;

        void (async () => {
          const files = await extractImageFilesFromDrop(dt);
          if (files.length === 0) {
            ctx.showToast({
              severity: "info",
              message: "No supported image in the drop payload.",
            });
            return;
          }
          insertImagesAndUpload(view, files, dropPos, ctx);
        })();
        return true;
      },
    }),
    EditorView.baseTheme({
      ".cm-image-paste-placeholder": {
        opacity: "0.6",
      },
    }),
  ];
}
