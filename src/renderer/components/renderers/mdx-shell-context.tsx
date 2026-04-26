import React, { createContext, useContext } from "react";
import type { Note } from "@archon/ui-types";
import type { InternalMarkdownNoteLink } from "../../utils/markdown-internal-note-href";
import type { MarkdownUiLinkCallbacks } from "./useArchonMarkdownUiComponents";

/**
 * Resolves a `(projectId, noteId)` reference (typically from a WPN-explorer
 * drag payload) into a markdown-link `{ label, href }`. Hosts that have the
 * wiki-rows index (e.g. `MdxNoteEditor`) inject this into the shell context
 * so SDK components can decode WPN drops without re-implementing the
 * lookup. Returns `null` when the note isn't in the index.
 */
export type WpnNoteLinkResolver = (input: {
  projectId: string;
  noteId: string;
}) => { label: string; href: string } | null;

/**
 * Opens the host's note-link picker modal and routes the picked note back
 * to the SDK component as a resolved `{ label, href }` pair. Lets components
 * like `<Slideshow>` offer a click-driven "Link to note" button without
 * pulling WPN-specific UI or types into the SDK surface.
 */
export type WpnNoteLinkPickerOpener = (
  onPick: (link: { label: string; href: string }) => void,
  options?: { excludeNoteId?: string },
) => void;

export type MdxShellContextValue = MarkdownUiLinkCallbacks & {
  nestingDepth: number;
  /** The note currently being rendered — available to bundled-tier MDX via `useMdxShell()`. */
  note: Note | null;
  /** Optional WPN drop-payload resolver — see `WpnNoteLinkResolver`. */
  resolveWpnNoteLink?: WpnNoteLinkResolver;
  /** Optional click-driven note-link picker — see `WpnNoteLinkPickerOpener`. */
  openWpnNoteLinkPicker?: WpnNoteLinkPickerOpener;
  /**
   * Open an internal note link in a NEW Archon shell tab (not a new
   * browser tab). Lets SDK components like `<Slideshow>` route clicks
   * through the workbench instead of relying on `target="_blank"` —
   * which would either lose context (Electron → system browser) or
   * spawn a fresh hash route (web). Hosts that don't have a workbench
   * (e.g. read-only previews) can leave this undefined.
   */
  openInternalNoteLinkInNewTab?: (link: InternalMarkdownNoteLink) => void;
};

const MdxShellContext = createContext<MdxShellContextValue | null>(null);

export function MdxShellProvider({
  value,
  children,
}: {
  value: MdxShellContextValue;
  children: React.ReactNode;
}): React.ReactElement {
  return <MdxShellContext.Provider value={value}>{children}</MdxShellContext.Provider>;
}

export function useMdxShell(): MdxShellContextValue {
  const v = useContext(MdxShellContext);
  if (!v) {
    return {
      nestingDepth: 0,
      note: null,
    };
  }
  return v;
}
