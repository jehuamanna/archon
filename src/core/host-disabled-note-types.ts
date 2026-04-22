/**
 * Note types the host refuses to expose or back with a renderer, even if a plugin
 * calls `registerNoteRenderer` for them. Extend this set to drop other types from
 * pickers and IPC without uninstalling the plugin package.
 */
const HOST_DISABLED_NOTE_TYPES = new Set<string>(["pdf", "image"]);

export function isHostDisabledNoteType(type: string): boolean {
  return HOST_DISABLED_NOTE_TYPES.has(type);
}
