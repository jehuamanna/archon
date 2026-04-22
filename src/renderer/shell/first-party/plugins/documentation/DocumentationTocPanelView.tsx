import { getArchon } from "../../../../../shared/archon-host-access";
import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";
import { resolveCommandApiDoc } from "../../../command-api-metadata";
import { parseMarkdownHeadingsForToc } from "../../../../utils/markdown-heading-slugs";
import { BUNDLED_DOC_NOTE_IDS } from "./documentationConstants";
import { fetchBundledDocumentationNote } from "./documentationFetchBundledNote";
import { resolvedCommandDocToMarkdown } from "./documentationCommandMarkdown";
import { DocumentationLinkContextMenu, type DocumentationLinkMenuModel } from "./DocumentationLinkContextMenu";
import {
  DOCUMENTATION_SHELL_TAB_TYPE_ID,
  documentationShareAbsoluteUrl,
  documentationStateWithHeading,
  mergeDocumentationHeadingSlug,
  readDocumentationStateFromTab,
} from "./documentationShellHash";

function esc(s: string): string {
  return String(s || "").replace(/[&<>"]/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] ?? ch),
  );
}

/**
 * Companion column for the Documentation tab: outline of the Markdown currently shown in the main hub
 * (overview, bundled guide, or generated command API doc).
 */
export function DocumentationTocPanelView(_props: ShellViewComponentProps): React.ReactElement {
  const registry = useArchonContributionRegistry();
  const regs = useShellRegistries();
  const tabDocSig = useSyncExternalStore(
    (cb) => regs.tabs.subscribe(cb),
    () => {
      const t = regs.tabs.getActiveTab();
      const d = readDocumentationStateFromTab(t);
      return `${t?.instanceId ?? ""}|${d?.view ?? ""}|${d?.commandId ?? ""}|${d?.noteId ?? ""}|${d?.bundledResolvingLogicalId ?? ""}|${d?.headingSlug ?? ""}`;
    },
    () => "",
  );

  const registryRev = useSyncExternalStore(
    (onChange) => registry.subscribe(onChange),
    () => registry.getSnapshotVersion(),
    () => 0,
  );

  void tabDocSig;
  void registryRev;

  const [markdown, setMarkdown] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docLinkMenu, setDocLinkMenu] = useState<DocumentationLinkMenuModel | null>(null);

  useEffect(() => {
    const t = regs.tabs.getActiveTab();
    if (!t || t.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) {
      setMarkdown("");
      setLoading(false);
      setError(null);
      return;
    }
    const doc = readDocumentationStateFromTab(t);
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMarkdown("");

    const run = async () => {
      try {
        if (doc?.view === "command" && doc.commandId) {
          const cmd = registry.getCommand(doc.commandId);
          const apiDoc = cmd ? resolveCommandApiDoc(cmd) : null;
          if (!apiDoc) {
            if (!cancelled) {
              setMarkdown("");
              setLoading(false);
            }
            return;
          }
          if (!cancelled) {
            setMarkdown(resolvedCommandDocToMarkdown(apiDoc));
            setLoading(false);
          }
          return;
        }
        if (doc?.view === "bundled" && doc.noteId) {
          const note = doc.noteId.startsWith("wpn-docs:")
            ? (await getArchon().wpnGetNote(doc.noteId)).note
            : await getArchon().getNote(doc.noteId);
          const content = typeof (note as { content?: unknown }).content === "string" ? (note as { content: string }).content : "";
          if (!cancelled) {
            setMarkdown(content);
            setLoading(false);
          }
          return;
        }
        if (doc?.view === "bundled" && doc.bundledResolvingLogicalId && !doc.noteId) {
          if (!cancelled) {
            setMarkdown("");
            setLoading(false);
          }
          return;
        }
        const n = await fetchBundledDocumentationNote(BUNDLED_DOC_NOTE_IDS.hubOverview);
        if (!cancelled) {
          setMarkdown(typeof n.content === "string" ? n.content : "");
          setLoading(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setMarkdown("");
          setLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [registry, regs.tabs, tabDocSig]);

  const rows = useMemo(() => parseMarkdownHeadingsForToc(markdown), [markdown]);

  const t = regs.tabs.getActiveTab();
  const isDocsTab = t?.tabTypeId === DOCUMENTATION_SHELL_TAB_TYPE_ID;

  if (!isDocsTab) {
    return (
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className="text-[11px] font-medium text-muted-foreground">Documentation outline</div>
        <div className="mt-2 text-[12px] text-muted-foreground">Open a Documentation tab to see headings.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className="text-[11px] font-medium text-muted-foreground">Documentation outline</div>
        <div className="mt-2 text-[12px] text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className="text-[11px] font-medium text-muted-foreground">Documentation outline</div>
        <div className="mt-2 text-[12px] text-destructive">{esc(error)}</div>
      </div>
    );
  }

  const tabForToc = regs.tabs.getActiveTab();
  const tabDocForShare = readDocumentationStateFromTab(tabForToc);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
      <div className="px-1.5 py-1 text-[11px] font-medium text-muted-foreground">Documentation outline</div>
      <div className="min-h-0 flex-1 overflow-auto" data-archon-own-contextmenu>
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
                    title={`${r.text} — right-click to copy a link to this heading`}
                    onClick={() => {
                      const tab = regs.tabs.getActiveTab();
                      if (!tab || tab.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
                      mergeDocumentationHeadingSlug(regs.tabs, tab.instanceId, r.slug);
                      queueMicrotask(() => {
                        window.dispatchEvent(
                          new CustomEvent("archon:documentation-scroll-to-heading", { detail: { slug: r.slug } }),
                        );
                      });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const next = documentationStateWithHeading(tabDocForShare, r.slug);
                      setDocLinkMenu({
                        x: e.clientX,
                        y: e.clientY,
                        url: documentationShareAbsoluteUrl(next),
                      });
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
      <DocumentationLinkContextMenu open={docLinkMenu} onClose={() => setDocLinkMenu(null)} />
    </div>
  );
}
