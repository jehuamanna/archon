import { createListenerMiddleware, isAnyOf } from "@reduxjs/toolkit";
import {
  openCloudNotesDbForUser,
  rxdbUpsertCloudNoteRow,
} from "../cloud-sync/cloud-notes-rxdb";
import {
  createCloudNoteLocal,
  patchCloudNoteLocal,
  softDeleteCloudNoteLocal,
  type CloudNotesState,
} from "./cloudNotesSlice";
import type { CloudNoteDoc } from "./cloudNotesTypes";
import {
  ELECTRON_SCRATCH_CLOUD_USER_ID,
  isElectronScratchSession,
} from "../auth/electron-scratch";
import {
  WEB_SCRATCH_CLOUD_USER_ID,
  isWebScratchSession,
} from "../auth/web-scratch-session";

type ListenerRoot = {
  cloudAuth: { status: string; userId: string | null };
  cloudNotes: CloudNotesState;
};

export const cloudNotesRxListener = createListenerMiddleware();

cloudNotesRxListener.startListening({
  matcher: isAnyOf(
    createCloudNoteLocal,
    patchCloudNoteLocal,
    softDeleteCloudNoteLocal,
  ),
  effect: async (action, listenerApi) => {
    const state = listenerApi.getState() as ListenerRoot;
    let storageUserId: string | null =
      state.cloudAuth.status === "signedIn" && state.cloudAuth.userId
        ? state.cloudAuth.userId
        : null;
    if (!storageUserId && typeof window !== "undefined") {
      if (isWebScratchSession()) {
        storageUserId = WEB_SCRATCH_CLOUD_USER_ID;
      } else if (isElectronScratchSession()) {
        storageUserId = ELECTRON_SCRATCH_CLOUD_USER_ID;
      }
    }
    if (!storageUserId) {
      return;
    }
    const opened = await openCloudNotesDbForUser(storageUserId);
    if (!opened) {
      return;
    }
    let id: string | null = null;
    if (createCloudNoteLocal.match(action)) {
      id = state.cloudNotes.selectedId;
    } else if (patchCloudNoteLocal.match(action)) {
      id = action.payload.id;
    } else if (softDeleteCloudNoteLocal.match(action)) {
      id = action.payload;
    }
    if (!id) {
      return;
    }
    const doc = state.cloudNotes.byId[id] as CloudNoteDoc | undefined;
    if (!doc) {
      return;
    }
    await rxdbUpsertCloudNoteRow({ ...doc, dirty: true });
  },
});
