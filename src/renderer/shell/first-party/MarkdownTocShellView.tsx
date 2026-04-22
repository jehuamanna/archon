import { getArchon } from "../../../shared/archon-host-access";
import React, { useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import type { WpnBacklinkSourceItem } from "../../../shared/wpn-v2-types";
import type { RootState } from "../../store";
import { parseMarkdownHeadingsForToc } from "../../utils/markdown-heading-slugs";
import { useShellActiveMainTab } from "../ShellActiveTabContext";
import { useShellRegistries } from "../registries/ShellRegistriesContext";
import type { ShellViewComponentProps } from "../views/ShellViewRegistry";
import { useShellNavigation } from "../useShellNavigation";
import { isShellNoteEditorTabType } from "./shellWorkspaceIds";
import type { ShellNoteTabState } from "../shellTabUrlSync";
import { getCachedCanonicalVfsPathForNoteId } from "../noteIdVfsPathCache";

export function MarkdownTocShellView(_props: ShellViewComponentProps): React.ReactElement {
  const tab = useShellActiveMainTab();
  const { tabs } = useShellRegistries();
  const { openNoteById } = useShellNavigation();
  const currentNote = useSelector((s: RootState) => s.notes.currentNote);

  const noteTabState: ShellNoteTabState | undefined =
    tab && typeof tab.state === "object" && tab.state !== null
      ? (tab.state as ShellNoteTabState)
      : undefined;
  const noteId = noteTabState?.noteId;

  const isMarkdown =
    currentNote != null &&
    currentNote.id === noteId &&
    (currentNote.type === "markdown" || currentNote.type === "root");

  const rows = useMemo(() => {
    if (!isMarkdown) return [];
    return parseMarkdownHeadingsForToc(currentNote?.content ?? "");
  }, [currentNote?.content, isMarkdown]);

  const [backlinks, setBacklinks] = useState<WpnBacklinkSourceItem[]>([]);
  const [backlinkError, setBacklinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!isMarkdown || !currentNote?.id) {
      setBacklinks([]);
      setBacklinkError(null);
      return;
    }
    let cancelled = false;
    setBacklinkError(null);
    void (async () => {
      try {
        const archon = getArchon();
        if (!archon?.wpnListBacklinksToNote) {
          if (!cancelled) setBacklinks([]);
          return;
        }
        const { sources } = await archon.wpnListBacklinksToNote(currentNote.id);
        if (!cancelled) setBacklinks(Array.isArray(sources) ? sources : []);
      } catch {
        if (!cancelled) {
          setBacklinkError("Could not load backlinks.");
          setBacklinks([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentNote?.id, isMarkdown]);

  if (!isMarkdown) {
    return (
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className="text-[11px] font-medium text-muted-foreground">Outline</div>
        <div className="mt-2 text-[12px] text-muted-foreground">
          Open a markdown note to see its headings.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
      <div className="px-1.5 py-1 text-[11px] font-medium text-muted-foreground">Outline</div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-muted-foreground">No headings found.</div>
        ) : (
          <ul className="m-0 list-none p-0">
            {rows.map((r) => {
              const pad = Math.max(0, (r.level - 1) * 10);
              return (
                <li key={r.slug}>
                  <button
                    type="button"
                    className="w-full truncate rounded-md px-2 py-1.5 text-left text-[12px] text-foreground outline-none hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring"
                    style={{ paddingLeft: 8 + pad }}
                    title={r.text}
                    onClick={() => {
                      if (tab?.instanceId && currentNote && isShellNoteEditorTabType(tab.tabTypeId)) {
                        const prev = noteTabState ?? { noteId: currentNote.id };
                        tabs.updateTabPresentation(tab.instanceId, {
                          state: {
                            ...prev,
                            noteId: currentNote.id,
                            markdownHeadingSlug: r.slug,
                          },
                        });
                      }
                      window.dispatchEvent(
                        new CustomEvent("archon:markdown-scroll-to-heading", {
                          detail: { noteId: currentNote!.id, slug: r.slug },
                        }),
                      );
                    }}
                  >
                    {r.text}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 shrink-0 border-t border-border px-1.5 pt-2">
        <div className="py-1 text-[11px] font-medium text-muted-foreground">Linked from</div>
        <div className="max-h-[200px] overflow-auto">
          {backlinkError ? (
            <div className="px-1 py-1 text-[11px] text-destructive">{backlinkError}</div>
          ) : backlinks.length === 0 ? (
            <div className="px-1 py-1 text-[12px] text-muted-foreground">No incoming links.</div>
          ) : (
            <ul className="m-0 list-none p-0">
              {backlinks.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className="w-full truncate rounded-md px-2 py-1.5 text-left text-[12px] text-foreground outline-none hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring"
                    title={b.title}
                    onClick={() => {
                      const cached = getCachedCanonicalVfsPathForNoteId(b.id);
                      openNoteById(b.id, cached ? { canonicalVfsPath: cached } : undefined);
                    }}
                  >
                    {b.title.trim() || "Untitled"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
