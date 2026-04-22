import { getArchon } from "../../shared/archon-host-access";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const hasPlugin = pluginState === "ok";
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

  const copyNoteTitle = () => {
    void navigator.clipboard.writeText(note.title).then(
      () => {
        showToast({
          severity: "info",
          message: "Note name copied",
          mergeKey: "note-viewer-copy-title",
        });
      },
      () => {
        showToast({
          severity: "error",
          message: "Could not copy name (clipboard permission).",
          mergeKey: "note-viewer-copy-title-err",
        });
      },
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
      <header className="shrink-0 border-b border-border px-4 py-3">
        <h2
          key={note.id}
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          role="heading"
          aria-level={2}
          tabIndex={0}
          className="min-h-[1.25rem] max-w-full rounded-sm px-1 py-0.5 text-[13px] font-semibold leading-tight text-foreground outline-none ring-offset-background hover:bg-muted/40 focus:bg-muted/40 focus:ring-2 focus:ring-ring focus:ring-offset-2"
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
        <div className="mt-3 flex w-full min-w-0 flex-nowrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-muted-foreground">Type</span>
              <span className="font-mono text-foreground">{note.type}</span>
            </div>
            {hasPlugin ? (
              <span className="rounded-sm bg-badge-text-bg px-2 py-0.5 font-medium text-[11px] text-badge-text-fg">
                Plugin active
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              title="Copy note name"
              aria-label="Copy note name"
              onClick={copyNoteTitle}
            >
              <CopyGlyph />
              <span>Copy note name</span>
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              title="Copy note id"
              aria-label="Copy note id"
              onClick={copyNoteId}
            >
              <CopyGlyph />
              <span>Copy note id</span>
            </button>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3">
        <div className="flex min-h-0 flex-1 flex-col">{renderNote()}</div>
      </div>
    </div>
  );
};

export default NoteViewer;
