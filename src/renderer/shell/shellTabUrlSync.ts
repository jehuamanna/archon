import type { ShellTabInstance } from "./registries/ShellTabsRegistry";
import {
  isShellNoteEditorTabType,
  SHELL_TAB_WELCOME_TYPE_ID,
} from "./first-party/shellWorkspaceIds";
import {
  DOCUMENTATION_SHELL_TAB_TYPE_ID,
  hashDocumentationPathFromState,
  type DocumentationShellTabState,
} from "./first-party/plugins/documentation/documentationShellHash";
import { markdownVfsNoteHref, parseVfsNoteHashPath } from "../../shared/note-vfs-path";
import { getCachedCanonicalVfsPathForNoteId } from "./noteIdVfsPathCache";
import {
  type ShellWelcomeTabState,
  tryParseWelcomeShellHash,
  type WelcomeShellUrlSegment,
} from "./shellWelcomeUrlRoutes";

export type { ShellWelcomeTabState, WelcomeShellUrlSegment } from "./shellWelcomeUrlRoutes";

/** State stored on shell note tabs (standard note tab and scratch markdown tab). */
export type ShellNoteTabState = {
  noteId: string;
  /**
   * Canonical or same-project-relative VFS string for `#/w/...` hashes (Workspace/Project/Title or ./Title).
   * Populated when opening from the explorer or a path hash so the address bar does not fall back to `#/n/<id>`.
   */
  canonicalVfsPath?: string;
  /** When set, URL hash includes a heading segment and preview scrolls to heading. */
  markdownHeadingSlug?: string;
};

export type ParsedShellHash =
  | { kind: "note"; noteId: string; markdownHeadingSlug?: string }
  | { kind: "vfsNote"; vfsPath: string; markdownHeadingSlug?: string }
  | { kind: "welcome"; segment: "" | WelcomeShellUrlSegment }
  | { kind: "tab"; instanceId: string; documentationSegments: string[] };

function parseNoteHashPath(pathAfterN: string): { noteId: string; markdownHeadingSlug?: string } | null {
  const parts = pathAfterN
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const noteId = parts[0];
  if (!noteId) return null;
  const slug = parts[1];
  if (slug && /^[a-z0-9-]+$/i.test(slug)) {
    return { noteId, markdownHeadingSlug: slug };
  }
  return { noteId };
}

export { parseEphemeralShellTabInstanceId } from "./shellTabInstanceParse";

export function parseShellHash(): ParsedShellHash | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "").trim();
  if (!raw) return null;
  if (raw.startsWith("/w/")) {
    const parsed = parseVfsNoteHashPath(raw.slice("/w/".length));
    if (parsed?.vfsPath) return { kind: "vfsNote", ...parsed };
  }
  if (raw.startsWith("w/")) {
    const parsed = parseVfsNoteHashPath(raw.slice("w/".length));
    if (parsed?.vfsPath) return { kind: "vfsNote", ...parsed };
  }
  if (raw.startsWith("/n/")) {
    const parsed = parseNoteHashPath(raw.slice("/n/".length));
    if (parsed) return { kind: "note", ...parsed };
  }
  if (raw.startsWith("n/")) {
    const parsed = parseNoteHashPath(raw.slice("n/".length));
    if (parsed) return { kind: "note", ...parsed };
  }
  if (raw.startsWith("note/")) {
    const parsed = parseNoteHashPath(raw.slice("note/".length));
    if (parsed) return { kind: "note", ...parsed };
  }
  const welcome = tryParseWelcomeShellHash(raw);
  if (welcome === null) return null;
  if (welcome) return welcome;
  const tabPart = raw.startsWith("/") ? raw.slice(1) : raw;
  if (tabPart.startsWith("t/")) {
    const afterT = tabPart.slice("t/".length);
    const rawSegs = afterT.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
    if (rawSegs.length === 0) return null;
    const segments = rawSegs.map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    const instanceId = segments[0]!;
    return { kind: "tab", instanceId, documentationSegments: segments.slice(1) };
  }
  return null;
}

export function hashForActiveTab(tab: ShellTabInstance | null): string {
  if (!tab) return "";
  const st = tab.state as ShellNoteTabState | undefined;
  if (isShellNoteEditorTabType(tab.tabTypeId) && st?.noteId) {
    const slug = st.markdownHeadingSlug;
    const vfs =
      getCachedCanonicalVfsPathForNoteId(st.noteId) ?? st.canonicalVfsPath;
    if (vfs) {
      return markdownVfsNoteHref(vfs, slug);
    }
    return slug ? `#/n/${st.noteId}/${slug}` : `#/n/${st.noteId}`;
  }
  if (tab.tabTypeId === SHELL_TAB_WELCOME_TYPE_ID) {
    const w = tab.state as ShellWelcomeTabState | undefined;
    const seg = w?.welcomeHashSegment;
    return seg ? `#/welcome/${seg}` : "#/welcome";
  }
  if (tab.tabTypeId === DOCUMENTATION_SHELL_TAB_TYPE_ID) {
    const doc = (tab.state as { documentation?: DocumentationShellTabState } | undefined)?.documentation;
    const tail = hashDocumentationPathFromState(doc ?? null);
    return `#/t/${tab.instanceId}${tail}`;
  }
  return `#/t/${tab.instanceId}`;
}

export function replaceWindowHash(nextHash: string): void {
  if (typeof window === "undefined") return;
  const u = new URL(window.location.href);
  const normalized = nextHash.startsWith("#") ? nextHash : `#${nextHash}`;
  if (u.hash === normalized) return;
  u.hash = normalized;
  window.history.replaceState(null, "", `${u.pathname}${u.search}${normalized}`);
}

/** Fired when a main-area shell note tab is closed (×, command, etc.). Notes explorer listens to cancel debounced single-click opens. */
export const ARCHON_SHELL_NOTE_TAB_CLOSED_EVENT = "archon:shell-note-tab-closed";

export function dispatchShellNoteTabClosed(noteId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(ARCHON_SHELL_NOTE_TAB_CLOSED_EVENT, { detail: { noteId } }),
  );
}
