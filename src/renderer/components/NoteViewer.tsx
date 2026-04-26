import { getArchon } from "../../shared/archon-host-access";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Note } from "@archon/ui-types";
import type { AppDispatch, RootState } from "../store";
import { clearNoteTitleDraft, setNoteTitleDraft } from "../store/notesSlice";
import { useToast } from "../toast/ToastContext";
import {
  getRegisteredTypesCached,
  invalidateArchonNoteTypesCaches,
} from "../utils/cached-archon-note-types";
import NoteTypeReactRenderer from "./renderers/NoteTypeReactRenderer";
import { useArchonContributionRegistry } from "../shell/ArchonContributionContext";
import {
  getCachedCanonicalVfsPathForNoteId,
  subscribeNoteVfsPathCacheInvalidated,
} from "../shell/noteIdVfsPathCache";

function relativeTimeShort(ms: number | undefined | null): string {
  if (!ms) return "—";
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

function useCachedNoteVfsPath(noteId: string): string | undefined {
  const [path, setPath] = useState<string | undefined>(() =>
    getCachedCanonicalVfsPathForNoteId(noteId),
  );
  useEffect(() => {
    setPath(getCachedCanonicalVfsPathForNoteId(noteId));
    return subscribeNoteVfsPathCacheInvalidated(() => {
      setPath(getCachedCanonicalVfsPathForNoteId(noteId));
    });
  }, [noteId]);
  return path;
}

function CopyGlyph(props: { className?: string }): React.ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

interface NoteViewerProps {
  note: Note;
  /** Project folder that owns this note’s `assets/` (multi-root workspaces). */
  assetProjectRoot?: string | null;
  onTitleCommit: (title: string) => void | Promise<void>;
}

const NoteViewer: React.FC<NoteViewerProps> = ({
  note,
  assetProjectRoot = null,
  onTitleCommit,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const titleDraft = useSelector((s: RootState) => s.notes.noteTitleDraftById[note.id]);
  // `checking` on first mount so the fallback UI never flashes before the
  // plugin registry has been queried — the registration hooks in App.tsx run
  // their effects after the first render, so treating "unknown" as "missing"
  // produced a visible "No plugin installed" flicker before the editor.
  const [pluginState, setPluginState] = useState<"checking" | "ok" | "missing">(
    "checking",
  );
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    let warnTimer: ReturnType<typeof setTimeout> | null = null;

    const checkPlugin = async () => {
      const types = await getRegisteredTypesCached();
      if (cancelled) {
        return;
      }
      const ok = types.includes(note.type);
      setPluginState(ok ? "ok" : "missing");
      if (warnTimer) {
        clearTimeout(warnTimer);
        warnTimer = null;
      }
      if (!ok) {
        warnTimer = setTimeout(() => {
          void (async () => {
            const again = await getRegisteredTypesCached();
            if (cancelled || again.includes(note.type)) {
              return;
            }
            showToast({
              severity: "warning",
              message: `No plugin installed for note type "${note.type}". Install one from Plugin Manager.`,
              mergeKey: `note-no-plugin:${note.type}`,
            });
          })();
        }, 450);
      }
    };

    void checkPlugin();
    const off = getArchon().onPluginsChanged(() => {
      invalidateArchonNoteTypesCaches();
      void checkPlugin();
    });
    return () => {
      cancelled = true;
      if (warnTimer) {
        clearTimeout(warnTimer);
      }
      off();
    };
  }, [note.type, showToast]);

  const displayTitle = titleDraft !== undefined ? titleDraft : note.title;

  // Status-bar context: type + plugin badge + WPN path on the center segment;
  // created/updated relative timestamps on the right segment. Re-registers
  // (replacing by id) whenever the relevant fields change. Auto-disposes on
  // unmount so the bar is clean when no note is active.
  const contribRegistry = useArchonContributionRegistry();
  const vfsPath = useCachedNoteVfsPath(note.id);
  const hasPlugin = pluginState === "ok";
  const centerLine = useMemo(() => {
    const parts: string[] = [note.type];
    if (hasPlugin) parts.push("Plugin active");
    else if (pluginState === "missing") parts.push("No plugin");
    if (vfsPath) parts.push(vfsPath);
    return parts.join(" · ");
  }, [note.type, hasPlugin, pluginState, vfsPath]);
  const rightLine = useMemo(() => {
    const segments: string[] = [];
    if (note.updated_at_ms) segments.push(`Updated ${relativeTimeShort(note.updated_at_ms)}`);
    if (note.created_at_ms) segments.push(`Created ${relativeTimeShort(note.created_at_ms)}`);
    return segments.join(" · ");
  }, [note.updated_at_ms, note.created_at_ms]);
  useEffect(() => {
    const idC = `archon.note.context.${note.id}.center`;
    const idR = `archon.note.context.${note.id}.right`;
    const disposeC = contribRegistry.registerModeLineItem({
      id: idC,
      segment: "host.center",
      priority: 60,
      text: centerLine,
      sourcePluginId: "archon.note.context",
    });
    const disposeR = rightLine
      ? contribRegistry.registerModeLineItem({
          id: idR,
          segment: "host.right",
          priority: 60,
          text: rightLine,
          sourcePluginId: "archon.note.context",
        })
      : null;
    return () => {
      disposeC();
      disposeR?.();
    };
  }, [contribRegistry, note.id, centerLine, rightLine]);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el || titleEditing) {
      return;
    }
    if (el.textContent !== displayTitle) {
      el.textContent = displayTitle;
    }
  }, [note.id, displayTitle, titleEditing]);

  const renderNote = () => {
    if (pluginState === "checking") {
      return <div className="min-h-0 flex-1" aria-hidden />;
    }
    if (pluginState === "ok") {
      return (
        <NoteTypeReactRenderer note={note} assetProjectRoot={assetProjectRoot} />
      );
    }
    return (
      <div className="rounded-sm border border-border bg-muted/50 p-4">
        <p className="text-foreground">
          No plugin installed for type: <strong>{note.type}</strong>
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Install a plugin to handle this note type from the Plugin Manager.
        </p>
      </div>
    );
  };

  const copyNoteId = () => {
    void navigator.clipboard.writeText(note.id).then(
      () => {
        showToast({
          severity: "info",
          message: "Note id copied",
          mergeKey: "note-viewer-copy-id",
        });
      },
      () => {
        showToast({
          severity: "error",
          message: "Could not copy id (clipboard permission).",
          mergeKey: "note-viewer-copy-id-err",
        });
      },
    );
  };

  const commitTitleFromDom = async () => {
    const el = titleRef.current;
    if (!el) {
      return;
    }
    const raw = el.textContent ?? "";
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) {
      el.textContent = note.title;
      dispatch(clearNoteTitleDraft(note.id));
      setTitleEditing(false);
      return;
    }
    if (t !== note.title) {
      try {
        await onTitleCommit(t);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          el.textContent = note.title;
          dispatch(clearNoteTitleDraft(note.id));
          setTitleEditing(false);
          return;
        }
        setTitleEditing(false);
        return;
      }
    } else {
      dispatch(clearNoteTitleDraft(note.id));
    }
    el.textContent = t;
    setTitleEditing(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <h2
          key={note.id}
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          role="heading"
          aria-level={2}
          tabIndex={0}
          className="min-w-0 flex-1 truncate rounded-sm px-1 py-0.5 text-[13px] font-semibold leading-tight text-foreground outline-none ring-offset-background hover:bg-muted/40 focus:bg-muted/40 focus:ring-2 focus:ring-ring focus:ring-offset-2"
          onFocus={() => setTitleEditing(true)}
          onInput={() => {
            const el = titleRef.current;
            if (!el) return;
            const raw = el.textContent ?? "";
            const text = raw.replace(/\r\n/g, "\n").replace(/\n/g, " ").replace(/\u00a0/g, " ");
            dispatch(setNoteTitleDraft({ id: note.id, text }));
          }}
          onBlur={() => void commitTitleFromDom()}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            document.execCommand("insertText", false, text);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          title="Copy note id"
          aria-label="Copy note id"
          onClick={copyNoteId}
        >
          <CopyGlyph />
          <span>Copy note id</span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3">
        <div className="flex min-h-0 flex-1 flex-col">{renderNote()}</div>
      </div>
    </div>
  );
};

export default NoteViewer;
