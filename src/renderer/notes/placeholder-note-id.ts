/**
 * Renderer-side note-id placeholder protocol.
 *
 * The explorer optimistically inserts a row into the local notes list with a
 * synthetic id (`__pending_create__<uuid>`) before the server has actually
 * created the row. Any consumer that derives a server request from a
 * `noteId` MUST treat placeholder ids as inert — server-side `notes.id` is a
 * Postgres uuid, so passing the placeholder through hits a 22P02 from
 * `string_to_uuid` and surfaces as a 500. The server defensively translates
 * non-UUID note ids to 404 (see `assertCanReadProjectForNote` /
 * `-ForWrite`), but client-side gating avoids the spurious request and
 * console-error noise entirely.
 *
 * Source of truth for the placeholder format is the explorer's
 * `onCreateNote` flow.
 */
export const PLACEHOLDER_NOTE_ID_PREFIX = "__pending_create__";

export function isPlaceholderNoteId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith(PLACEHOLDER_NOTE_ID_PREFIX);
}
