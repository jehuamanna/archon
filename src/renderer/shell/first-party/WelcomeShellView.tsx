import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import type { Note } from "@archon/ui-types";
import type { RootState } from "../../store";
import { useAuth } from "../../auth/AuthContext";
import { isWebScratchSession } from "../../auth/web-scratch";
import { MdxRenderer } from "../../components/renderers/MdxRenderer";
import { isElectronUserAgent } from "../../archon-web-shim";
import { useToast } from "../../toast/ToastContext";
import { applyShellWelcomeHash } from "../shellRailNavigation";
import { replaceWindowHash } from "../shellTabUrlSync";
import { useShellNavigation } from "../useShellNavigation";
import type { ShellViewComponentProps } from "../views/ShellViewRegistry";
import type { WelcomeShellUrlSegment } from "../shellWelcomeUrlRoutes";
import {
  findWelcomeNoteForActiveOrg,
  invalidateWelcomeCache,
  saveWelcomeNote,
  subscribeWelcomeSystemNoteChanged,
  type WelcomeNoteRow,
} from "./welcomeSystemNote";
import { MdxNoteEditor } from "./plugins/markdown/MdxNoteEditor";

function scratchPersistenceParagraph(
  electron: boolean,
  webAuthed: boolean,
  webScratchTryout: boolean,
  authLoading: boolean,
): string {
  if (authLoading) {
    return "> **Persistence:** Matches your notes backend once the session has finished loading.";
  }
  if (electron) {
    return "> **Persistence:** In the desktop app, Scratch notes are saved like your other project notes—your open notes folder or your signed-in cloud workspace, depending on how you use Archon.";
  }
  if (webAuthed) {
    return "> **Persistence:** While signed in on the web, Scratch notes are stored with your account—the same as the rest of your workspace tree.";
  }
  if (webScratchTryout) {
    return "> **Persistence:** In browser try-out mode, Scratch notes stay in this browser (local storage). Signing in or clearing site data may affect them—copy or recreate anything you need to keep elsewhere.";
  }
  return "> **Persistence:** Sign in to keep notes on your account. For a quick local try-out, use a scratch session—notes then stay in this browser until you change that.";
}

function buildWelcomeMarkdown(
  electron: boolean,
  webAuthed: boolean,
  webScratchTryout: boolean,
  authLoading: boolean,
): string {
  const persistence = scratchPersistenceParagraph(
    electron,
    webAuthed,
    webScratchTryout,
    authLoading,
  );

  return `# Welcome to Archon

Your home tab in the shell: jump to scratch notes, the notes tree, or documentation—without digging through menus.

---

## Quick picks

| Where | What you get |
| :---- | :------------- |
| [Scratch markdown](#/welcome/scratch-markdown) | The **scratch** tab—a reusable markdown draft (also from the tab strip or activity bar) |
| [Scratch JS notebook](#/welcome/js-notebook) | An interactive notebook in the main area (not stored as a project note) |
| [Notes explorer](#/welcome/notes-explorer) | Sidebar tree; open a note to edit in the main column |
| [Documentation](#/welcome/documentation) | Command search, keyboard reference, API shape, plugin authoring |

---

## Scratch notes and the explorer

The **scratch** tab is one reusable markdown note. From the command palette, **New scratch markdown** adds more root notes named **scratch**, or **scratch-…-…** (two random nature words) when a same-type sibling already uses **scratch** (case-insensitive).

They show up in the [Notes explorer](#/welcome/notes-explorer) under **Scratch** → **Scratch**—a **draft bucket** in the same tree as your other notes, not a hidden buffer.

${persistence}

> **Workflow:** Capture in scratch; when something is no longer a draft, move or duplicate it into another project in the explorer.

---

## For plugin authors

Shell views are React components. In DevTools, try \`window.archon.shell\`. Register menu items and tabs from the command registry or DevTools.

---

> **URLs:** After your tree has loaded, the address bar prefers \`#/w/Workspace/Project/Title\`. Welcome shortcuts use \`#/welcome/…\`—shareable, and they run the same actions as the links above.
`;
}

