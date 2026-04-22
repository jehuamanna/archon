import React, { useEffect, useState } from "react";
import type { Note } from "@archon/ui-types";
import { parseInternalMarkdownNoteLink } from "../../../../../shared/markdown-internal-note-href";
import { useSignedAssetUrl } from "./useSignedAssetUrl";
import { resolveNoteScope } from "./upload-image-asset";
import { getArchon } from "../../../../../shared/archon-host-access";
import { createSyncBaseUrlResolver } from "@archon/platform";
import { readCloudSyncToken } from "../../../../cloud-sync/cloud-sync-storage";

const resolveSyncBaseInternal = createSyncBaseUrlResolver();

type VfsImageTarget = {
  noteId: string;
  r2Key: string;
  thumbKey: string | null;
};

type VfsNotesWithContextRow = {
  id: string;
  title: string;
  type: string;
  workspace_id: string;
  workspace_name: string;
  project_id: string;
  project_name: string;
};

type ParsedVfsTarget =
  | { mode: "same-project"; title: string }
  | { mode: "canonical"; workspace: string; project: string; title: string };

/**
 * Markdown `<img>` override that resolves `#/w/...` hrefs pointing at
 * image notes to a signed R2 URL. Non-vFS hrefs fall through to the
 * default `<img>` tag (react-markdown's rehype-sanitize has already
 * vetted the scheme).
 *
 * Placeholder `#uploading-…` hrefs (emitted by the paste handler while
 * the upload is in flight) render as a small loading badge so the
 * user sees progress without a broken-image icon.
 *
 * When `inline` is true (markdown preview), prefers `metadata.thumbKey`
 * over `r2Key` so the preview pane stays cheap. Full-resolution viewing
 * happens by clicking through to the image note's editor tab.
 */
export function WpnVfsImage({
  src,
  alt,
  currentNote,
  inline = true,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement> & {
  currentNote: Note;
  inline?: boolean;
}): React.ReactElement {
  const srcStr = String(src ?? "").trim();

  if (srcStr.startsWith("#uploading-") || srcStr.includes("#uploading-")) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 align-middle text-[11px] text-muted-foreground">
        Uploading {alt ? `“${alt}”` : "image"}…
      </span>
    );
  }

  const parsed = parseInternalMarkdownNoteLink(srcStr);
  if (parsed?.kind === "vfs") {
    return (
      <WpnVfsImageInner
        vfsPath={parsed.vfsPath}
        alt={alt}
        currentNote={currentNote}
        inline={inline}
        rest={rest}
      />
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/img-redundant-alt
    <img src={src} alt={alt ?? ""} loading="lazy" className="my-2 max-w-full rounded" {...rest} />
  );
}

