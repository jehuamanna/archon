import React, { type ReactNode } from "react";
import type {
  CreateNoteRelation,
  NoteListItem,
  NoteMovePlacement,
} from "@archon/ui-types";
import type { DropHint } from "../notes-sidebar/notes-sidebar-utils";
import { noteTypeInitials } from "../utils/note-type-initials";

const DND_NOTE_MIME = "application/x-archon-note-id";
const DND_NOTE_IDS_MIME = "application/x-archon-note-ids";

type Props = {
  /** Same as parent workspace section (which project this mount belongs to). */
  sectionKey: string;
  mount: NoteListItem;
  /** Match primary project header: folder label only, no type badge or tree indent. */
  plainHeader?: boolean;
  /** Shown when `plainHeader` (e.g. basename from disk path). */
  folderLabel?: ReactNode;
  draggingId: string | null;
  currentNoteId: string | undefined;
  selectedNoteIds: Set<string>;
  dropHint: DropHint | null;
  setDropHint: React.Dispatch<React.SetStateAction<DropHint | null>>;
  draggingRef: React.MutableRefObject<string | null>;
  draggingIdsRef: React.MutableRefObject<string[]>;
  setDraggingId: (id: string | null) => void;
  setDraggingBulkCount: (n: number) => void;
  parseDragIds: (e: React.DragEvent) => string[];
  placementFromPointer: (e: React.DragEvent, el: HTMLElement) => NoteMovePlacement;
  dropAllowedOne: (
    draggedId: string,
    targetId: string,
    placement: NoteMovePlacement,
  ) => boolean;
  dropAllowedMany: (
    draggedIds: string[],
    targetId: string,
    placement: NoteMovePlacement,
  ) => boolean;
  onMoveNote: (p: {
    draggedId: string;
    targetId: string;
    placement: NoteMovePlacement;
  }) => Promise<void>;
  onMoveNotesBulk: (p: {
    ids: string[];
    targetId: string;
    placement: NoteMovePlacement;
  }) => Promise<void>;
  handleRowClick: (noteId: string, e: React.MouseEvent<HTMLButtonElement>) => void;
  onNoteSelect: (noteId: string) => void;
  setMenu: React.Dispatch<
    React.SetStateAction<{
      x: number;
      y: number;
      anchorId: string | null;
      step: "main" | "pickType" | "pickMoveTarget";
      pickRelation?: CreateNoteRelation;
    } | null>
  >;
  getTypeBadgeClass: (type: string) => string;
  validNoteIds: Set<string>;
  onResyncNotes: () => void;
};

