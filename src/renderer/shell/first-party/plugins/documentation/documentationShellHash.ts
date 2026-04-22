import type { ShellTabInstance, ShellTabsRegistry } from "../../../registries/ShellTabsRegistry";

export const DOCUMENTATION_SHELL_TAB_TYPE_ID = "plugin.documentation.tab";

/** Persisted on the docs shell tab (`state.documentation`) and encoded after `#/t/<instance>/…`. */
export type DocumentationShellTabState = {
  view: "hub" | "command" | "bundled";
  commandId?: string;
  noteId?: string;
  headingSlug?: string;
  /**
   * Logical bundled id before `fetchBundledDocumentationNote` resolves to a concrete `noteId`
   * (legacy notes or `wpn-docs:…`). Omitted once `noteId` is set. Not encoded in the URL hash (ephemeral).
   */
  bundledResolvingLogicalId?: string;
  /** Explorer VFS path `Workspace/Project/Title`; resolved to `noteId` in the Documentation hub. */
  bundledVfsPath?: string;
};

/** Matches heading `id`s from {@link MarkdownRenderer} / `baseSlug` (lowercase). */
const SLUG_RE = /^[a-z0-9-]+$/;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Path after tab instance: `h`, `h/<slug>`, `c/<commandId>`, `c/<commandId>/<slug>`,
 * `n/<noteId>`, `n/<noteId>/<slug>` (note id segment is URI-encoded),
 * `p/<vfsSegment>/…` optional trailing heading slug.
 */
export function documentationStateFromPathSegments(segments: string[]): DocumentationShellTabState | null {
  if (segments.length === 0) return null;
  const [a, b, c] = segments;
  if (a === "h") {
    if (!b || !SLUG_RE.test(b)) return null;
    return { view: "hub", headingSlug: b };
  }
  if (a === "c" && b) {
    const commandId = safeDecode(b);
    if (!commandId) return null;
    if (c) {
      if (!SLUG_RE.test(c)) return null;
      return { view: "command", commandId, headingSlug: c };
    }
    return { view: "command", commandId };
  }
  if (a === "n" && b) {
    const noteId = safeDecode(b);
    if (!noteId) return null;
    if (c) {
      if (!SLUG_RE.test(c)) return null;
      return { view: "bundled", noteId, headingSlug: c };
    }
    return { view: "bundled", noteId };
  }
  if (a === "p" && segments.length >= 2) {
    const decoded = segments.slice(1).map(safeDecode);
    const last = decoded[decoded.length - 1]!;
    if (decoded.length >= 2 && SLUG_RE.test(last)) {
      return {
        view: "bundled",
        bundledVfsPath: decoded.slice(0, -1).join("/"),
        headingSlug: last,
      };
    }
    return { view: "bundled", bundledVfsPath: decoded.join("/") };
  }
  return null;
}

export function hashDocumentationPathFromState(doc: DocumentationShellTabState | null | undefined): string {
  if (!doc) return "";
  if (doc.view === "hub") {
    if (doc.headingSlug && SLUG_RE.test(doc.headingSlug)) return `/h/${doc.headingSlug}`;
    return "";
  }
  if (doc.view === "command" && doc.commandId) {
    const enc = encodeURIComponent(doc.commandId);
    if (doc.headingSlug && SLUG_RE.test(doc.headingSlug)) return `/c/${enc}/${doc.headingSlug}`;
    return `/c/${enc}`;
  }
  if (doc.view === "bundled") {
    if (doc.noteId) {
      const enc = encodeURIComponent(doc.noteId);
      if (doc.headingSlug && SLUG_RE.test(doc.headingSlug)) return `/n/${enc}/${doc.headingSlug}`;
      return `/n/${enc}`;
    }
    if (doc.bundledVfsPath) {
      const enc = doc.bundledVfsPath
        .split("/")
        .filter((p) => p.length > 0)
        .map((p) => encodeURIComponent(p))
        .join("/");
      if (doc.headingSlug && SLUG_RE.test(doc.headingSlug)) return `/p/${enc}/${doc.headingSlug}`;
      return `/p/${enc}`;
    }
    return "";
  }
  return "";
}

