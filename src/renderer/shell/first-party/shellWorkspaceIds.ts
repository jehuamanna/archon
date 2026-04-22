/** Shared ids for shell note workspace (avoid circular imports between plugins). */
export const SHELL_TAB_WELCOME_TYPE_ID = "shell.tab.welcome";
/** Reuses the note editor view; singleton scratch note id is stored in `localStorage`. */
export const SHELL_TAB_SCRATCH_MARKDOWN = "shell.tab.scratchMarkdown";
export const SHELL_TAB_NOTE = "shell.tab.note";
export const SHELL_VIEW_NOTE_EDITOR = "shell.noteEditor";
export const SHELL_VIEW_MARKDOWN_TOC = "shell.markdownToc";
export const NOTES_EXPLORER_TAB = "plugin.notes-explorer.tab";
export const NOTES_EXPLORER_VIEW_SIDEBAR = "plugin.notes-explorer.sidebar";
export const NOTES_EXPLORER_VIEW_MAIN = "plugin.notes-explorer.main";

/** Tabs that use {@link SHELL_VIEW_NOTE_EDITOR} with `{ noteId }` state (pin, URL hash, TOC, …). */
export function isShellNoteEditorTabType(tabTypeId: string): boolean {
  return tabTypeId === SHELL_TAB_NOTE || tabTypeId === SHELL_TAB_SCRATCH_MARKDOWN;
}
