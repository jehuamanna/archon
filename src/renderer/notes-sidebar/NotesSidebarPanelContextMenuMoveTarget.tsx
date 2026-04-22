import React, { useEffect, useState } from "react";
import type { ArchonConfirmOptions } from "../dialog/ArchonDialogProvider";
import { getArchon } from "../../shared/archon-host-access";
import type { WpnWorkspaceRow, WpnProjectRow } from "../../shared/wpn-v2-types";
import { ctxBtn, type ContextMenuState } from "./notes-sidebar-utils";

export interface NotesSidebarPanelContextMenuMoveTargetProps {
  noteId: string;
  notes: { id: string }[];
  confirm: (opts: ArchonConfirmOptions) => Promise<boolean>;
  closeMenu: () => void;
  setMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  menu: ContextMenuState;
  onMoveComplete?: () => void;
}

type LoadedData = {
  workspaces: WpnWorkspaceRow[];
  projects: WpnProjectRow[];
  currentProjectId: string | null;
};

const NotesSidebarPanelContextMenuMoveTarget: React.FC<
  NotesSidebarPanelContextMenuMoveTargetProps
> = ({ noteId, confirm, closeMenu, setMenu, menu, onMoveComplete }) => {
  const [data, setData] = useState<LoadedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const archon = getArchon();
        const [wsProj, noteDetail] = await Promise.all([
          typeof archon.wpnListWorkspacesAndProjects === "function"
            ? archon.wpnListWorkspacesAndProjects()
            : { workspaces: [] as WpnWorkspaceRow[], projects: [] as WpnProjectRow[] },
          typeof archon.getNote === "function"
            ? archon.getNote(noteId)
            : null,
        ]);
        if (!cancelled) {
          setData({
            workspaces: wsProj.workspaces ?? [],
            projects: wsProj.projects ?? [],
            currentProjectId: (noteDetail as Record<string, unknown> | null)?.project_id as string | null ?? null,
          });
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const handleMove = async (targetProjectId: string) => {
    if (moving) return;
    setMoving(true);
    try {
      const archon = getArchon();

      let dependentNoteCount = 0;
      if (typeof archon.wpnPreviewNoteMoveVfsImpact === "function") {
        try {
          const preview = await archon.wpnPreviewNoteMoveVfsImpact(noteId, targetProjectId);
          dependentNoteCount =
            typeof preview?.dependentNoteCount === "number" ? preview.dependentNoteCount : 0;
        } catch {
          /* proceed without preview */
        }
      }

      if (dependentNoteCount > 0) {
        const ok = await confirm({
          title: "Update links?",
          message: `Moving this note will update links in ${dependentNoteCount} other note(s). Continue?`,
          confirmLabel: "Move & Update",
        });
        if (!ok) {
          setMoving(false);
          return;
        }
      }

      await archon.wpnMoveNoteCrossProject({
        noteId,
        targetProjectId,
      });

      closeMenu();
      onMoveComplete?.();
    } catch {
      setMoving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={ctxBtn}
        onClick={() =>
          setMenu({ ...menu, step: "main" })
        }
      >
        ← Back
      </button>
      <div className="my-1 h-px bg-border" />
      <p className="px-2.5 pb-1 text-[11px] text-muted-foreground">
        Move to project
      </p>
      <div className="max-h-64 overflow-y-auto px-1">
        {loading ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            Loading…
          </p>
        ) : !data || data.projects.length <= 1 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            No other projects available
          </p>
        ) : (
          data.workspaces.map((ws) => {
            const wsProjects = data.projects.filter(
              (p) => p.workspace_id === ws.id,
            );
            if (wsProjects.length === 0) return null;
            return (
              <React.Fragment key={ws.id}>
                <p className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {ws.name}
                </p>
                {wsProjects.map((proj) => {
                  const isCurrent = proj.id === data.currentProjectId;
                  return (
                    <button
                      key={proj.id}
                      type="button"
                      className={ctxBtn}
                      disabled={isCurrent || moving}
                      onClick={() => void handleMove(proj.id)}
                      style={isCurrent ? { opacity: 0.4, cursor: "default" } : undefined}
                    >
                      {proj.name}
                      {isCurrent ? " (current)" : ""}
                    </button>
                  );
                })}
              </React.Fragment>
            );
          })
        )}
      </div>
    </>
  );
};

export default NotesSidebarPanelContextMenuMoveTarget;
