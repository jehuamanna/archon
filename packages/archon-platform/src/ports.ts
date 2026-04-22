import type { SyncDocument, SyncPullResponse, SyncPushResponse } from "./sync-types";

/** HTTP API: auth, sync, and future server-only features. Both web and Electron use this when online. */
export interface RemoteApi {
  /** Base URL with no trailing slash (empty = sync/auth disabled). */
  getBaseUrl(): string;
  setAuthToken(token: string | null): void;
  setRefreshToken(token: string | null): void;
  authRegister(
    email: string,
    password: string,
  ): Promise<{ token: string; refreshToken: string; userId: string }>;
  authLogin(
    email: string,
    password: string,
  ): Promise<{
    token: string;
    refreshToken: string;
    userId: string;
    mustSetPassword?: boolean;
  }>;
  authRefresh(refreshToken: string): Promise<{
    token: string;
    refreshToken: string;
  }>;
  /** Validate stored JWT and read profile. */
  authMe(): Promise<{
    userId: string;
    email: string;
    mustSetPassword?: boolean;
    /** Platform-wide master admin flag. */
    isMasterAdmin?: boolean;
    /** Org the account is locked to (cannot create new orgs). */
    lockedOrgId?: string | null;
  }>;
  /**
   * Authenticated password rotation. Required after admin-issued temporary
   * passwords (mustSetPassword=true on the user doc).
   */
  authChangePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true; mustSetPassword: false }>;
  syncPush(
    collection: string,
    documents: SyncDocument[],
  ): Promise<SyncPushResponse>;
  syncPull(collection: string, since: number): Promise<SyncPullResponse>;
}

export type CreateNoteRelation = "child" | "sibling" | "root";
export type NoteMovePlacement = "before" | "after" | "into";

export interface Note {
  id: string;
  type: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  /**
   * Server-computed effective write permission for the signed-in user.
   * `false` → force preview, hide edit affordances. `undefined` (legacy server
   * or scratch-mode fixture) is treated as writable so older paths keep working.
   */
  canWrite?: boolean;
}

export interface NoteListItem {
  id: string;
  type: string;
  title: string;
  parentId: string | null;
  depth: number;
  metadata?: Record<string, unknown>;
}

export type PasteSubtreePayload = {
  sourceId: string;
  targetId: string;
  mode: "cut" | "copy";
  placement: NoteMovePlacement;
};

/**
 * Durable local notes + pending sync queue (Electron: full offline-first).
 * Web (PWA): thin cache / shim — server remains source of truth (ADR web profile).
 */
export interface LocalStore {
  readonly profile: "web-thin" | "electron-offline-first";
  notes: NotesPersistencePort;
}

/** Subset of `ArchonRendererApi` used by Redux notes thunks — implemented via preload or web shim. */
export interface NotesPersistencePort {
  getNote: (noteId?: string) => Promise<Note | null>;
  getAllNotes: () => Promise<NoteListItem[]>;
  createNote: (payload: {
    anchorId?: string;
    relation: CreateNoteRelation;
    type: string;
    content?: string;
    title?: string;
  }) => Promise<{ id: string }>;
  renameNote: (
    id: string,
    title: string,
    options?: { updateVfsDependentLinks?: boolean },
  ) => Promise<void>;
  moveNote: (
    draggedId: string,
    targetId: string,
    placement: NoteMovePlacement,
  ) => Promise<void>;
  moveNotesBulk: (
    ids: string[],
    targetId: string,
    placement: NoteMovePlacement,
  ) => Promise<void>;
  deleteNotes: (ids: string[]) => Promise<void>;
  pasteSubtree: (payload: PasteSubtreePayload) => Promise<unknown>;
  saveNotePluginUiState: (noteId: string, state: unknown) => Promise<void>;
  saveNoteContent: (noteId: string, content: string) => Promise<void>;
  patchNoteMetadata: (
    noteId: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
}

/** Electron main/preload: menus, sync tick, native dialogs. Web: no-op. */
export interface DesktopHost {
  readonly isElectron: boolean;
  /** Subscribe to periodic sync nudges from main (IPC). Unsubscribe on teardown. */
  onSyncTrigger(callback: () => void): () => void;
}

export type ArchonPlatformProfile = "web" | "electron";

export interface ArchonPlatformDeps {
  profile: ArchonPlatformProfile;
  remoteApi: RemoteApi;
  localStore: LocalStore;
  desktopHost: DesktopHost;
}