export function WelcomeShellView(_props: ShellViewComponentProps): React.ReactElement {
  const { invokeCommand, deps: shellNavDeps } = useShellNavigation();
  const { state: authState } = useAuth();
  const { showToast } = useToast();

  // Org-admin role check — same pattern as PeoplePanel.tsx and AdminMainView.tsx.
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const activeOrgId = orgState.activeOrgId;
  const isOrgAdmin = useMemo(() => {
    const active = orgState.orgs.find((o) => o.orgId === activeOrgId);
    return active?.role === "admin";
  }, [activeOrgId, orgState.orgs]);

  const onWelcomeShellSegmentClick = useCallback(
    (segment: "" | WelcomeShellUrlSegment) => {
      replaceWindowHash(segment ? `#/welcome/${segment}` : "#/welcome");
      applyShellWelcomeHash(segment, shellNavDeps, invokeCommand);
    },
    [invokeCommand, shellNavDeps],
  );

  // Bundled fallback — used when no org override exists yet.
  const fallbackContent = useMemo<string>(() => {
    const electron = isElectronUserAgent();
    const webAuthed = authState.status === "authed";
    const authLoading = authState.status === "loading";
    const webScratchTryout =
      !electron && isWebScratchSession() && authState.status === "anon";
    return buildWelcomeMarkdown(electron, webAuthed, webScratchTryout, authLoading);
  }, [authState.status]);

  // Per-org override fetched lazily; null = "no override, use bundled."
  const [welcomeRow, setWelcomeRow] = useState<WelcomeNoteRow | null>(null);
  const [loaded, setLoaded] = useState<boolean>(false);
  // Reload when active org changes or when the helper signals a change.
  const refreshFromServer = useCallback(async (): Promise<void> => {
    if (authState.status !== "authed") {
      setWelcomeRow(null);
      setLoaded(true);
      return;
    }
    try {
      const row = await findWelcomeNoteForActiveOrg(activeOrgId);
      setWelcomeRow(row);
    } finally {
      setLoaded(true);
    }
  }, [activeOrgId, authState.status]);

  useEffect(() => {
    setLoaded(false);
    void refreshFromServer();
  }, [refreshFromServer]);
  useEffect(() => {
    return subscribeWelcomeSystemNoteChanged(() => {
      void refreshFromServer();
    });
  }, [refreshFromServer]);

  // Edit-mode state. Autosave is owned by `MdxNoteEditor` (debounced HTTP
  // saves + Yjs collab when the WS is up), so we no longer track a draft
  // or a dirty flag locally. `openingEdit` covers the brief async refresh
  // that happens between clicking Edit Welcome and the editor mounting.
  const [editing, setEditing] = useState<boolean>(false);
  const [openingEdit, setOpeningEdit] = useState<boolean>(false);

  const renderedContent = welcomeRow?.content ?? fallbackContent;

  const welcomeNote = useMemo<Note>(
    () => ({
      // Type `mdx` so MdxRenderer applies the mini-app trust tier and
      // routes imports through the SDK facade. Plain markdown inside MDX
      // is a superset, so the bundled content renders unchanged.
      id: welcomeRow?.noteId ?? "shell.welcome",
      type: "mdx",
      title: "Welcome",
      content: renderedContent,
    }),
    [welcomeRow?.noteId, renderedContent],
  );

  // Always re-fetch from server before the editor opens. Without this, a
  // stale local cache (e.g. content was rewritten via MCP since the page
  // loaded) becomes the editor's starting state. Bootstraps the welcome
  // note (creates `__system / Welcome / Welcome`) on first edit if it
  // doesn't exist yet, seeded with the bundled fallback so the admin has
  // something to start from instead of a blank page.
  const beginEdit = async (): Promise<void> => {
    if (openingEdit || editing) return;
    if (authState.status !== "authed") return;
    setOpeningEdit(true);
    try {
      invalidateWelcomeCache(activeOrgId);
      let fresh = await findWelcomeNoteForActiveOrg(activeOrgId);
      if (!fresh) {
        fresh = await saveWelcomeNote(activeOrgId, fallbackContent);
      }
      setWelcomeRow(fresh);
      setEditing(true);
    } catch (e) {
      showToast({
        severity: "error",
        message: `Could not open Welcome editor: ${(e as Error).message ?? "unknown error"}`,
        mergeKey: "welcome-open-err",
      });
    } finally {
      setOpeningEdit(false);
    }
  };

  // Exit edit mode and refetch so the read-only view reflects the latest
  // autosaved content. The 600ms delay gives `MdxNoteEditor`'s debounced
  // unmount-flush time to land before we pull from the server.
  const exitEdit = (): void => {
    setEditing(false);
    window.setTimeout(() => {
      invalidateWelcomeCache(activeOrgId);
      void refreshFromServer();
    }, 600);
  };

  // Note shape passed to MdxNoteEditor when editing. Only constructed when
  // `welcomeRow` is non-null (bootstrap guarantees this in `beginEdit`).
  const editorNote = useMemo<Note | null>(() => {
    if (!welcomeRow) return null;
    return {
      id: welcomeRow.noteId,
      type: "mdx",
      title: "Welcome",
      content: welcomeRow.content,
    };
  }, [welcomeRow]);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {isOrgAdmin && !editing ? (
        <button
          type="button"
          className="absolute right-3 top-3 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void beginEdit()}
          disabled={openingEdit}
          aria-label="Edit Welcome"
          title="Edit Welcome (org admin only)"
        >
          {openingEdit ? "Loading…" : "Edit Welcome"}
        </button>
      ) : null}
      {editing && editorNote ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/15 px-3 py-2">
            <div className="text-[12px] font-medium text-foreground">
              Editing Welcome (org admin)
              <span className="ml-2 text-[11px] text-muted-foreground">
                autosaving · syncs across tabs
              </span>
            </div>
            <button
              type="button"
              className="rounded-md border border-border/60 bg-background px-3 py-1 text-[11px] font-semibold text-foreground hover:bg-muted/30"
              onClick={exitEdit}
              data-testid="welcome-done"
            >
              Done
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <MdxNoteEditor note={editorNote} persist={true} />
          </div>
        </div>
      ) : (
        <MdxRenderer
          note={welcomeNote}
          onWelcomeShellSegmentClick={onWelcomeShellSegmentClick}
        />
      )}
    </div>
  );
}
