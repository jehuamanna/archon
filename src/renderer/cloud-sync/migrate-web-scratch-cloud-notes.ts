import {
  closeCloudNotesDb,
  openCloudNotesDbForUser,
  rxdbFindAllCloudNotes,
  rxdbUpsertCloudNoteRow,
} from "./cloud-notes-rxdb";
import {
  WEB_SCRATCH_CLOUD_USER_ID,
  setWebScratchSession,
} from "../auth/web-scratch-session";

/** Copy browser-only scratch cloud notes into the signed-in user’s local DB (then push via normal sync). */
export async function migrateWebScratchCloudNotesToUser(
  realUserId: string,
): Promise<void> {
  const target = realUserId.trim();
  if (!target) {
    return;
  }
  await openCloudNotesDbForUser(WEB_SCRATCH_CLOUD_USER_ID);
  const rows = await rxdbFindAllCloudNotes();
  await closeCloudNotesDb();
  if (rows.length === 0) {
    setWebScratchSession(false);
    return;
  }
  await openCloudNotesDbForUser(target);
  for (const row of rows) {
    await rxdbUpsertCloudNoteRow({ ...row, dirty: true });
  }
  await closeCloudNotesDb();
  setWebScratchSession(false);
}
