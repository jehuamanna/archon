import {
  createSlice,
  createAsyncThunk,
  type PayloadAction,
} from "@reduxjs/toolkit";
import type { ArchonPlatformDeps, SyncDocument } from "@archon/platform";
import {
  cloudNoteDocFromRow,
  openCloudNotesDbForUser,
  rxdbFindAllCloudNotes,
  rxdbFindDirtyCloudNotes,
  rxdbMarkCloudNotesClean,
  rxdbUpsertCloudNoteRow,
  type CloudNoteRow,
} from "../cloud-sync/cloud-notes-rxdb";
import {
  readCloudSyncSince,
  writeCloudSyncSince,
} from "../cloud-sync/cloud-sync-storage";
import {
  readNotificationsCursor,
  writeNotificationsCursor,
} from "../cloud-sync/notifications-cursor";
import { fetchNotificationsThunk } from "./notificationsSlice";
import type { CloudNoteDoc } from "./cloudNotesTypes";
import { isCloudNoteDoc } from "./cloudNotesTypes";
import {
  ELECTRON_SCRATCH_CLOUD_USER_ID,
  isElectronScratchSession,
} from "../auth/electron-scratch";
import {
  WEB_SCRATCH_CLOUD_USER_ID,
  isWebScratchSession,
} from "../auth/web-scratch-session";

function scratchCloudStorageUserId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (isWebScratchSession()) {
    return WEB_SCRATCH_CLOUD_USER_ID;
  }
  if (isElectronScratchSession()) {
    return ELECTRON_SCRATCH_CLOUD_USER_ID;
  }
  return null;
}

type CloudSyncAuthSlice = {
  cloudAuth: { status: string; userId: string | null };
};

type CloudThunkExtra = { extra: ArchonPlatformDeps };

export type CloudNotesState = {
  byId: Record<string, CloudNoteDoc>;
  selectedId: string | null;
  dirtyIds: Record<string, boolean>;
  syncStatus: "idle" | "syncing" | "error";
  syncError: string | null;
};

const initialState: CloudNotesState = {
  byId: {},
  selectedId: null,
  dirtyIds: {},
  syncStatus: "idle",
  syncError: null,
};

function randomUuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function newCloudNote(): CloudNoteDoc {
  const id = randomUuidV4();
  return {
    id,
    updatedAt: Date.now(),
    deleted: false,
    version: 1,
    title: "Untitled",
    content: "",
    type: "markdown",
  };
}

export const cloudNotesSlice = createSlice({
  name: "cloudNotes",
  initialState,
  reducers: {
    selectCloudNote: (state, action: PayloadAction<string | null>) => {
      state.selectedId = action.payload;
    },
    resetCloudNotes: () => initialState,
    upsertFromPull: (state, action: PayloadAction<CloudNoteDoc>) => {
      state.byId[action.payload.id] = action.payload;
    },
    applyPushConflicts: (state, action: PayloadAction<CloudNoteDoc[]>) => {
      for (const doc of action.payload) {
        state.byId[doc.id] = doc;
        delete state.dirtyIds[doc.id];
      }
    },
    clearDirty: (state, action: PayloadAction<string[]>) => {
      for (const id of action.payload) {
        delete state.dirtyIds[id];
      }
    },
    createCloudNoteLocal: (state) => {
      const doc = newCloudNote();
      state.byId[doc.id] = doc;
      state.dirtyIds[doc.id] = true;
      state.selectedId = doc.id;
    },
    patchCloudNoteLocal: (
      state,
      action: PayloadAction<{
        id: string;
        title?: string;
        content?: string;
        type?: CloudNoteDoc["type"];
      }>,
    ) => {
      const n = state.byId[action.payload.id];
      if (!n || n.deleted) {
        return;
      }
      state.byId[action.payload.id] = {
        ...n,
        ...(action.payload.title !== undefined
          ? { title: action.payload.title }
          : {}),
        ...(action.payload.content !== undefined
          ? { content: action.payload.content }
          : {}),
        ...(action.payload.type !== undefined
          ? { type: action.payload.type }
          : {}),
        updatedAt: Date.now(),
        version: n.version + 1,
      };
      state.dirtyIds[action.payload.id] = true;
    },
    softDeleteCloudNoteLocal: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      const n = state.byId[id];
      if (!n) {
        return;
      }
      state.byId[id] = {
        ...n,
        deleted: true,
        updatedAt: Date.now(),
        version: n.version + 1,
      };
      state.dirtyIds[id] = true;
      if (state.selectedId === id) {
        state.selectedId = null;
      }
    },
    syncMeta: (
      state,
      action: PayloadAction<{
        status: CloudNotesState["syncStatus"];
        error: string | null;
      }>,
    ) => {
      state.syncStatus = action.payload.status;
      state.syncError = action.payload.error;
    },
    hydrateFromRxDb: (
      state,
      action: PayloadAction<{ rows: CloudNoteRow[] }>,
    ) => {
      const byId: Record<string, CloudNoteDoc> = {};
      const dirtyIds: Record<string, boolean> = {};
      for (const row of action.payload.rows) {
        const doc = cloudNoteDocFromRow(row);
        byId[doc.id] = doc;
        if (row.dirty) {
          dirtyIds[doc.id] = true;
        }
      }
      state.byId = byId;
      state.dirtyIds = dirtyIds;
      if (state.selectedId && !byId[state.selectedId]) {
        state.selectedId = null;
      }
    },
  },
});

