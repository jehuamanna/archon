/** Legacy note type id before rename to js notebook. */
export const LEGACY_OBSERVABLE_NOTE_TYPE = "observable";

/** Canonical note type for JS notebook notes (Observable HQ runtime + stdlib). */
export const JS_NOTEBOOK_NOTE_TYPE = "js-notebook";

export function normalizeLegacyNoteType(type: string): string {
  return type === LEGACY_OBSERVABLE_NOTE_TYPE ? JS_NOTEBOOK_NOTE_TYPE : type;
}
