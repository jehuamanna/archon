import CodeMirror, { ExternalChange } from "@uiw/react-codemirror";
import { keymap, type EditorView } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { Note } from "@archon/ui-types";
import type { AppDispatch, RootState } from "../../../../store";
import { patchNoteMetadata, saveNoteContent } from "../../../../store/notesSlice";
import {
  useYjsBodyShadow,
  colorForUserId,
  type CollabUser,
} from "./useYjsBodyShadow";
import { MdxRenderer } from "../../../../components/renderers/MdxRenderer";
import { useAuth } from "../../../../auth/AuthContext";
import { useTheme } from "../../../../theme/ThemeContext";
import {
  canonicalVfsPathFromLinkRow,
  isSameProjectRelativeVfsPath,
  markdownVfsNoteHref,
  markdownVfsNoteHrefSameProjectRelative,
  resolveNoteIdByCanonicalVfsPath,
  resolveSameProjectRelativeVfsToCanonical,
  resolveTreeRelativeVfsPath,
} from "../../../../../shared/note-vfs-path";
import type { WpnNoteWithContextListItem } from "../../../../../shared/wpn-v2-types";
import type { InternalMarkdownNoteLink } from "../../../../utils/markdown-internal-note-href";
import { MarkdownNoteLinkPickerModal } from "./MarkdownNoteLinkPickerModal";
import { MarkdownNoteLinkAutocompletePopover } from "./MarkdownNoteLinkAutocompletePopover";
import { NoteCheckpointSaveModal } from "./NoteCheckpointSaveModal";
import { NoteCheckpointHistoryPanel } from "./NoteCheckpointHistoryPanel";
import { ARCHON_MARKDOWN_OPEN_NOTE_LINK_PICKER_EVENT } from "./markdownNoteLinkEvents";
import { findActiveWikiLinkTrigger } from "./markdownWikiLinkTrigger";
import {
  mdxNoteEditorExtensions,
  type MdxNoteOnBlurRef,
  type MdxNoteSelectionSyncRef,
  type MdxNoteWikiKeymapState,
} from "./mdx-note-editor-codemirror";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { useArchonNoteModeLine } from "../../../useArchonNoteModeLine";
import { useShellActiveMainTab } from "../../../ShellActiveTabContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { useShellNavigation } from "../../../useShellNavigation";
import { isShellNoteEditorTabType } from "../../shellWorkspaceIds";
import type { ShellNoteTabState } from "../../../shellTabUrlSync";
import {
  fetchWpnNoteLinkIndex,
  filterWpnNoteLinkRows,
  getCachedWpnNoteLinkIndex,
  subscribeWpnNoteLinkIndexInvalidated,
  type WpnNoteLinkRow,
} from "./wpnNoteLinkIndex";

type MdxViewMode = "editor" | "preview" | "both";

function lineColAt(text: string, offset: number): { line: number; col: number } {
  const head = Math.max(0, Math.min(offset, text.length));
  const lines = text.slice(0, head).split("\n");
  const line = lines.length;
  const col = (lines[lines.length - 1] ?? "").length + 1;
  return { line, col };
}

const MDX_AUTOSAVE_DEBOUNCE_MS = 150;
const MDX_AUTOSAVE_MAX_WAIT_MS = 750;

