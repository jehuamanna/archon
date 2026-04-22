import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import type { Note } from "@archon/ui-types";
import type { AppDispatch } from "../../../../store";
import { patchNoteMetadata, saveNoteContent } from "../../../../store/notesSlice";
import { MdxRenderer } from "../../../../components/renderers/MdxRenderer";
import { useAuth } from "../../../../auth/AuthContext";
import { useTheme } from "../../../../theme/ThemeContext";
import {
  canonicalVfsPathFromLinkRow,
  isSameProjectRelativeVfsPath,
  markdownVfsNoteHref,
  markdownVfsNoteHrefSameProjectRelative,
  resolveSameProjectRelativeVfsToCanonical,
  resolveTreeRelativeVfsPath,
} from "../../../../../shared/note-vfs-path";
import type { WpnNoteWithContextListItem } from "../../../../../shared/wpn-v2-types";
import type { InternalMarkdownNoteLink } from "../../../../utils/markdown-internal-note-href";
import { MarkdownNoteLinkPickerModal } from "./MarkdownNoteLinkPickerModal";
import { MarkdownNoteLinkAutocompletePopover } from "./MarkdownNoteLinkAutocompletePopover";
import { ARCHON_MARKDOWN_OPEN_NOTE_LINK_PICKER_EVENT } from "./markdownNoteLinkEvents";
import { findActiveWikiLinkTrigger } from "./markdownWikiLinkTrigger";
import {
  mdxNoteEditorExtensions,
  type MdxNoteOnBlurRef,
  type MdxNoteSelectionSyncRef,
  type MdxNoteWikiKeymapState,
} from "./mdx-note-editor-codemirror";
import { useArchonNoteModeLine } from "../../../useArchonNoteModeLine";
import { useShellActiveMainTab } from "../../../ShellActiveTabContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { isShellNoteEditorTabType } from "../../shellWorkspaceIds";
import type { ShellNoteTabState } from "../../../shellTabUrlSync";
import { fetchWpnNoteLinkIndex, filterWpnNoteLinkRows, type WpnNoteLinkRow } from "./wpnNoteLinkIndex";

type MdxViewMode = "editor" | "preview" | "both";

function lineColAt(text: string, offset: number): { line: number; col: number } {
  const head = Math.max(0, Math.min(offset, text.length));
  const lines = text.slice(0, head).split("\n");
  const line = lines.length;
  const col = (lines[lines.length - 1] ?? "").length + 1;
  return { line, col };
}

const MDX_AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * MDX note editor: CodeMirror + debounced live MDX preview (same React tree as the shell).
 * Persists via debounced writes: one save after typing idles for {@link MDX_AUTOSAVE_DEBOUNCE_MS}, plus immediate flush on blur and when leaving the note.
 */