export default function WorkspaceMountHeaderSurface({
  sectionKey,
  mount,
  plainHeader = false,
  folderLabel,
  draggingId,
  currentNoteId,
  selectedNoteIds,
  dropHint,
  setDropHint,
  draggingRef,
  draggingIdsRef,
  setDraggingId,
  setDraggingBulkCount,
  parseDragIds,
  placementFromPointer,
  dropAllowedOne,
  dropAllowedMany,
  onMoveNote,
  onMoveNotesBulk,
  handleRowClick,
  onNoteSelect,
  setMenu,
  getTypeBadgeClass,
  validNoteIds,
  onResyncNotes,
}: Props) {
  const hint =
    dropHint?.targetId === mount.id &&
    dropHint?.sectionKey === sectionKey
      ? dropHint.placement
      : null;
  const primarySelected = currentNoteId === mount.id;
  const inMulti = selectedNoteIds.has(mount.id);
  const selected = primarySelected || inMulti;
  const pad = 6 + mount.depth * 12;
  const label = folderLabel ?? mount.title;
  const plainTitle =
    typeof folderLabel === "string"
      ? folderLabel
      : typeof mount.title === "string"
        ? mount.title
        : undefined;

  return (
    <div
      className={`relative min-w-0 flex-1 rounded-md transition-[box-shadow,background-color] duration-150 ${
        draggingId === mount.id ? "opacity-55" : ""
      }`}
      data-archon-own-contextmenu
      role="presentation"
      onDragOver={(e) => {
        const fromMime =
          e.dataTransfer.types.includes(DND_NOTE_IDS_MIME) ||
          e.dataTransfer.types.includes(DND_NOTE_MIME) ||
          e.dataTransfer.types.includes("text/plain");
        if (!fromMime) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const raw = draggingIdsRef.current.length
          ? draggingIdsRef.current
          : draggingRef.current
            ? [draggingRef.current]
            : parseDragIds(e);
        if (raw.length === 0) {
          return;
        }
        const placement = placementFromPointer(
          e,
          e.currentTarget as HTMLElement,
        );
        const ok =
          raw.length === 1
            ? dropAllowedOne(raw[0]!, mount.id, placement)
            : dropAllowedMany(raw, mount.id, placement);
        if (ok) {
          setDropHint((h) =>
            h?.targetId === mount.id &&
            h?.placement === placement &&
            h?.sectionKey === sectionKey
              ? h
              : { targetId: mount.id, placement, sectionKey },
          );
        } else {
          setDropHint((h) =>
            h?.sectionKey === sectionKey ? null : h,
          );
        }
      }}
      onDragLeave={(e) => {
        const rel = e.relatedTarget as Node | null;
        const cur = e.currentTarget as HTMLElement;
        if (rel && cur.contains(rel)) {
          return;
        }
        setDropHint((h) =>
          h?.targetId === mount.id && h?.sectionKey === sectionKey
            ? null
            : h,
        );
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropHint(null);
        const raw = parseDragIds(e);
        draggingRef.current = null;
        draggingIdsRef.current = [];
        setDraggingId(null);
        setDraggingBulkCount(0);
        if (raw.length === 0) {
          return;
        }
        const placement = placementFromPointer(
          e,
          e.currentTarget as HTMLElement,
        );
        const ok =
          raw.length === 1
            ? dropAllowedOne(raw[0]!, mount.id, placement)
            : dropAllowedMany(raw, mount.id, placement);
        if (!ok) {
          return;
        }
        const draggedOk = raw.every((id) => validNoteIds.has(id));
        if (!draggedOk || !validNoteIds.has(mount.id)) {
          onResyncNotes();
          return;
        }
        if (raw.length === 1) {
          void onMoveNote({
            draggedId: raw[0]!,
            targetId: mount.id,
            placement,
          });
        } else {
          void onMoveNotesBulk({
            ids: raw,
            targetId: mount.id,
            placement,
          });
        }
      }}
    >
      {hint ? (
        <span
          className="pointer-events-none absolute right-1 top-1/2 z-30 -translate-y-1/2 whitespace-nowrap rounded border border-border bg-popover px-1 py-px text-[8px] font-medium leading-tight text-foreground shadow-sm"
          aria-live="polite"
        >
          {hint === "before"
            ? "above (sibling)"
            : hint === "after"
              ? "below (sibling)"
              : "child"}
        </span>
      ) : null}
      {hint === "before" ? (
        <div
          className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-center justify-center"
          aria-hidden
        >
          <div className="h-[2px] w-full rounded-full bg-foreground shadow-[0_0_0_1px_hsl(var(--background))]" />
        </div>
      ) : null}
      {hint === "after" ? (
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center"
          aria-hidden
        >
          <div className="h-[2px] w-full rounded-full bg-foreground shadow-[0_0_0_1px_hsl(var(--background))]" />
        </div>
      ) : null}
      {hint === "into" ? (
        <div
          className="pointer-events-none absolute inset-1 z-10 rounded-md border-2 border-dotted border-foreground/60 bg-foreground/5 dark:bg-foreground/12"
          aria-hidden
        />
      ) : null}
      {plainHeader ? (
        <div
          className="flex min-h-8 min-w-0 flex-1 items-center truncate px-2 py-1 font-mono text-[11px] text-sidebar-foreground/90"
          title={plainTitle}
        >
          {label}
        </div>
      ) : (
        <div
          className="flex min-h-8 items-stretch rounded-md transition-colors duration-150"
          style={{ paddingLeft: pad }}
        >
          <span className="w-6 shrink-0" aria-hidden />
          <button
            type="button"
            data-note-row
            onClick={(ev) => handleRowClick(mount.id, ev)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              void onNoteSelect(mount.id);
              setMenu({
                x: ev.clientX,
                y: ev.clientY,
                anchorId: mount.id,
                step: "main",
              });
            }}
            className={`relative flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-r-md py-1 pr-2 text-left outline-none transition-colors duration-150 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-background))] ${
              selected
                ? inMulti && !primarySelected
                  ? "bg-foreground/10 text-sidebar-foreground ring-1 ring-inset ring-foreground/20 hover:bg-foreground/14"
                  : "bg-sidebar-accent text-sidebar-foreground before:pointer-events-none before:absolute before:left-1 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-foreground/55 before:content-[''] hover:bg-sidebar-accent"
                : "text-sidebar-foreground hover:bg-sidebar-accent/70"
            }`}
          >
            <span
              className={`inline-flex h-5 min-w-[1.75rem] shrink-0 items-center justify-center rounded px-0.5 font-mono text-[9px] font-semibold leading-none ring-1 ring-inset ring-foreground/10 dark:ring-white/15 ${getTypeBadgeClass(mount.type)}`}
            >
              {noteTypeInitials(mount.type)}
            </span>
            <span
              className={`min-w-0 flex-1 truncate text-[12px] leading-tight ${
                primarySelected ? "font-medium" : "font-normal"
              }`}
            >
              {mount.title}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
