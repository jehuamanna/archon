import { getArchon } from "../../../../../shared/archon-host-access";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { NoteListItem } from "@archon/ui-types";
import { useArchonCommands } from "../../../ArchonContributionContext";
import type { CommandContribution } from "../../../archon-contribution-registry";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";
import type { AppDispatch, RootState } from "../../../../store";
import { fetchAllNotes } from "../../../../store/notesSlice";
import { DOCS_BC, type DocsBcMessage } from "./documentationConstants";
import {
  documentationShareAbsoluteUrl,
  mergeDocumentationIntoActiveDocsTab,
} from "./documentationShellHash";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { DocumentationLinkContextMenu, type DocumentationLinkMenuModel } from "./DocumentationLinkContextMenu";
import { DocumentationSettingsForm } from "./DocumentationSettingsForm";
import { fetchBundledGuideIndexFromSyncPublic } from "./documentationFetchBundledNote";
function esc(s: string): string {
  return String(s || "").replace(/[&<>"]/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] ?? ch),
  );
}

function isBundledDocPage(item: NoteListItem): boolean {
  const m = item.metadata;
  return m != null && m.bundledDoc === true && m.bundledDocRole === "page";
}

function bundledDocOrder(item: NoteListItem): number {
  const o = item.metadata?.bundledDocOrder;
  return typeof o === "number" ? o : 9999;
}

/** Matches seed metadata `bundledDocSection` (User guide / Plugin authoring / Reference). */
const GUIDE_SECTION_ORDER = ["User guide", "Plugin authoring", "Reference"] as const;

function bundledDocSectionLabel(item: NoteListItem): string {
  const m = item.metadata as Record<string, unknown> | undefined;
  const s = m?.bundledDocSection;
  return typeof s === "string" && s.trim() ? s : "Guides";
}

function sectionSortKey(name: string): number {
  const i = (GUIDE_SECTION_ORDER as readonly string[]).indexOf(name);
  return i >= 0 ? i : 100;
}

function groupGuidesBySection(items: NoteListItem[]): Array<{ section: string; items: NoteListItem[] }> {
  const by = new Map<string, NoteListItem[]>();
  for (const it of items) {
    const sec = bundledDocSectionLabel(it);
    const arr = by.get(sec);
    if (arr) arr.push(it);
    else by.set(sec, [it]);
  }
  return [...by.entries()]
    .sort((a, b) => {
      const d = sectionSortKey(a[0]) - sectionSortKey(b[0]);
      if (d !== 0) return d;
      return a[0].localeCompare(b[0]);
    })
    .map(([section, rows]) => ({
      section,
      items: rows.sort((a, b) => {
        const ao = bundledDocOrder(a);
        const bo = bundledDocOrder(b);
        if (ao !== bo) return ao - bo;
        return String(a.title).localeCompare(String(b.title));
      }),
    }));
}

const GUIDE_LIST_CAP = 200;

function capGroupedGuides(
  grouped: Array<{ section: string; items: NoteListItem[] }>,
  cap: number,
): Array<{ section: string; items: NoteListItem[] }> {
  let n = 0;
  const out: Array<{ section: string; items: NoteListItem[] }> = [];
  for (const g of grouped) {
    const take = Math.min(g.items.length, cap - n);
    if (take <= 0) break;
    out.push({ section: g.section, items: g.items.slice(0, take) });
    n += take;
  }
  return out;
}

type SidebarMode = "guides" | "commands" | "settings";

export function DocumentationSearchPanelView(_props: ShellViewComponentProps): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const { tabs } = useShellRegistries();
  const commands = useArchonCommands();
  const notesList = useSelector((s: RootState) => s.notes.notesList);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("guides");
  const [q, setQ] = useState("");
  const [miniOnly, setMiniOnly] = useState(true);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [wpnGuides, setWpnGuides] = useState<Array<{ id: string; title: string; section: string }>>([]);
  const [wpnGuidesError, setWpnGuidesError] = useState<string | null>(null);
  const [docLinkMenu, setDocLinkMenu] = useState<DocumentationLinkMenuModel | null>(null);

  const postBc = useCallback((msg: DocsBcMessage) => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(DOCS_BC);
    bc.postMessage(msg);
    bc.close();
  }, []);

  const toggleMiniOnly = useCallback(() => {
    const next = !miniOnly;
    setMiniOnly(next);
    postBc({ type: "docs.setMiniOnly", miniOnly: next });
  }, [miniOnly, postBc]);

  useEffect(() => {
    void dispatch(fetchAllNotes());
  }, [dispatch]);

  useEffect(() => {
    let cancelled = false;
    setWpnGuidesError(null);
    void (async () => {
      let pages: Array<{ id: string; title: string; section: string }> = [];
      let err: string | null = null;
      try {
        const { workspaces } = await getArchon().wpnListWorkspaces();
        const ws0 = workspaces[0];
        if (ws0) {
          const { projects } = await getArchon().wpnListProjects(ws0.id);
          const docsProject = projects.find((p) => p.name === "Documentation");
          if (docsProject) {
            const { notes } = await getArchon().wpnListNotes(docsProject.id);
            const details = await Promise.all(
              notes.map(async (n) => {
                try {
                  const r = await getArchon().wpnGetNote(n.id);
                  return r.note;
                } catch {
                  return null;
                }
              }),
            );
            pages = details
              .filter((n): n is NonNullable<typeof n> => !!n)
              .filter((n) => n.metadata?.bundledDoc === true && n.metadata?.bundledDocRole === "page")
              .map((n) => {
                const meta = n.metadata as Record<string, unknown> | undefined;
                const sec = meta?.bundledDocSection;
                const section = typeof sec === "string" && sec.trim() ? sec : "Guides";
                return { id: n.id, title: n.title, section };
              });
            pages.sort((a, b) => {
              const ao = (details.find((x) => x?.id === a.id)?.metadata as Record<string, unknown> | undefined)
                ?.bundledDocOrder;
              const bo = (details.find((x) => x?.id === b.id)?.metadata as Record<string, unknown> | undefined)
                ?.bundledDocOrder;
              const an = typeof ao === "number" ? ao : 9999;
              const bn = typeof bo === "number" ? bo : 9999;
              if (an !== bn) return an - bn;
              return a.title.localeCompare(b.title);
            });
          }
        }
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      if (pages.length === 0) {
        const fromSyncPublic = await fetchBundledGuideIndexFromSyncPublic();
        if (fromSyncPublic.length > 0) {
          pages = fromSyncPublic;
          err = null;
        }
      }
      if (!cancelled) {
        setWpnGuides(pages);
        setWpnGuidesError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(DOCS_BC) : null;
    if (!bc) return () => {};
    const onMsg = (ev: MessageEvent<DocsBcMessage>) => {
      const d = ev.data;
      if (d?.type === "docs.setMiniOnly" && typeof d.miniOnly === "boolean") {
        setMiniOnly(d.miniOnly);
      }
    };
    bc.addEventListener("message", onMsg);
    return () => {
      bc.removeEventListener("message", onMsg);
      bc.close();
    };
  }, []);

  const guideRows = useMemo(() => {
    if (wpnGuides.length > 0) {
      return wpnGuides.map((g) => ({
        id: g.id,
        title: g.title,
        type: "markdown",
        parentId: null,
        depth: 0,
        metadata: { bundledDoc: true, bundledDocRole: "page", bundledDocSection: g.section },
      })) as NoteListItem[];
    }
    return notesList
      .filter(isBundledDocPage)
      .sort((a, b) => {
        const ao = bundledDocOrder(a);
        const bo = bundledDocOrder(b);
        if (ao !== bo) return ao - bo;
        return String(a.title).localeCompare(String(b.title));
      });
  }, [notesList, wpnGuides]);

  const norm = (s: string) => String(s || "").toLowerCase().trim();
  const label = (c: CommandContribution) =>
    c.category ? `${c.category}: ${c.title}` : c.title;
  const matchesCommand = (c: CommandContribution, query: string) => {
    if (!query) return true;
    const argText =
      c.api?.args?.map((a) => `${a.name} ${a.type} ${a.description ?? ""}`).join(" ") ?? "";
    const h = norm(
      `${c.id} ${label(c)} ${c.doc || ""} ${c.sourcePluginId ?? ""} ${c.api?.summary ?? ""} ${c.api?.details ?? ""} ${argText}`,
    );
    return query
      .split(/\s+/)
      .filter(Boolean)
      .every((p) => h.includes(p));
  };

  const filteredCommands = commands
    .filter((c) => !miniOnly || c.miniBar !== false)
    .filter((c) => matchesCommand(c, norm(q)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const filteredGuides = guideRows.filter((g) => {
    if (!norm(q)) return true;
    const h = norm(`${g.id} ${g.title} ${bundledDocSectionLabel(g)}`);
    return norm(q)
      .split(/\s+/)
      .filter(Boolean)
      .every((p) => h.includes(p));
  });

  const groupedFilteredGuides = useMemo(
    () => capGroupedGuides(groupGuidesBySection(filteredGuides), GUIDE_LIST_CAP),
    [filteredGuides],
  );

  const selectedCommand = selectedCommandId ? commands.find((x) => x.id === selectedCommandId) : null;

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex shrink-0 border-b border-border">
        <button
          type="button"
          className={`flex-1 px-2 py-2 text-center text-[11px] font-semibold ${
            sidebarMode === "guides" ? "bg-muted/40 text-foreground" : "text-muted-foreground hover:bg-muted/20"
          }`}
          onClick={() => {
            setSidebarMode("guides");
            setQ("");
          }}
        >
          Guides
        </button>
        <button
          type="button"
          className={`flex-1 px-2 py-2 text-center text-[11px] font-semibold ${
            sidebarMode === "commands" ? "bg-muted/40 text-foreground" : "text-muted-foreground hover:bg-muted/20"
          }`}
          onClick={() => {
            setSidebarMode("commands");
            setQ("");
          }}
        >
          Commands
        </button>
        <button
          type="button"
          className={`flex-1 px-2 py-2 text-center text-[11px] font-semibold ${
            sidebarMode === "settings" ? "bg-muted/40 text-foreground" : "text-muted-foreground hover:bg-muted/20"
          }`}
          onClick={() => {
            setSidebarMode("settings");
            setQ("");
          }}
        >
          Settings
        </button>
      </div>

      {sidebarMode === "settings" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DocumentationSettingsForm miniOnly={miniOnly} onToggleMiniOnly={toggleMiniOnly} />
        </div>
      ) : sidebarMode === "guides" ? (
        <>
          <div className="shrink-0 border-b border-border px-2.5 py-2 text-[12px] font-bold opacity-85">
            Bundled documentation
          </div>
          <input
            className="mx-2.5 mt-2 box-border w-[calc(100%-20px)] border border-border px-2.5 py-2 text-[12px] outline-none"
            placeholder="Filter guides by title…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-[11px] opacity-65">
            <span>{filteredGuides.length} guide(s)</span>
            <button
              type="button"
              className="rounded border border-border bg-muted/20 px-2 py-1 text-[10px]"
              onClick={() => postBc({ type: "docs.refreshCommands" })}
            >
              Refresh panels
            </button>
          </div>
          <div
            className="min-h-0 flex-1 space-y-3 overflow-auto px-2 pb-2"
            data-archon-own-contextmenu
          >
            {guideRows.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-muted-foreground">
                {wpnGuidesError
                  ? `Could not load guides from the WPN workspace: ${wpnGuidesError}`
                  : "No bundled guides found yet. Open a project so documentation can load (legacy notes tree or WPN Documentation project)."}
              </p>
            ) : (
              groupedFilteredGuides.map(({ section, items }) => (
                <div key={section} className="space-y-1">
                  <div className="px-1 pt-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    {esc(section)}
                  </div>
                  {items.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className="w-full border border-border/80 bg-muted/10 px-2 py-1.5 text-left hover:bg-muted/40"
                      title="Right-click to copy a shareable link to this guide"
                      onClick={() => {
                        setSelectedGuideId(g.id);
                        mergeDocumentationIntoActiveDocsTab(tabs, { view: "bundled", noteId: g.id });
                        postBc({ type: "docs.showBundledDoc", noteId: g.id });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDocLinkMenu({
                          x: e.clientX,
                          y: e.clientY,
                          url: documentationShareAbsoluteUrl({ view: "bundled", noteId: g.id }),
                        });
                      }}
                    >
                      <div className="text-[11px] font-medium text-foreground">{esc(g.title)}</div>
                      <div className="font-mono text-[10px] opacity-70">{esc(g.id)}</div>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
          {selectedGuideId ? (
            <div className="shrink-0 border-t border-border bg-muted/10 p-2.5 text-[11px] text-muted-foreground">
              <span className="font-mono text-[10px] text-foreground">{esc(selectedGuideId)}</span>
              <span className="mx-1 opacity-40">·</span>
              <span>Read-only markdown in this tab’s main area →</span>
            </div>
          ) : (
            <div className="shrink-0 border-t border-border p-2 text-[11px] opacity-50">
              Select a guide (rendered markdown, read-only)
            </div>
          )}
        </>
      ) : sidebarMode === "commands" ? (
        <>
          <div className="shrink-0 border-b border-border px-2.5 py-2 text-[12px] font-bold opacity-85">
            Search commands
          </div>
          <input
            className="mx-2.5 mt-2 box-border w-[calc(100%-20px)] border border-border px-2.5 py-2 text-[12px] outline-none"
            placeholder="Filter by id, title, doc…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-[11px] opacity-65">
            <span>{filteredCommands.length} match(es)</span>
            <button
              type="button"
              className="rounded border border-border bg-muted/20 px-2 py-1 text-[10px]"
              onClick={() => postBc({ type: "docs.refreshCommands" })}
            >
              Refresh other panels
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2" data-archon-own-contextmenu>
            {filteredCommands.slice(0, 300).map((c) => (
              <button
                key={c.id}
                type="button"
                className="w-full border border-border/80 bg-muted/10 px-2 py-1.5 text-left hover:bg-muted/40"
                title="Right-click to copy a shareable link to this command’s API doc"
                onClick={() => {
                  setSelectedCommandId(c.id);
                  mergeDocumentationIntoActiveDocsTab(tabs, { view: "command", commandId: c.id });
                  postBc({ type: "docs.showCommand", commandId: c.id });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDocLinkMenu({
                    x: e.clientX,
                    y: e.clientY,
                    url: documentationShareAbsoluteUrl({ view: "command", commandId: c.id }),
                  });
                }}
              >
                <div className="font-mono text-[10px]">{esc(c.id)}</div>
                <div className="text-[11px] opacity-80">{esc(label(c))}</div>
              </button>
            ))}
          </div>
          {selectedCommand ? (
            <div className="shrink-0 border-t border-border bg-muted/10 p-2.5 text-[11px] text-muted-foreground">
              <span className="font-mono text-[10px] text-foreground">{esc(selectedCommand.id)}</span>
              <span className="mx-1 opacity-40">·</span>
              <span>Full API text in this tab’s main area →</span>
            </div>
          ) : (
            <div className="shrink-0 border-t border-border p-2 text-[11px] opacity-50">
              Select a command (details open in the main area)
            </div>
          )}
        </>
      ) : null}
      <DocumentationLinkContextMenu open={docLinkMenu} onClose={() => setDocLinkMenu(null)} />
    </div>
  );
}