export function MdxNoteEditor({
  note,
  persist,
}: {
  note: Note;
  persist: boolean;
}): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const auth = useAuth();
  const { resolvedDark } = useTheme();
  const shellActiveMainTab = useShellActiveMainTab();
  const { tabs: shellTabs } = useShellRegistries();
  const [value, setValue] = useState(note.content ?? "");
  const [previewContent, setPreviewContent] = useState(note.content ?? "");
  const [caretHead, setCaretHead] = useState(0);
  const latestRef = useRef(note.content ?? "");
  const flushTimerRef = useRef<number | null>(null);
  const persistRef = useRef(persist);
  const noteIdRef = useRef(note.id);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const cmHostRef = useRef<HTMLDivElement | null>(null);
  const cmViewRef = useRef<EditorView | null>(null);
  const cmResizeRafRef = useRef(0);
  const lastCaretRef = useRef({ start: 0, end: 0 });
  const wikiIndexCacheRef = useRef<WpnNoteLinkRow[] | null>(null);
  const rawNotesCacheRef = useRef<WpnNoteWithContextListItem[] | null>(null);
  const wikiKeymapRef = useRef<MdxNoteWikiKeymapState>({
    readOnly: false,
    active: false,
    rowCount: 0,
    onArrowDown: () => {},
    onArrowUp: () => {},
    onEnter: () => {},
    onEscape: () => {},
  });
  const selectionSyncRef: MdxNoteSelectionSyncRef = useRef(null);
  const onBlurRef: MdxNoteOnBlurRef = useRef(null);

  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [wikiDismissed, setWikiDismissed] = useState(false);
  const [wikiRows, setWikiRows] = useState<WpnNoteLinkRow[]>([]);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiError, setWikiError] = useState<string | null>(null);
  const [wikiSelected, setWikiSelected] = useState(0);
  const [wikiAnchor, setWikiAnchor] = useState<DOMRect | null>(null);

  const meta = (note.metadata ?? {}) as Record<string, unknown>;
  const isAdmin = auth.state.status === "authed" && auth.state.user.isAdmin === true;
  const readOnly =
    meta.docsReadOnly === true ||
    meta.readOnly === true ||
    (meta.bundledDoc === true && !isAdmin);

  const [viewMode, setViewMode] = useState<MdxViewMode>(() => {
    const raw =
      note.metadata && typeof note.metadata === "object"
        ? (note.metadata as Record<string, unknown>).markdownViewMode
        : undefined;
    return raw === "editor" || raw === "preview" || raw === "both" ? raw : "both";
  });

  persistRef.current = persist;
  noteIdRef.current = note.id;

  const pendingHeadingSlug =
    shellActiveMainTab &&
    isShellNoteEditorTabType(shellActiveMainTab.tabTypeId) &&
    (shellActiveMainTab.state as ShellNoteTabState | undefined)?.noteId === note.id
      ? (shellActiveMainTab.state as ShellNoteTabState | undefined)?.markdownHeadingSlug
      : undefined;

  const wikiTrig = useMemo(
    () => (!readOnly ? findActiveWikiLinkTrigger(value, caretHead) : null),
    [readOnly, value, caretHead],
  );

  const showWiki = Boolean(wikiTrig) && !wikiDismissed;

  const mdxModeLineLabel = useMemo(() => {
    if (readOnly) return "Preview";
    if (viewMode === "both") return "Split";
    if (viewMode === "editor") return "Editor";
    return "Preview";
  }, [readOnly, viewMode]);

  const mdxModeLineSecondary = useMemo(() => {
    const parts: string[] = [];
    if (wikiLoading) parts.push("Resolving wiki links…");
    if (showWiki && wikiRows.length > 0) {
      parts.push(`Wiki pick ${wikiSelected + 1}/${wikiRows.length}`);
    }
    if (!readOnly && viewMode !== "preview") {
      const { line, col } = lineColAt(value, caretHead);
      parts.push(`Ln ${line}, Col ${col}`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [
    caretHead,
    readOnly,
    showWiki,
    value,
    viewMode,
    wikiLoading,
    wikiRows.length,
    wikiSelected,
  ]);

  useArchonNoteModeLine({
    scopeId: note.id,
    primaryLine: `MDX · ${mdxModeLineLabel}`,
    secondaryLine: mdxModeLineSecondary,
    sourcePluginId: "archon.mdx",
  });

  const prevWikiTrigRef = useRef<ReturnType<typeof findActiveWikiLinkTrigger>>(null);
  useEffect(() => {
    if (wikiTrig === null && prevWikiTrigRef.current !== null) {
      setWikiDismissed(false);
    }
    prevWikiTrigRef.current = wikiTrig;
  }, [wikiTrig]);

  useEffect(() => {
    setWikiSelected(0);
    setWikiDismissed(false);
  }, [wikiTrig?.filter]);

  useEffect(() => {
    wikiIndexCacheRef.current = null;
    rawNotesCacheRef.current = null;
    setWikiRows([]);
    setWikiError(null);
    setWikiDismissed(false);
  }, [note.id]);

  // Eagerly load the note link index for broken-link detection in the preview.
  useEffect(() => {
    if (wikiIndexCacheRef.current) {
      if (wikiRows.length === 0) setWikiRows(wikiIndexCacheRef.current);
      return;
    }
    let cancelled = false;
    void fetchWpnNoteLinkIndex()
      .then(({ rows: list, rawNotes }) => {
        if (cancelled) return;
        wikiIndexCacheRef.current = list;
        rawNotesCacheRef.current = rawNotes;
        setWikiRows(list);
      })
      .catch(() => {
        /* broken-link detection degrades gracefully — no error shown */
      });
    return () => {
      cancelled = true;
    };
  }, [note.id]);

  useEffect(() => {
    if (!showWiki) return;
    if (wikiIndexCacheRef.current) {
      setWikiRows(wikiIndexCacheRef.current);
      return;
    }
    let cancelled = false;
    setWikiLoading(true);
    setWikiError(null);
    void fetchWpnNoteLinkIndex()
      .then(({ rows: list, rawNotes }) => {
        if (cancelled) return;
        wikiIndexCacheRef.current = list;
        rawNotesCacheRef.current = rawNotes;
        setWikiRows(list);
      })
      .catch(() => {
        if (cancelled) return;
        setWikiError("Could not load notes.");
        setWikiRows([]);
      })
      .finally(() => {
        if (!cancelled) setWikiLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showWiki]);

  useEffect(() => {
    if (!showWiki) return;
    const sync = (): void => {
      const view = cmViewRef.current;
      if (!view) return;
      const pos = view.state.selection.main.head;
      const coords = view.coordsAtPos(pos);
      if (coords) {
        const w = Math.max(coords.right - coords.left, 8);
        const h = Math.max(coords.bottom - coords.top, 14);
        setWikiAnchor(new DOMRect(coords.left, coords.top, w, h));
      } else {
        setWikiAnchor(view.dom.getBoundingClientRect());
      }
    };
    sync();
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [showWiki, value, viewMode, caretHead]);

  useEffect(() => {
    const c = note.content ?? "";
    setValue(c);
    latestRef.current = c;
    setPreviewContent(c);
  }, [note.id]);

  useEffect(() => {
    const id = window.setTimeout(() => setPreviewContent(value), 160);
    return () => clearTimeout(id);
  }, [value]);

  useEffect(() => {
    const raw =
      note.metadata && typeof note.metadata === "object"
        ? (note.metadata as Record<string, unknown>).markdownViewMode
        : undefined;
    const next: MdxViewMode =
      raw === "editor" || raw === "preview" || raw === "both" ? raw : "both";
    setViewMode(readOnly ? "preview" : next);
  }, [note.id, note.metadata]);

  useEffect(() => {
    const onOpenPicker = (e: Event): void => {
      const d = (e as CustomEvent<{ noteId?: unknown }>).detail;
      const id = typeof d?.noteId === "string" ? d.noteId : "";
      if (!id || id !== noteIdRef.current) return;
      if (readOnly) return;
      setLinkPickerOpen(true);
    };
    window.addEventListener(ARCHON_MARKDOWN_OPEN_NOTE_LINK_PICKER_EVENT, onOpenPicker as EventListener);
    return () => {
      window.removeEventListener(ARCHON_MARKDOWN_OPEN_NOTE_LINK_PICKER_EVENT, onOpenPicker as EventListener);
    };
  }, [note.id, readOnly]);

  const setAndPersistViewMode = useCallback(
    (next: MdxViewMode) => {
      if (readOnly) return;
      setViewMode(next);
      if (!persistRef.current) return;
      void dispatch(patchNoteMetadata({ noteId: noteIdRef.current, patch: { markdownViewMode: next } }));
    },
    [dispatch],
  );

  useEffect(() => {
    const onScrollTo = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { noteId?: unknown; slug?: unknown }
        | undefined;
      const noteId = typeof detail?.noteId === "string" ? detail.noteId : "";
      const slug = typeof detail?.slug === "string" ? detail.slug : "";
      if (!noteId || noteId !== noteIdRef.current) return;
      if (!slug) return;

      if (viewMode === "editor") {
        setAndPersistViewMode("both");
      }

      const deadline = performance.now() + 900;
      const tryScroll = () => {
        const root = previewScrollRef.current;
        if (root) {
          const target = root.querySelector<HTMLElement>(`#${CSS.escape(slug)}`);
          if (target) {
            target.scrollIntoView({ block: "start", behavior: "smooth" });
            return;
          }
        }
        if (performance.now() < deadline) {
          requestAnimationFrame(tryScroll);
        }
      };
      requestAnimationFrame(tryScroll);
    };

    window.addEventListener("archon:markdown-scroll-to-heading", onScrollTo as EventListener);
    return () => {
      window.removeEventListener("archon:markdown-scroll-to-heading", onScrollTo as EventListener);
    };
  }, [setAndPersistViewMode, viewMode]);

  const headingScrollDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || !pendingHeadingSlug) {
      headingScrollDoneRef.current = null;
      return;
    }
    const tab = shellActiveMainTab;
    if (!tab?.instanceId || !isShellNoteEditorTabType(tab.tabTypeId)) return;
    const slug = pendingHeadingSlug;
    if (headingScrollDoneRef.current === slug) return;

    if (viewMode === "editor") {
      setAndPersistViewMode("both");
    }

    let alive = true;
    const deadline = performance.now() + 900;
    const instId = tab.instanceId;
    const clearSlugOnTab = (): void => {
      shellTabs.updateTabPresentation(instId, { state: { noteId: note.id } });
    };

    const tryScroll = (): void => {
      if (!alive) return;
      const root = previewScrollRef.current;
      if (root) {
        const target = root.querySelector<HTMLElement>(`#${CSS.escape(slug)}`);
        if (target) {
          target.scrollIntoView({ block: "start", behavior: "smooth" });
          headingScrollDoneRef.current = slug;
          clearSlugOnTab();
          return;
        }
      }
      if (performance.now() < deadline) {
        requestAnimationFrame(tryScroll);
      } else {
        headingScrollDoneRef.current = slug;
        clearSlugOnTab();
      }
    };
    requestAnimationFrame(tryScroll);
    return () => {
      alive = false;
    };
  }, [
    note.id,
    pendingHeadingSlug,
    previewContent,
    readOnly,
    setAndPersistViewMode,
    shellActiveMainTab,
    shellTabs,
    viewMode,
  ]);

  const previewNote = useMemo<Note>(
    () => ({
      id: note.id,
      type: "mdx",
      title: note.title ?? "MDX",
      content: previewContent,
      metadata: note.metadata,
    }),
    [note.id, note.metadata, note.title, previewContent],
  );

  const isLinkTargetValid = useMemo(() => {
    const rows = wikiIndexCacheRef.current;
    if (!rows || rows.length === 0) return undefined;
    const noteIdSet = new Set(rows.map((r) => r.noteId));
    const vfsPathSet = new Set(rows.map((r) => canonicalVfsPathFromLinkRow(r)));
    const selfRow = rows.find((r) => r.noteId === note.id);
    return (link: InternalMarkdownNoteLink): boolean => {
      if (link.kind === "noteId") return noteIdSet.has(link.noteId);
      const vfs = link.vfsPath;
      if (vfs.startsWith("..")) {
        const rawNotes = rawNotesCacheRef.current;
        if (!rawNotes || rawNotes.length === 0) return true; // can't resolve — assume valid
        const resolved = resolveTreeRelativeVfsPath(vfs, note.id, rawNotes);
        return resolved !== null;
      }
      if (isSameProjectRelativeVfsPath(vfs)) {
        if (!selfRow) return true; // can't resolve — assume valid
        const canonical = resolveSameProjectRelativeVfsToCanonical(vfs, {
          workspace_name: selfRow.workspaceName,
          project_name: selfRow.projectName,
        });
        return canonical ? vfsPathSet.has(canonical) : true;
      }
      return vfsPathSet.has(vfs);
    };
  }, [wikiRows, note.id]);

  const flushNow = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (!persistRef.current) return;
    void dispatch(
      saveNoteContent({ noteId: noteIdRef.current, content: latestRef.current }),
    );
  }, [dispatch]);

  const scheduleBatchedFlush = useCallback(() => {
    if (!persistRef.current) return;
    // Debounce: reset the idle timer on every keystroke so only the trailing save fires.
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      if (!persistRef.current) return;
      void dispatch(
        saveNoteContent({ noteId: noteIdRef.current, content: latestRef.current }),
      );
    }, MDX_AUTOSAVE_DEBOUNCE_MS);
  }, [dispatch]);

  useEffect(() => {
    const idWhenAttached = note.id;
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (persistRef.current) {
        void dispatch(
          saveNoteContent({ noteId: idWhenAttached, content: latestRef.current }),
        );
      }
    };
  }, [note.id, dispatch]);

  const insertMdxNoteLink = useCallback(
    (row: WpnNoteLinkRow, replaceRange?: { start: number; end: number }) => {
      const label = row.title.trim() || "Untitled";
      const vfsPath = canonicalVfsPathFromLinkRow(row);
      const selfRow = wikiRows.find((r) => r.noteId === note.id);
      const sameProject =
        selfRow &&
        selfRow.workspaceName === row.workspaceName &&
        selfRow.projectName === row.projectName;
      const href = sameProject
        ? markdownVfsNoteHrefSameProjectRelative(row.title)
        : markdownVfsNoteHref(vfsPath);
      const md = `[${label}](${href})`;
      const view = cmViewRef.current;
      const text = latestRef.current;

      let start: number;
      let end: number;
      if (replaceRange) {
        start = replaceRange.start;
        end = replaceRange.end;
      } else if (view?.hasFocus) {
        const m = view.state.selection.main;
        start = m.from;
        end = m.to;
      } else {
        start = lastCaretRef.current.start;
        end = lastCaretRef.current.end;
      }

      const labelStart = start + 1;
      const labelEnd = labelStart + label.length;

      if (view && !readOnly) {
        view.dispatch({
          changes: { from: start, to: end, insert: md },
          selection: { anchor: labelStart, head: labelEnd },
        });
        const next = view.state.doc.toString();
        setValue(next);
        latestRef.current = next;
        setCaretHead(labelEnd);
        lastCaretRef.current = { start: labelStart, end: labelEnd };
        setSel({ start: labelStart, end: labelEnd });
        scheduleBatchedFlush();
        requestAnimationFrame(() => view.focus());
      } else {
        const next = text.slice(0, start) + md + text.slice(end);
        setValue(next);
        latestRef.current = next;
        setCaretHead(labelEnd);
        lastCaretRef.current = { start: labelStart, end: labelEnd };
        setSel({ start: labelStart, end: labelEnd });
        scheduleBatchedFlush();
        requestAnimationFrame(() => {
          cmViewRef.current?.focus();
        });
      }
    },
    [readOnly, scheduleBatchedFlush, wikiRows, note.id],
  );

  const filteredWikiRows = useMemo(() => {
    const ex = note.id.trim();
    const base = ex ? wikiRows.filter((r) => r.noteId !== ex) : wikiRows;
    return filterWpnNoteLinkRows(base, wikiTrig?.filter ?? "");
  }, [wikiRows, wikiTrig?.filter, note.id]);

  const wikiSelectedClamped = Math.min(
    wikiSelected,
    Math.max(0, filteredWikiRows.length - 1),
  );

  const completeWikiLink = useCallback(
    (row: WpnNoteLinkRow) => {
      if (!wikiTrig) return;
      const view = cmViewRef.current;
      const end = view?.state.selection.main.head ?? sel.end;
      insertMdxNoteLink(row, { start: wikiTrig.start, end });
      setWikiDismissed(false);
    },
    [insertMdxNoteLink, sel.end, wikiTrig],
  );

  const cmExtensions = useMemo(
    () =>
      mdxNoteEditorExtensions({
        dark: resolvedDark,
        readOnly,
        wikiKeymapRef,
        selectionSyncRef,
        onBlurRef,
      }),
    [readOnly, resolvedDark],
  );

  useEffect(() => {
    const host = cmHostRef.current;
    if (!host) return;
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      if (cmResizeRafRef.current) cancelAnimationFrame(cmResizeRafRef.current);
      cmResizeRafRef.current = requestAnimationFrame(() => {
        cmResizeRafRef.current = 0;
        cmViewRef.current?.requestMeasure();
      });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (cmResizeRafRef.current) {
        cancelAnimationFrame(cmResizeRafRef.current);
        cmResizeRafRef.current = 0;
      }
    };
  }, [readOnly, viewMode]);

  useEffect(() => {
    if (readOnly || (viewMode !== "editor" && viewMode !== "both")) {
      cmViewRef.current = null;
    }
  }, [readOnly, viewMode]);

  selectionSyncRef.current = (from, to, head) => {
    lastCaretRef.current = { start: from, end: to };
    setSel({ start: from, end: to });
    setCaretHead(head);
  };

  onBlurRef.current = () => {
    const view = cmViewRef.current;
    if (view) {
      const m = view.state.selection.main;
      lastCaretRef.current = { start: m.from, end: m.to };
    }
    flushNow();
  };

  wikiKeymapRef.current.readOnly = readOnly;
  wikiKeymapRef.current.active = showWiki;
  wikiKeymapRef.current.rowCount = filteredWikiRows.length;
  wikiKeymapRef.current.onArrowDown = () => {
    const n = wikiKeymapRef.current.rowCount;
    if (n === 0) return;
    setWikiSelected((s) => Math.min(n - 1, s + 1));
  };
  wikiKeymapRef.current.onArrowUp = () => {
    const n = wikiKeymapRef.current.rowCount;
    if (n === 0) return;
    setWikiSelected((s) => Math.max(0, s - 1));
  };
  wikiKeymapRef.current.onEnter = () => {
    const row = filteredWikiRows[wikiSelectedClamped];
    if (row) completeWikiLink(row);
  };
  wikiKeymapRef.current.onEscape = () => {
    setWikiDismissed(true);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {!readOnly ? (
        <div className="flex shrink-0 items-center justify-between gap-2 pb-3">
          <div className="inline-flex overflow-hidden rounded-md border border-border bg-muted/10">
            {(
              [
                ["editor", "Editor"],
                ["preview", "Preview"],
                ["both", "Both"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`px-3 py-1.5 text-[11px] font-medium outline-none transition-colors ${
                  viewMode === id
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                }`}
                onClick={() => setAndPersistViewMode(id)}
                aria-pressed={viewMode === id}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted/40"
              onClick={() => setLinkPickerOpen(true)}
            >
              Link to note (path)
            </button>
            <div className="text-[11px] text-muted-foreground">MDX</div>
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 items-center justify-between gap-2 pb-3">
          <div className="text-[11px] font-medium text-muted-foreground">Preview</div>
          <div className="text-[11px] text-muted-foreground">Read-only</div>
        </div>
      )}

      <div className="flex h-full min-h-0 w-full flex-col gap-3 md:flex-row">
        {!readOnly && (viewMode === "editor" || viewMode === "both") ? (
          <div className="relative flex min-h-[240px] min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-background">
            <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Source
            </div>
            <div ref={cmHostRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <CodeMirror
                value={value}
                height="100%"
                theme="none"
                basicSetup={false}
                className="archon-md-cm h-full min-h-0 overflow-hidden text-[13px] [&_.cm-editor]:flex [&_.cm-editor]:h-full [&_.cm-editor]:min-h-0 [&_.cm-editor]:flex-col [&_.cm-scroller]:min-h-0 [&_.cm-scroller]:flex-1"
                extensions={cmExtensions}
                editable={!readOnly}
                onCreateEditor={(view) => {
                  cmViewRef.current = view;
                  view.requestMeasure();
                }}
                onChange={(v) => {
                  setValue(v);
                  latestRef.current = v;
                  scheduleBatchedFlush();
                }}
              />
            </div>
          </div>
        ) : null}

        {viewMode === "preview" || viewMode === "both" ? (
          <div className="flex min-h-[240px] min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-background">
            <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Preview
            </div>
            <div
              className="min-h-0 flex-1 overflow-auto"
              ref={previewScrollRef}
              data-archon-md-preview
            >
              <MdxRenderer note={previewNote} isLinkTargetValid={isLinkTargetValid} />
            </div>
          </div>
        ) : null}
      </div>

      <MarkdownNoteLinkPickerModal
        open={linkPickerOpen}
        onClose={() => setLinkPickerOpen(false)}
        excludeNoteId={note.id}
        onPick={(row) => insertMdxNoteLink(row)}
      />

      <MarkdownNoteLinkAutocompletePopover
        open={showWiki}
        anchorRect={wikiAnchor}
        loading={wikiLoading}
        error={wikiError}
        rows={filteredWikiRows}
        selectedIndex={wikiSelectedClamped}
        onSelect={(row) => completeWikiLink(row)}
      />
    </div>
  );
}