function WpnVfsImageInner({
  vfsPath,
  alt,
  currentNote,
  inline,
  rest,
}: {
  vfsPath: string;
  alt: string | undefined;
  currentNote: Note;
  inline: boolean;
  rest: React.ImgHTMLAttributes<HTMLImageElement>;
}): React.ReactElement {
  const [resolved, setResolved] = useState<
    | { kind: "loading" }
    | { kind: "image"; target: VfsImageTarget }
    | { kind: "notfound" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const parsed = parseVfsTargetFromPath(vfsPath);
        if (!parsed) {
          if (!cancelled) setResolved({ kind: "notfound" });
          return;
        }
        const scope = await resolveNoteScope(currentNote.id);
        const base = resolveSyncBaseInternal().trim().replace(/\/$/, "");
        const token = readCloudSyncToken();
        if (!base || !token) {
          if (!cancelled) setResolved({ kind: "notfound" });
          return;
        }
        const res = await fetch(`${base}/wpn/notes-with-context`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          credentials: "omit",
        });
        if (!res.ok) {
          if (!cancelled) setResolved({ kind: "notfound" });
          return;
        }
        const json = (await res.json()) as { notes?: VfsNotesWithContextRow[] };
        const rows = json.notes ?? [];
        const match = findImageNoteMatch(rows, parsed, scope.projectId);
        if (!match) {
          if (!cancelled) setResolved({ kind: "notfound" });
          return;
        }
        const detail = await getArchon().getNote(match.id);
        const meta = detail?.metadata as Record<string, unknown> | null | undefined;
        const r2Key = typeof meta?.r2Key === "string" ? meta.r2Key : null;
        if (!r2Key) {
          if (!cancelled) setResolved({ kind: "notfound" });
          return;
        }
        const thumbKey = typeof meta?.thumbKey === "string" ? meta.thumbKey : null;
        if (!cancelled) {
          setResolved({
            kind: "image",
            target: { noteId: match.id, r2Key, thumbKey },
          });
        }
      } catch {
        if (!cancelled) setResolved({ kind: "notfound" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentNote.id, vfsPath]);

  const preferredKey =
    resolved.kind === "image"
      ? inline && resolved.target.thumbKey
        ? resolved.target.thumbKey
        : resolved.target.r2Key
      : null;
  const signed = useSignedAssetUrl(preferredKey);

  if (resolved.kind === "loading" || signed.status === "loading") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 align-middle text-[11px] text-muted-foreground">
        Loading {alt ? `“${alt}”` : "image"}…
      </span>
    );
  }

  if (resolved.kind === "notfound" || signed.status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 align-middle text-[11px] text-muted-foreground">
        [image not found: {alt ?? vfsPath}]
      </span>
    );
  }

  if (signed.status === "ready" && resolved.kind === "image") {
    const img = (
      // eslint-disable-next-line jsx-a11y/img-redundant-alt
      <img
        src={signed.url}
        alt={alt ?? ""}
        loading="lazy"
        className="my-2 max-w-full rounded"
        {...rest}
      />
    );
    if (inline) {
      return (
        <a
          href={`#/n/${resolved.target.noteId}`}
          className="inline-block"
          title={alt ?? undefined}
        >
          {img}
        </a>
      );
    }
    return img;
  }

  return <span />;
}

/**
 * `./foo` → `{ mode: "same-project", title: "foo" }`.
 * `Workspace/Project/Title` → `{ mode: "canonical", workspace, project, title }`.
 * `Title` alone → `{ mode: "same-project", title: "Title" }` (legacy shape).
 */
function parseVfsTargetFromPath(vfsPath: string): ParsedVfsTarget | null {
  const trimmed = vfsPath.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("./")) {
    const first = trimmed.slice(2).split("/")[0]?.trim();
    return first ? { mode: "same-project", title: decodeURIComponent(first) } : null;
  }
  const segments = trimmed.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.length >= 3) {
    return {
      mode: "canonical",
      workspace: decodeURIComponent(segments[0]),
      project: decodeURIComponent(segments[1]),
      title: decodeURIComponent(segments[2]),
    };
  }
  if (segments.length === 1) {
    return { mode: "same-project", title: decodeURIComponent(segments[0]) };
  }
  return null;
}

function findImageNoteMatch(
  rows: VfsNotesWithContextRow[],
  parsed: ParsedVfsTarget,
  sameProjectId: string,
): VfsNotesWithContextRow | null {
  const lower = (s: string | undefined) => s?.trim().toLowerCase() ?? "";
  const titleNeedle = lower(parsed.title);
  if (parsed.mode === "same-project") {
    return (
      rows.find(
        (n) =>
          n.project_id === sameProjectId &&
          n.type === "image" &&
          lower(n.title) === titleNeedle,
      ) ?? null
    );
  }
  const wsNeedle = lower(parsed.workspace);
  const projNeedle = lower(parsed.project);
  return (
    rows.find(
      (n) =>
        n.type === "image" &&
        lower(n.workspace_name) === wsNeedle &&
        lower(n.project_name) === projNeedle &&
        lower(n.title) === titleNeedle,
    ) ?? null
  );
}
