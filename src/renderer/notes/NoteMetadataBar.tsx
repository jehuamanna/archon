import React from "react";

export type NoteAuthor = {
  userId: string;
  email: string;
  displayName: string | null;
};

export type NoteMetadataBarProps = {
  createdAtMs: number;
  updatedAtMs: number;
  createdBy?: NoteAuthor | null;
  updatedBy?: NoteAuthor | null;
};

const wrap =
  "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-3 py-1 text-[11px] text-muted-foreground";
const item = "inline-flex items-center gap-1";
const dot = "opacity-50";

function authorLabel(a: NoteAuthor | null | undefined): string {
  if (!a) return "Unknown";
  return a.displayName ?? a.email;
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

/**
 * Phase 6 — small metadata strip rendered above note content. Surfaces
 * Created/Updated authorship + relative timestamps. Hover reveals email.
 */
export function NoteMetadataBar({
  createdAtMs,
  updatedAtMs,
  createdBy,
  updatedBy,
}: NoteMetadataBarProps): React.ReactElement {
  return (
    <div className={wrap}>
      <span className={item} title={createdBy?.email ?? undefined}>
        <span>Created by</span>
        <strong className="text-foreground">{authorLabel(createdBy)}</strong>
        <span className={dot}>·</span>
        <time dateTime={new Date(createdAtMs).toISOString()}>
          {relativeTime(createdAtMs)}
        </time>
      </span>
      {updatedAtMs > createdAtMs ? (
        <span className={item} title={updatedBy?.email ?? undefined}>
          <span>Updated by</span>
          <strong className="text-foreground">{authorLabel(updatedBy)}</strong>
          <span className={dot}>·</span>
          <time dateTime={new Date(updatedAtMs).toISOString()}>
            {relativeTime(updatedAtMs)}
          </time>
        </span>
      ) : null}
    </div>
  );
}
