export type {
  CreateNoteRelation,
  DesktopHost,
  LocalStore,
  ArchonPlatformDeps,
  ArchonPlatformProfile,
  Note,
  NoteListItem,
  NoteMovePlacement,
  NotesPersistencePort,
  PasteSubtreePayload,
  RemoteApi,
} from "./ports";
export type { SyncDocument, SyncPullResponse, SyncPushResponse } from "./sync-types";
export type { CreateArchonPlatformDepsOptions } from "./implementations";
export {
  createElectronDesktopHost,
  createElectronOfflineFirstLocalStore,
  createNoopDesktopHost,
  createArchonPlatformDeps,
  createStubRemoteApi,
  createWebThinLocalStore,
} from "./implementations";
export {
  createFetchRemoteApi,
  type CreateFetchRemoteApiOptions,
} from "./remote-fetch";
export {
  createSyncBaseUrlResolver,
  normalizeSyncApiBaseUrl,
} from "./resolve-sync-base";
export { withSyncRetry } from "./sync-retry";
export {
  ARCHON_POST_AUTH_REDIRECT_KEY,
  ARCHON_SYNC_ACCESS_TOKEN_KEY,
  ARCHON_SYNC_REFRESH_TOKEN_KEY,
} from "./sync-auth-storage-keys";
export {
  RetriableAfterLoginError,
  SessionExpiredError,
  type SessionExpiredReason,
} from "./errors";
export {
  withAuthRetry,
  type AuthRequestDescriptor,
  type RefreshOnceFn,
  type WithAuthRetryDeps,
  type WithAuthRetryOptions,
} from "./with-auth-retry";
