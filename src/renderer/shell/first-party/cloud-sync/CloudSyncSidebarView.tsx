"use client";

import React from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "../../../store";
import {
  createCloudNoteLocal,
  runCloudSyncThunk,
  selectCloudNote,
} from "../../../store/cloudNotesSlice";
import type { CloudNoteDoc } from "../../../store/cloudNotesTypes";

function sortActiveNotes(notes: CloudNoteDoc[]): CloudNoteDoc[] {
  return [...notes]
    .filter((n) => !n.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function CloudSyncSidebarView(): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const byId = useSelector((s: RootState) => s.cloudNotes.byId);
  const selectedId = useSelector((s: RootState) => s.cloudNotes.selectedId);
  const dirtyIds = useSelector((s: RootState) => s.cloudNotes.dirtyIds);
  const syncStatus = useSelector((s: RootState) => s.cloudNotes.syncStatus);
  const signedIn = useSelector((s: RootState) => s.cloudAuth.status === "signedIn");

  const list = sortActiveNotes(Object.values(byId));

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="shrink-0 border-b border-sidebar-border px-2 py-2">
        <div className="flex gap-1">
          <button
            type="button"
            disabled={!signedIn}
            className="flex-1 rounded border border-sidebar-border bg-sidebar-accent/30 px-2 py-1.5 text-[11px] font-medium hover:bg-sidebar-accent/50 disabled:opacity-40"
            onClick={() => dispatch(createCloudNoteLocal())}
          >
            New cloud note
          </button>
          <button
            type="button"
            disabled={!signedIn}
            title="Sync with server"
            className="rounded border border-sidebar-border bg-sidebar-accent/20 px-2 py-1.5 text-[11px] hover:bg-sidebar-accent/40 disabled:opacity-40"
            onClick={() => void dispatch(runCloudSyncThunk())}
          >
            {syncStatus === "syncing" ? "…" : "↻"}
          </button>
        </div>
        {!signedIn ? (
          <p className="mt-2 text-[10px] text-sidebar-foreground/70">
            Sign in from the main Cloud panel to sync.
          </p>
        ) : null}
      </div>
      <ul className="min-h-0 flex-1 list-none overflow-y-auto p-0">
        {list.map((n) => {
          const dirty = Boolean(dirtyIds[n.id]);
          const active = selectedId === n.id;
          return (
            <li key={n.id}>
              <button
                type="button"
                className={`w-full border-b border-sidebar-border/60 px-3 py-2 text-left text-[12px] ${
                  active
                    ? "bg-sidebar-accent font-medium text-foreground"
                    : "text-sidebar-foreground/90 hover:bg-sidebar-accent/35"
                }`}
                onClick={() => dispatch(selectCloudNote(n.id))}
              >
                <span className="line-clamp-2">
                  {dirty ? "● " : ""}
                  {n.title || "Untitled"}
                </span>
              </button>
            </li>
          );
        })}
        {list.length === 0 && signedIn ? (
          <li className="px-3 py-4 text-[11px] text-sidebar-foreground/60">
            No cloud notes yet. Create one or run sync.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