/**
 * MDX note editor: CodeMirror + debounced live MDX preview (same React tree as the shell).
 * Persists via debounced writes: one save after typing idles for {@link MDX_AUTOSAVE_DEBOUNCE_MS},
 * with a hard cap of {@link MDX_AUTOSAVE_MAX_WAIT_MS} so continuous typing still flushes
 * regularly. Plus immediate flush on blur and when leaving the note.
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
  const firstScheduledAtRef = useRef<number | null>(null);
  const persistRef = useRef(persist);
  const noteIdRef = useRef(note.id);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const cmHostRef = useRef<HTMLDivElement | null>(null);
  const cmViewRef = useRef<EditorView | null>(null);
  const cmResizeRafRef = useRef(0);
  const lastCaretRef = useRef({ start: 0, end: 0 });
  // Seed from the shared module cache so components that mount after the
  // first link-index fetch get instant `isLinkTargetValid` lookups without
  // waiting for the (no-op) cache-hit promise to resolve.
  const wikiIndexCacheRef = useRef<WpnNoteLinkRow[] | null>(
    getCachedWpnNoteLinkIndex()?.rows ?? null,
  );
  const rawNotesCacheRef = useRef<WpnNoteWithContextListItem[] | null>(
    getCachedWpnNoteLinkIndex()?.rawNotes ?? null,
  );
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
  const [checkpointSaveOpen, setCheckpointSaveOpen] = useState(false);
  const [checkpointHistoryOpen, setCheckpointHistoryOpen] = useState(false);
  // Tracks the most recent noteId for which yCollab has actually bound. Used
  // by the ExternalChange transaction filter (added in cmExtensions below)
  // to drop stale React-prop transactions once Y.Text owns the doc. See the
  // matching block in MarkdownNoteEditor for the full root-cause writeup.
  const lastYCollabBoundNoteIdRef = useRef<string | null>(null);
  const [linkPickerExclude, setLinkPickerExclude] = useState<string>("");
  // Set when an SDK component (e.g. <Slideshow>) opened the picker via
  // shell context. The modal's onPick checks this first; if set, the
  // picked row is converted to `{ label, href }` and forwarded — the
  // outer source editor is not touched. If null, the legacy behavior
  // (insert into the outer source CodeMirror via insertMdxNoteLink) runs.
  const pickerCallbackRef = useRef<
    ((link: { label: string; href: string }) => void) | null
  >(null);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [wikiDismissed, setWikiDismissed] = useState(false);
  const [wikiRows, setWikiRows] = useState<WpnNoteLinkRow[]>(
    () => getCachedWpnNoteLinkIndex()?.rows ?? [],
  );
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

  // Reset per-note autocomplete UI state (not the shared link index, which
  // is project-wide and shouldn't refetch on every navigation).
  useEffect(() => {
    setWikiError(null);
    setWikiDismissed(false);
  }, [note.id]);

  // Eagerly load the note link index for broken-link detection in the preview,
  // and refresh when ChromeOnlyWorkbench invalidates the shared cache (rename
  // / structural change). Hits the module-level cache in `wpnNoteLinkIndex.ts`
  // — at most one network round-trip per session per invalidation.
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
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
    };
    if (!wikiIndexCacheRef.current || wikiIndexCacheRef.current.length === 0) {
      refresh();
    }
    const unsub = subscribeWpnNoteLinkIndexInvalidated(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

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
      // Clear any SDK-supplied callback so the modal falls back to
      // `insertMdxNoteLink` (the source-pane behavior).
      pickerCallbackRef.current = null;
      setLinkPickerExclude("");
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
          project_name: selfRow.projectName,
        });
        return canonical ? vfsPathSet.has(canonical) : true;
      }
      return vfsPathSet.has(vfs);
    };
  }, [wikiRows, note.id]);

  // Hocuspocus body-collab WS. When connected, the editor binds CodeMirror
  // to `yText` directly via `yCollab(...)` (see cmExtensions below) and the
  // server bridges Y.Text → wpn_notes.content. When not connected, the
  // editor falls back to debounced HTTP PATCH.
  //
  // Use `orgMembership.activeOrgId` — see MarkdownNoteEditor for the
  // post-migration null-trap on `activeSpaceId`.
  const activeOrgId = useSelector(
    (s: RootState) => s.orgMembership.activeOrgId,
  );
  const collabUser: CollabUser | null = useMemo(() => {
    if (auth.state.status !== "authed") return null;
    const u = auth.state.user;
    const name = u.username || u.email.split("@")[0] || "User";
    return { id: u.id, name, color: colorForUserId(u.id) };
  }, [
    auth.state.status,
    auth.state.status === "authed" ? auth.state.user.id : null,
    auth.state.status === "authed" ? auth.state.user.username : null,
    auth.state.status === "authed" ? auth.state.user.email : null,
  ]);
  const yjsBody = useYjsBodyShadow(
    persist ? note.id : null,
    activeOrgId ?? null,
    collabUser,
  );
  const yjsBodyRef = useRef(yjsBody);
  yjsBodyRef.current = yjsBody;

  // Mirror the live Y.Text into React state for the components that read
  // `value` / `previewContent` (preview, wiki autocomplete, mode line).
  // The CodeMirror view itself is driven by yCollab; these mirrors are
  // read-only consumers.
  useEffect(() => {
    const ytext = yjsBody.yText;
    if (!ytext) return;
    const update = (): void => {
      const next = ytext.toString();
      if (latestRef.current === next) return;
      // Y.Text can be briefly empty before initial sync lands. If this
      // note already has non-empty content, don't clobber the mirror with
      // "" and let the seeded state arrive first.
      if (next === "" && latestRef.current.length > 0) return;
      latestRef.current = next;
      setValue(next);
      setPreviewContent(next);
    };
    update();
    ytext.observe(update);
    return () => {
      ytext.unobserve(update);
    };
  }, [yjsBody.yText, note.id]);

  const flushNow = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    firstScheduledAtRef.current = null;
    if (!persistRef.current) return;
    // yCollab persists each keystroke through Y.Text → onStoreDocument.
    if (yjsBodyRef.current.connected) return;
    void dispatch(
      saveNoteContent({ noteId: noteIdRef.current, content: latestRef.current }),
    );
  }, [dispatch]);

  const scheduleBatchedFlush = useCallback(() => {
    if (!persistRef.current) return;
    if (yjsBodyRef.current.connected) return;
    const now = Date.now();
    if (
      firstScheduledAtRef.current !== null &&
      now - firstScheduledAtRef.current >= MDX_AUTOSAVE_MAX_WAIT_MS
    ) {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      firstScheduledAtRef.current = null;
      void dispatch(
        saveNoteContent({ noteId: noteIdRef.current, content: latestRef.current }),
      );
      return;
    }
    if (firstScheduledAtRef.current === null) {
      firstScheduledAtRef.current = now;
    }
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      firstScheduledAtRef.current = null;
      if (!persistRef.current) return;
      if (yjsBodyRef.current.connected) return;
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
      firstScheduledAtRef.current = null;
      if (!persistRef.current) return;
      // yCollab persists each keystroke; only fall back to HTTP if WS is down.
      if (yjsBodyRef.current.connected) return;
      void dispatch(
        saveNoteContent({ noteId: idWhenAttached, content: latestRef.current }),
      );
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

  // Build a `{ label, href }` for a wiki-rows row. Always uses the full
  // canonical `Workspace/Project/Title` form (not the same-project
  // `./Title` shorthand the source-editor picker prefers). SDK components
  // store their content as project-state, so a deck may outlive the
  // editing context — the relative form would silently break if the
  // slide deck is later viewed from a note in a different project.
  const buildSdkNoteLink = useCallback(
    (row: WpnNoteLinkRow): { label: string; href: string } => {
      const vfsPath = canonicalVfsPathFromLinkRow(row);
      return {
        label: row.title.trim() || "Untitled",
        href: markdownVfsNoteHref(vfsPath),
      };
    },
    [],
  );

  // Drop-payload resolver injected into the MDX shell context so SDK
  // components (e.g. <Slideshow>) can decode WPN-explorer drag drops into
  // a markdown link without re-implementing the wiki-rows lookup.
  const resolveWpnNoteLink = useCallback(
    ({ noteId }: { projectId: string; noteId: string }): { label: string; href: string } | null => {
      const row = wikiRows.find((r) => r.noteId === noteId);
      if (!row) return null;
      return buildSdkNoteLink(row);
    },
    [wikiRows, buildSdkNoteLink],
  );

  // Click-driven picker opener for SDK components. Stores the callback
  // and opens the existing `<MarkdownNoteLinkPickerModal>` — the modal's
  // onPick branches on `pickerCallbackRef` to route to the SDK consumer
  // instead of the outer source editor.
  const openWpnNoteLinkPicker = useCallback(
    (
      onPick: (link: { label: string; href: string }) => void,
      options?: { excludeNoteId?: string },
    ) => {
      pickerCallbackRef.current = onPick;
      setLinkPickerExclude(options?.excludeNoteId ?? note.id);
      setLinkPickerOpen(true);
    },
    [note.id],
  );

  // Open an internal note link (`#/w/...` or note-id form) in a NEW
  // Archon shell tab — not a new browser tab. Used by SDK components
  // like <Slideshow> whose rendered links should stay inside the
  // workbench. Resolves vfs forms to a noteId via the wikiRows / rawNotes
  // cache; falls back to noting "couldn't resolve" silently (the click
  // is preventDefault'd, so nothing happens — better than navigating
  // the current tab away from the deck).
  const { openNoteById } = useShellNavigation();
  const openInternalNoteLinkInNewTab = useCallback(
    (link: InternalMarkdownNoteLink): void => {
      const slug = link.markdownHeadingSlug;
      if (link.kind === "noteId") {
        const row = wikiRows.find((r) => r.noteId === link.noteId);
        openNoteById(link.noteId, {
          newTab: true,
          ...(row?.title ? { title: row.title } : {}),
          ...(slug ? { markdownHeadingSlug: slug } : {}),
        });
        return;
      }
      // vfs kind — resolve via the link index. Try canonical first, then
      // tree-relative or same-project shorthands.
      const rawNotes = rawNotesCacheRef.current ?? [];
      const vfs = link.vfsPath;
      let canonical: string | null = null;
      let resolvedId: string | null = null;
      if (vfs.startsWith("..") && rawNotes.length > 0) {
        canonical = resolveTreeRelativeVfsPath(vfs, note.id, rawNotes);
      } else if (isSameProjectRelativeVfsPath(vfs)) {
        const selfRow = wikiRows.find((r) => r.noteId === note.id);
        if (selfRow) {
          canonical = resolveSameProjectRelativeVfsToCanonical(vfs, {
            project_name: selfRow.projectName,
          });
        }
      } else {
        canonical = vfs;
      }
      if (canonical) {
        // Match canonical against rawNotes; fall back to wikiRows-derived path.
        if (rawNotes.length > 0) {
          resolvedId = resolveNoteIdByCanonicalVfsPath(rawNotes, canonical);
        }
        if (!resolvedId) {
          const row = wikiRows.find(
            (r) => canonicalVfsPathFromLinkRow(r) === canonical,
          );
          resolvedId = row?.noteId ?? null;
        }
      }
      if (!resolvedId) return;
      const resolvedRow = wikiRows.find((r) => r.noteId === resolvedId);
      openNoteById(resolvedId, {
        newTab: true,
        ...(resolvedRow?.title ? { title: resolvedRow.title } : {}),
        ...(canonical ? { canonicalVfsPath: canonical } : {}),
        ...(slug ? { markdownHeadingSlug: slug } : {}),
      });
    },
    [openNoteById, note.id, wikiRows],
  );

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

  const cmExtensions = useMemo(() => {
    const ext = mdxNoteEditorExtensions({
      dark: resolvedDark,
      readOnly,
      wikiKeymapRef,
      selectionSyncRef,
      onBlurRef,
    });
    // Drop ExternalChange transactions once yCollab has bound for this note.
    // @uiw/react-codemirror dispatches ExternalChange whenever the `value`
    // prop changes; while yCollab owns the doc, any such tx is a stale
    // closure (connected→disconnected flicker, route-back-to-note, etc.)
    // and would clobber Y.Text. Pre-bind, ExternalChange is legitimate
    // (REST content load) so we keep a defensive shrink-to-empty guard
    // active in that window. See MarkdownNoteEditor for the full writeup.
    ext.push(
      EditorState.transactionFilter.of((tr) => {
        if (tr.annotation(ExternalChange) !== true) return tr;
        if (!tr.docChanged) return tr;
        if (lastYCollabBoundNoteIdRef.current === note.id) {
          // eslint-disable-next-line no-console
          console.warn(
            "[mdx-editor] dropped post-bind ExternalChange tx (stale value prop)",
            {
              noteId: note.id,
              startLen: tr.startState.doc.length,
              newLen: tr.newDoc.length,
            },
          );
          return [];
        }
        const startLen = tr.startState.doc.length;
        const newLen = tr.newDoc.length;
        if (startLen > 0 && newLen < startLen) {
          // eslint-disable-next-line no-console
          console.warn(
            "[mdx-editor] dropped pre-bind ExternalChange shrink tx",
            { noteId: note.id, startLen, newLen },
          );
          return [];
        }
        return tr;
      }),
    );
    // Bind CodeMirror to live Y.Text via yCollab when WS provides one.
    if (yjsBody.yText) {
      ext.push(yCollab(yjsBody.yText, yjsBody.awareness));
      // yCollab's UndoManager already only tracks the local YSyncConfig
      // origin, but yCollab does not install its keymap. Without this,
      // Cmd-Z falls through to historyKeymap and runs CodeMirror's native
      // EditorState undo — which reverts remote edits too. Route Mod-z/y/
      // Shift-z to the user-scoped Y.UndoManager at higher precedence.
      ext.push(Prec.high(keymap.of(yUndoManagerKeymap)));
    }
    return ext;
  }, [readOnly, resolvedDark, yjsBody.yText, yjsBody.awareness, note.id]);

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

  // Track the most recent noteId yCollab has bound for — used by the
  // ExternalChange transaction filter to drop stale value-prop tx after
  // first bind. See the matching block in MarkdownNoteEditor.
  useEffect(() => {
    if (yjsBody.yText) {
      lastYCollabBoundNoteIdRef.current = note.id;
    }
  }, [note.id, yjsBody.yText]);

  // First-connect cursor render fix — see the matching block in
  // MarkdownNoteEditor for the full root-cause writeup. Forces one
  // ViewUpdate after yCollab binds so yRemoteSelections' update() walks
  // the already-populated `awareness.getStates()` and renders pre-existing
  // peer carets immediately, instead of waiting for an idle local action.
  useEffect(() => {
    if (!yjsBody.yText || !yjsBody.awareness) return;
    const view = cmViewRef.current;
    if (!view) return;
    view.dispatch({ selection: view.state.selection });
  }, [yjsBody.yText, yjsBody.awareness]);

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
              onClick={() => {
                // Source-pane button: clear any prior SDK callback so the
                // modal's onPick uses `insertMdxNoteLink` (writes into the
                // outer source CodeMirror).
                pickerCallbackRef.current = null;
                setLinkPickerExclude("");
                setLinkPickerOpen(true);
              }}
            >
              Link to note (path)
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted/40"
              onClick={() => setCheckpointSaveOpen(true)}
              title="Save a restorable snapshot of the current contents"
            >
              Checkpoint
            </button>
            <button
              type="button"
              aria-pressed={checkpointHistoryOpen}
              className={`rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted/40 ${
                checkpointHistoryOpen
                  ? "bg-muted/60 text-foreground"
                  : "bg-background text-foreground"
              }`}
              onClick={() => setCheckpointHistoryOpen((v) => !v)}
              title="Show checkpoint history"
            >
              History
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
                // When yCollab is bound, pass undefined so @uiw/react-codemirror
                // skips its prop-driven dispatch — yCollab owns the doc.
                value={yjsBody.yText ? undefined : value}
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
              <MdxRenderer
                note={previewNote}
                isLinkTargetValid={isLinkTargetValid}
                resolveWpnNoteLink={resolveWpnNoteLink}
                openWpnNoteLinkPicker={openWpnNoteLinkPicker}
                openInternalNoteLinkInNewTab={openInternalNoteLinkInNewTab}
              />
            </div>
          </div>
        ) : null}

        {checkpointHistoryOpen ? (
          <NoteCheckpointHistoryPanel
            note={note}
            onClose={() => setCheckpointHistoryOpen(false)}
          />
        ) : null}
      </div>

      <NoteCheckpointSaveModal
        open={checkpointSaveOpen}
        noteId={note.id}
        onClose={() => setCheckpointSaveOpen(false)}
        onSaved={(_cp, deduped) => {
          setCheckpointHistoryOpen(true);
          if (deduped) {
            // eslint-disable-next-line no-console
            console.info("[checkpoint] deduped within 30s window");
          }
        }}
      />

      <MarkdownNoteLinkPickerModal
        open={linkPickerOpen}
        onClose={() => {
          setLinkPickerOpen(false);
          pickerCallbackRef.current = null;
        }}
        excludeNoteId={linkPickerExclude || note.id}
        onPick={(row) => {
          const cb = pickerCallbackRef.current;
          if (cb) {
            cb(buildSdkNoteLink(row));
            pickerCallbackRef.current = null;
          } else {
            insertMdxNoteLink(row);
          }
        }}
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
