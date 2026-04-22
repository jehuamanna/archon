import { getArchon } from "../../../../../shared/archon-host-access";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Note } from "@archon/ui-types";
import MarkdownRenderer from "../../../../components/renderers/MarkdownRenderer";
import type { InternalMarkdownNoteLink } from "../../../../utils/markdown-internal-note-href";
import { resolveCommandApiDoc } from "../../../command-api-metadata";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { BUNDLED_DOC_NOTE_IDS, DOCS_BC, type DocsBcMessage } from "./documentationConstants";
import { fetchBundledDocumentationNote } from "./documentationFetchBundledNote";
import { resolvedCommandDocToMarkdown } from "./documentationCommandMarkdown";
import { resolveNoteIdFromVfsPath } from "../../../../utils/resolve-note-vfs-path";
import {
  DOCUMENTATION_SHELL_TAB_TYPE_ID,
  mergeDocumentationHeadingSlug,
  mergeDocumentationIntoTabState,
  readDocumentationStateFromTab,
  type DocumentationShellTabState,
} from "./documentationShellHash";

function esc(s: string): string {
  return String(s || "").replace(/[&<>"]/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] ?? ch),
  );
}

/**
 * **Main area** for the Documentation plugin: command API as a markdown note when the user picks a row
 * in the side panel (tab state merge, with {@link DOCS_BC} for other panels).
 * URL hash can target a command, bundled note, or hub heading via `state.documentation` (see `documentationShellHash`).
 */
export function DocumentationHubView(_props: { viewId: string; title: string }): React.ReactElement {
  const registry = useArchonContributionRegistry();
  const regs = useShellRegistries();
  const activeTab = regs.tabs.getActiveTab();
  const docState =
    activeTab?.tabTypeId === DOCUMENTATION_SHELL_TAB_TYPE_ID
      ? readDocumentationStateFromTab(activeTab)
      : null;
  const commandId =
    docState?.view === "command" && docState.commandId ? docState.commandId : null;
  const bundledNoteId =
    docState?.view === "bundled" && docState.noteId ? docState.noteId : null;
  const bundledResolvingLogicalId =
    docState?.view === "bundled" && docState.bundledResolvingLogicalId && !docState.noteId
      ? docState.bundledResolvingLogicalId
      : null;
  const bundledVfsPathResolving =
    docState?.view === "bundled" && docState.bundledVfsPath && !docState.noteId
      ? docState.bundledVfsPath
      : null;
  const headingSlug = docState?.headingSlug;
  const [bundledNote, setBundledNote] = useState<Note | null>(null);
  const [bundledLoading, setBundledLoading] = useState(false);
  const [bundledError, setBundledError] = useState<string | null>(null);
  const [hubNote, setHubNote] = useState<Note | null>(null);
  const [hubLoading, setHubLoading] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  const registryRev = useSyncExternalStore(
    (onChange) => registry.subscribe(onChange),
    () => registry.getSnapshotVersion(),
    () => 0,
  );

  const cmd = useMemo(() => {
    if (!commandId) return null;
    return registry.getCommand(commandId) ?? null;
  }, [commandId, registry, registryRev]);

  const doc = useMemo(() => (cmd ? resolveCommandApiDoc(cmd) : null), [cmd]);

  const commandMarkdownNote = useMemo((): Note | null => {
    if (!doc) return null;
    return {
      id: `documentation-hub-command:${doc.commandId}`,
      type: "markdown",
      title: doc.commandId,
      content: resolvedCommandDocToMarkdown(doc),
    };
  }, [doc]);

  useEffect(() => {
    const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(DOCS_BC) : null;
    if (!bc) return () => {};
    const onMsg = (ev: MessageEvent<DocsBcMessage>) => {
      const d = ev.data;
      const t = regs.tabs.getActiveTab();
      if (!t || t.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
      if (d?.type === "docs.showCommand" && typeof d.commandId === "string") {
        mergeDocumentationIntoTabState(regs.tabs, t.instanceId, {
          view: "command",
          commandId: d.commandId,
        });
      }
      if (d?.type === "docs.showBundledDoc" && typeof d.noteId === "string") {
        mergeDocumentationIntoTabState(regs.tabs, t.instanceId, {
          view: "bundled",
          noteId: d.noteId,
        });
      }
      if (d?.type === "docs.showBundledLogical" && typeof d.logicalId === "string") {
        mergeDocumentationIntoTabState(regs.tabs, t.instanceId, {
          view: "bundled",
          bundledResolvingLogicalId: d.logicalId,
        });
      }
    };
    bc.addEventListener("message", onMsg);
    return () => {
      bc.removeEventListener("message", onMsg);
      bc.close();
    };
  }, [regs.tabs]);

  useEffect(() => {
    if (!bundledResolvingLogicalId || bundledNoteId) return;
    let cancelled = false;
    void fetchBundledDocumentationNote(bundledResolvingLogicalId)
      .then((n) => {
        if (cancelled) return;
        const cur = regs.tabs.getActiveTab();
        if (!cur || cur.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
        mergeDocumentationIntoTabState(regs.tabs, cur.instanceId, { view: "bundled", noteId: n.id });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bundledResolvingLogicalId, bundledNoteId, regs.tabs]);

  useEffect(() => {
    if (!bundledVfsPathResolving || bundledNoteId) return;
    let cancelled = false;
    void resolveNoteIdFromVfsPath(bundledVfsPathResolving).then((id) => {
      if (cancelled || !id) return;
      const cur = regs.tabs.getActiveTab();
      if (!cur || cur.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
      const hs = readDocumentationStateFromTab(cur)?.headingSlug;
      mergeDocumentationIntoTabState(regs.tabs, cur.instanceId, {
        view: "bundled",
        noteId: id,
        headingSlug: hs,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [bundledVfsPathResolving, bundledNoteId, regs.tabs]);

  useEffect(() => {
    if (!bundledNoteId) {
      setBundledNote(null);
      setBundledError(null);
      setBundledLoading(Boolean(bundledResolvingLogicalId || bundledVfsPathResolving));
      return;
    }
    setBundledLoading(true);
    setBundledError(null);
    const load = async () => {
      if (bundledNoteId.startsWith("wpn-docs:")) {
        const r = await getArchon().wpnGetNote(bundledNoteId);
        return r.note as unknown as Note;
      }
      return await fetchBundledDocumentationNote(bundledNoteId);
    };
    void load()
      .then((n) => {
        setBundledNote(n);
        setBundledLoading(false);
      })
      .catch((e: unknown) => {
        setBundledError(e instanceof Error ? e.message : String(e));
        setBundledLoading(false);
      });
  }, [bundledNoteId, bundledResolvingLogicalId, bundledVfsPathResolving]);

  useEffect(() => {
    if (bundledNoteId || commandId || bundledResolvingLogicalId || bundledVfsPathResolving) {
      setHubNote(null);
      setHubError(null);
      setHubLoading(false);
      return;
    }
    let cancelled = false;
    setHubLoading(true);
    setHubError(null);
    void (async () => {
      try {
        const n = await fetchBundledDocumentationNote(BUNDLED_DOC_NOTE_IDS.hubOverview);
        if (!cancelled) {
          setHubNote(n);
          setHubLoading(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setHubError(e instanceof Error ? e.message : String(e));
          setHubNote(null);
          setHubLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bundledNoteId, commandId, bundledResolvingLogicalId, bundledVfsPathResolving]);

  const scrollDocHeadingIntoView = useCallback((slug: string) => {
    const deadline = performance.now() + 900;
    const tryOnce = () => {
      const root = scrollRootRef.current;
      const el = root?.querySelector(`#${CSS.escape(slug)}`) ?? document.getElementById(slug);
      if (el) {
        el.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      if (performance.now() < deadline) {
        requestAnimationFrame(tryOnce);
      }
    };
    requestAnimationFrame(tryOnce);
  }, []);

  useEffect(() => {
    if (!headingSlug) return;
    let alive = true;
    const slug = headingSlug;
    const deadline = performance.now() + 900;
    const tryOnce = () => {
      if (!alive) return;
      const root = scrollRootRef.current;
      const el = root?.querySelector(`#${CSS.escape(slug)}`) ?? document.getElementById(slug);
      if (el) {
        el.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      if (performance.now() < deadline) {
        requestAnimationFrame(tryOnce);
      }
    };
    requestAnimationFrame(tryOnce);
    return () => {
      alive = false;
    };
  }, [
    headingSlug,
    commandId,
    bundledNoteId,
    bundledResolvingLogicalId,
    bundledVfsPathResolving,
    hubNote?.id,
    bundledNote?.id,
    commandMarkdownNote?.id,
  ]);

  useEffect(() => {
    const onEv = (ev: Event) => {
      const slug = (ev as CustomEvent<{ slug?: string }>).detail?.slug;
      if (typeof slug === "string" && slug) {
        scrollDocHeadingIntoView(slug);
      }
    };
    window.addEventListener("archon:documentation-scroll-to-heading", onEv);
    return () => window.removeEventListener("archon:documentation-scroll-to-heading", onEv);
  }, [scrollDocHeadingIntoView]);

  /** TOC / in-doc `#slug` links: update shell hash and scroll (re-click same slug still scrolls). */
  const onDocHeadingLinkClick = useCallback(
    (slug: string) => {
      const t = regs.tabs.getActiveTab();
      if (!t || t.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
      mergeDocumentationHeadingSlug(regs.tabs, t.instanceId, slug);
      scrollDocHeadingIntoView(slug);
    },
    [regs.tabs, scrollDocHeadingIntoView],
  );

  const onInternalNoteNavigate = useCallback(
    (link: InternalMarkdownNoteLink) => {
      const t = regs.tabs.getActiveTab();
      if (!t || t.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
      if (link.kind === "noteId") {
        const next: DocumentationShellTabState = {
          view: "bundled",
          noteId: link.noteId,
          headingSlug: link.markdownHeadingSlug,
        };
        mergeDocumentationIntoTabState(regs.tabs, t.instanceId, next);
        return;
      }
      void resolveNoteIdFromVfsPath(link.vfsPath).then((id) => {
        if (!id) return;
        const cur = regs.tabs.getActiveTab();
        if (!cur || cur.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
        mergeDocumentationIntoTabState(regs.tabs, cur.instanceId, {
          view: "bundled",
          noteId: id,
          headingSlug: link.markdownHeadingSlug,
        });
      });
    },
    [regs.tabs],
  );

  const docHubDismissBtn =
    "shrink-0 rounded-md border border-border/60 bg-background px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/40";

  const closeBundled = () => {
    const t = regs.tabs.getActiveTab();
    if (!t || t.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
    mergeDocumentationIntoTabState(regs.tabs, t.instanceId, null);
  };

  const backToHubOverview = () => {
    const t = regs.tabs.getActiveTab();
    if (!t || t.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
    mergeDocumentationIntoTabState(regs.tabs, t.instanceId, null);
  };

  if (bundledNoteId || bundledResolvingLogicalId) {
    if (bundledResolvingLogicalId && !bundledNoteId) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 justify-end border-b border-border px-3 py-2">
            <button type="button" className={docHubDismissBtn} onClick={closeBundled}>
              Close
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-[13px] text-muted-foreground">
            Loading guide…
          </div>
        </div>
      );
    }
    if (bundledNoteId && bundledLoading) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 justify-end border-b border-border px-3 py-2">
            <button type="button" className={docHubDismissBtn} onClick={closeBundled}>
              Close
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-[13px] text-muted-foreground">
            Loading guide…
          </div>
        </div>
      );
    }
    if (bundledNoteId && bundledError) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 justify-end border-b border-border px-3 py-2">
            <button type="button" className={docHubDismissBtn} onClick={closeBundled}>
              Close
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-5 text-[13px] text-destructive">
            <p className="font-medium">Could not load this guide</p>
            <p className="text-muted-foreground">{esc(bundledError)}</p>
          </div>
        </div>
      );
    }
    if (bundledNoteId && !bundledNote) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 justify-end border-b border-border px-3 py-2">
            <button type="button" className={docHubDismissBtn} onClick={closeBundled}>
              Close
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-5 text-[13px] text-muted-foreground">
            <p className="font-medium text-foreground">Guide not available</p>
            <p>
              This note id is not in the current workspace, or notes have not finished loading. Open a project and
              ensure bundled docs have seeded.
            </p>
          </div>
        </div>
      );
    }
    if (bundledNote && bundledNoteId) {
      return (
        <div className="flex h-full min-h-0 flex-col overflow-auto">
          <div className="shrink-0 border-b border-border px-5 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Bundled guide (read-only)
                </div>
                <h1 className="mt-1 text-lg font-semibold text-foreground">{esc(bundledNote.title)}</h1>
              </div>
              <button type="button" className={docHubDismissBtn} onClick={closeBundled}>
                Close
              </button>
            </div>
          </div>
          <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-auto">
            <MarkdownRenderer
              note={bundledNote}
              onSamePageHeadingClick={onDocHeadingLinkClick}
              onInternalNoteNavigate={onInternalNoteNavigate}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 justify-end border-b border-border px-3 py-2">
          <button type="button" className={docHubDismissBtn} onClick={closeBundled}>
            Close
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-5 text-[13px] text-muted-foreground">
          <p className="font-medium text-foreground">Guide not available</p>
          <p>
            This note id is not in the current workspace, or notes have not finished loading. Open a project and ensure
            bundled docs have seeded.
          </p>
        </div>
      </div>
    );
  }

  if (!doc || !commandMarkdownNote) {
    if (hubLoading) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-[13px] text-muted-foreground">
          Loading overview…
        </div>
      );
    }
    if (hubNote) {
      return (
        <div ref={scrollRootRef} className="flex h-full min-h-0 flex-col overflow-auto p-5 text-[13px] text-muted-foreground">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Bundled overview (read-only)
          </div>
          <MarkdownRenderer
            note={hubNote}
            onSamePageHeadingClick={onDocHeadingLinkClick}
            onInternalNoteNavigate={onInternalNoteNavigate}
          />
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-5 text-[13px] text-muted-foreground">
        <p className="font-medium text-foreground">Documentation overview not available</p>
        <p>
          {hubError ? esc(hubError) : "Open a workspace so bundled documentation can seed from the repository."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 justify-end border-b border-border px-3 py-2">
        <button type="button" className={docHubDismissBtn} onClick={backToHubOverview}>
          Back to overview
        </button>
      </div>
      <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-auto">
        <MarkdownRenderer
          note={commandMarkdownNote}
          onSamePageHeadingClick={onDocHeadingLinkClick}
          onInternalNoteNavigate={onInternalNoteNavigate}
        />
      </div>
    </div>
  );
}
