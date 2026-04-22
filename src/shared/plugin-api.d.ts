/**
 * Legacy plugin runtime (iframe) globals. New note UI uses NoteTypeReactRenderer (no iframe).
 * Epic 1.3 — use host React via bridge globals (not a separate React copy).
 */
export {};

declare global {
  interface Window {
    /** Injected project root for `archon-asset:` URLs in sandboxed plugins. */
    __ARCHON_ASSET_PROJECT_ROOT__?: string;
    __ARCHON_NOTE__?: {
      id?: string;
      type?: string;
      title?: string;
      content: string;
      metadata?: Record<string, unknown>;
    };

    Archon: {
      React: typeof import("react");
      ReactDOM: typeof import("react-dom") & {
        createRoot?: (container: Element | DocumentFragment) => {
          render: (node: import("react").ReactNode) => void;
        };
      };
      postMessage: (data: unknown) => void;
      /** Persist JSON-serializable UI state (debounced on host). */
      postPluginUiState?: (state: unknown) => void;
      notifyDisplayReady?: () => void;
      /** Persist note body for the current note (debounced on host). */
      saveNoteContent?: (content: string) => void;
      /** Build `archon-asset:` URL for a path under `assets/` (injected in sandbox). */
      assetUrl?: (relativePath: string, projectRoot?: string) => string;
      listAssetsByCategory?: (
        category: string,
      ) => Promise<
        | { ok: true; files: { relativePath: string; name: string }[] }
        | { ok: false; error: string }
      >;
      pickImportMediaFile?: (
        category: string,
      ) => Promise<
        { ok: true; assetRel: string } | { ok: false; error: string }
      >;
      /** Load per-PDF saved places from host storage (same file across notes in this workspace). */
      getPdfBookmarks?: (
        assetRel: string,
      ) => Promise<
        { id: string; page: number; label: string; createdAt: number }[]
      >;
      /** Replace saved places for this PDF in host storage. */
      savePdfBookmarks?: (
        assetRel: string,
        bookmarks: { id: string; page: number; label: string; createdAt: number }[],
      ) => Promise<void>;
      onMessage: ((message: unknown) => void) | null;
    };
  }
}