export function readDocumentationStateFromTab(tab: ShellTabInstance | null): DocumentationShellTabState | null {
  if (!tab || tab.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return null;
  const raw = (tab.state as { documentation?: unknown } | undefined)?.documentation;
  if (raw == null) return null;
  if (typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const view = d.view;
  const headingSlug =
    typeof d.headingSlug === "string" && d.headingSlug.length > 0 ? d.headingSlug : undefined;
  if (view === "command") {
    const commandId = typeof d.commandId === "string" ? d.commandId : "";
    if (!commandId) return null;
    return headingSlug ? { view: "command", commandId, headingSlug } : { view: "command", commandId };
  }
  if (view === "bundled") {
    const noteId = typeof d.noteId === "string" ? d.noteId : "";
    const bundledResolvingLogicalId =
      typeof d.bundledResolvingLogicalId === "string" ? d.bundledResolvingLogicalId.trim() : "";
    const bundledVfsPath =
      typeof d.bundledVfsPath === "string" ? d.bundledVfsPath.trim() : "";
    if (!noteId && !bundledResolvingLogicalId && !bundledVfsPath) return null;
    const base: DocumentationShellTabState = { view: "bundled" };
    if (noteId) base.noteId = noteId;
    if (bundledResolvingLogicalId) base.bundledResolvingLogicalId = bundledResolvingLogicalId;
    if (bundledVfsPath) base.bundledVfsPath = bundledVfsPath;
    if (headingSlug) base.headingSlug = headingSlug;
    return base;
  }
  if (view === "hub") {
    if (!headingSlug) return null;
    return { view: "hub", headingSlug };
  }
  return null;
}

function docStateEqual(a: DocumentationShellTabState | null, b: DocumentationShellTabState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const slug = (s: string | undefined | null) => (s == null || s === "" ? undefined : s);
  return (
    a.view === b.view &&
    a.commandId === b.commandId &&
    a.noteId === b.noteId &&
    a.bundledResolvingLogicalId === b.bundledResolvingLogicalId &&
    a.bundledVfsPath === b.bundledVfsPath &&
    slug(a.headingSlug) === slug(b.headingSlug)
  );
}

/** `null` = default hub overview with no URL suffix (omit `state.documentation`). */
export function buildDocumentationStateFromUi(
  commandId: string | null,
  bundledNoteId: string | null,
  headingSlug?: string | null,
): DocumentationShellTabState | null {
  if (commandId) {
    return { view: "command", commandId, headingSlug: headingSlug ?? undefined };
  }
  if (bundledNoteId) {
    return { view: "bundled", noteId: bundledNoteId, headingSlug: headingSlug ?? undefined };
  }
  if (headingSlug) {
    return { view: "hub", headingSlug };
  }
  return null;
}

/**
 * Merge or clear `state.documentation` on the docs tab. Empty `pathSegments` removes documentation from state.
 */
export function applyDocumentationDeepLinkToTab(
  tabs: ShellTabsRegistry,
  instanceId: string,
  pathSegments: string[],
): void {
  const inst = tabs.listOpenTabs().find((t) => t.instanceId === instanceId);
  if (!inst || inst.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
  const prev = { ...((inst.state ?? {}) as Record<string, unknown>) };
  if (pathSegments.length === 0) {
    delete prev.documentation;
  } else if (pathSegments.length === 1 && pathSegments[0] === "h") {
    delete prev.documentation;
  } else {
    const doc = documentationStateFromPathSegments(pathSegments);
    if (!doc) return;
    prev.documentation = doc;
  }
  tabs.updateTabPresentation(instanceId, { state: prev });
}

export function mergeDocumentationIntoTabState(
  tabs: ShellTabsRegistry,
  instanceId: string,
  next: DocumentationShellTabState | null,
): void {
  const inst = tabs.listOpenTabs().find((t) => t.instanceId === instanceId);
  if (!inst || inst.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return;
  const prev = (inst.state ?? {}) as Record<string, unknown>;
  const cur = readDocumentationStateFromTab(inst);
  if (docStateEqual(cur, next)) return;
  const merged = { ...prev };
  if (next) merged.documentation = next;
  else delete merged.documentation;
  tabs.updateTabPresentation(instanceId, { state: merged });
}

/** Applies documentation navigation to the active tab when it is the Documentation shell tab. */
export function mergeDocumentationIntoActiveDocsTab(
  tabs: ShellTabsRegistry,
  next: DocumentationShellTabState | null,
): boolean {
  const t = tabs.getActiveTab();
  if (!t || t.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return false;
  mergeDocumentationIntoTabState(tabs, t.instanceId, next);
  return true;
}

/** Next persisted docs state for the same page with an updated heading (hub overview when `cur` is null). */
export function documentationStateWithHeading(
  cur: DocumentationShellTabState | null,
  slug: string,
): DocumentationShellTabState {
  if (cur?.view === "command" && cur.commandId) {
    return { view: "command", commandId: cur.commandId, headingSlug: slug };
  }
  if (cur?.view === "bundled" && cur.noteId) {
    return { view: "bundled", noteId: cur.noteId, headingSlug: slug };
  }
  if (cur?.view === "bundled" && cur.bundledResolvingLogicalId) {
    return { view: "bundled", bundledResolvingLogicalId: cur.bundledResolvingLogicalId, headingSlug: slug };
  }
  if (cur?.view === "bundled" && cur.bundledVfsPath && !cur.noteId) {
    return { view: "bundled", bundledVfsPath: cur.bundledVfsPath, headingSlug: slug };
  }
  return { view: "hub", headingSlug: slug };
}

/**
 * Updates the active documentation tab’s heading slug for in-page navigation.
 * @returns whether the slug was already active (no tab state write beyond deduping).
 */
export function mergeDocumentationHeadingSlug(
  tabs: ShellTabsRegistry,
  instanceId: string,
  slug: string,
): { unchanged: boolean } {
  const inst = tabs.listOpenTabs().find((t) => t.instanceId === instanceId);
  if (!inst || inst.tabTypeId !== DOCUMENTATION_SHELL_TAB_TYPE_ID) return { unchanged: false };
  const cur = readDocumentationStateFromTab(inst);
  const unchanged = cur?.headingSlug === slug;
  const next = documentationStateWithHeading(cur, slug);
  mergeDocumentationIntoTabState(tabs, instanceId, next);
  return { unchanged };
}

/**
 * Hash-only fragment for sharing Documentation routes. Uses bare `plugin.documentation.tab` so links work
 * across sessions (`applyShellTabFromUrlHash` accepts the tab type id without an instance suffix).
 */
export function documentationShareHashFragment(doc: DocumentationShellTabState | null): string {
  const tail = hashDocumentationPathFromState(doc);
  return `#/t/${DOCUMENTATION_SHELL_TAB_TYPE_ID}${tail}`;
}

/** Full URL (origin + path + query + documentation hash) for clipboard / external sharing. */
export function documentationShareAbsoluteUrl(doc: DocumentationShellTabState | null): string {
  if (typeof window === "undefined") {
    return documentationShareHashFragment(doc);
  }
  return `${window.location.origin}${window.location.pathname}${window.location.search}${documentationShareHashFragment(doc)}`;
}