/** Use `overrideStorageUserId` when hydrating before `cloudAuth` is updated (e.g. inside login/restore thunks). */
export type HydrateCloudNotesFromRxDbArg = {
  overrideStorageUserId?: string;
};

export const hydrateCloudNotesFromRxDbThunk = createAsyncThunk<
  void,
  HydrateCloudNotesFromRxDbArg | undefined,
  CloudThunkExtra
>("cloudNotes/hydrateRxDb", async (arg, { dispatch, getState }) => {
  let storageUserId: string | null = null;
  const override = arg?.overrideStorageUserId?.trim();
  if (override) {
    storageUserId = override;
  } else {
    const root = getState() as CloudSyncAuthSlice;
    storageUserId =
      root.cloudAuth.status === "signedIn" && root.cloudAuth.userId
        ? root.cloudAuth.userId
        : null;
    if (!storageUserId && typeof window !== "undefined") {
      storageUserId = scratchCloudStorageUserId();
    }
  }
  if (!storageUserId) {
    return;
  }
  const opened = await openCloudNotesDbForUser(storageUserId);
  if (!opened) {
    return;
  }
  const rows = await rxdbFindAllCloudNotes();
  dispatch(cloudNotesSlice.actions.hydrateFromRxDb({ rows }));
});

export type RunCloudSyncArg = {
  overrideStorageUserId?: string;
};

export const runCloudSyncThunk = createAsyncThunk<
  void,
  RunCloudSyncArg | undefined,
  CloudThunkExtra
>("cloudNotes/runSync", async (arg, { dispatch, getState, extra }) => {
  const { remoteApi } = extra;
  if (!remoteApi.getBaseUrl()) {
    return;
  }

  let storageUserId: string | null = null;
  const override = arg?.overrideStorageUserId?.trim();
  if (override) {
    storageUserId = override;
  } else {
    const root = getState() as CloudSyncAuthSlice & { cloudNotes: CloudNotesState };
    storageUserId =
      root.cloudAuth.status === "signedIn" && root.cloudAuth.userId
        ? root.cloudAuth.userId
        : null;
    if (!storageUserId && typeof window !== "undefined") {
      storageUserId = scratchCloudStorageUserId();
    }
  }
  if (!storageUserId) {
    return;
  }
  const opened = await openCloudNotesDbForUser(storageUserId);
  if (!opened) {
    return;
  }

  const dirtyRows = await rxdbFindDirtyCloudNotes();
  const docsToPush = dirtyRows.map(cloudNoteDocFromRow);

  dispatch(
    cloudNotesSlice.actions.syncMeta({ status: "syncing", error: null }),
  );

  try {
    if (docsToPush.length > 0) {
      const push = await remoteApi.syncPush(
        "notes",
        docsToPush as unknown as SyncDocument[],
      );
      await rxdbMarkCloudNotesClean(push.accepted);
      for (const c of push.conflicts) {
        if (isCloudNoteDoc(c)) {
          await rxdbUpsertCloudNoteRow({ ...c, dirty: false });
        }
      }
    }

    const since = readCloudSyncSince();
    const pull = await remoteApi.syncPull("notes", since);
    writeCloudSyncSince(pull.lastSync);

    for (const raw of pull.documents) {
      if (isCloudNoteDoc(raw)) {
        await rxdbUpsertCloudNoteRow({ ...raw, dirty: false });
      }
    }

    const rows = await rxdbFindAllCloudNotes();
    dispatch(cloudNotesSlice.actions.hydrateFromRxDb({ rows }));
    dispatch(cloudNotesSlice.actions.syncMeta({ status: "idle", error: null }));

    // Phase 8: piggyback notifications fetch on each sync tick. Failure here
    // doesn't affect notes sync status.
    try {
      const since = readNotificationsCursor() ?? undefined;
      const res = await dispatch(fetchNotificationsThunk(since ? { since } : undefined));
      if (
        fetchNotificationsThunk.fulfilled.match(res) &&
        res.payload.cursor
      ) {
        writeNotificationsCursor(res.payload.cursor);
      }
    } catch {
      /* non-fatal */
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dispatch(cloudNotesSlice.actions.syncMeta({ status: "error", error: msg }));
  }
});

export const {
  selectCloudNote,
  resetCloudNotes,
  createCloudNoteLocal,
  patchCloudNoteLocal,
  softDeleteCloudNoteLocal,
} = cloudNotesSlice.actions;

const cloudNotesReducer = cloudNotesSlice.reducer;
export default cloudNotesReducer;
