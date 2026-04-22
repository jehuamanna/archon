/**
 * Type-only surface that mirrors `preload.ts` exports, without pulling in Electron.
 * UI code (Next.js or legacy) imports these instead of `preload` so the same sources compile in the browser.
 */
export type {
  CreateNoteRelation,
  MainDebugLogEntry,
  MarketplaceListResponse,
  MarketplacePluginRow,
  Note,
  NoteListItem,
  NoteMovePlacement,
  OpenPluginWorkspaceArgs,
  PasteSubtreePayload,
  PluginInventoryItem,
  PluginProgressPayload,
} from "./archon-renderer-api";
