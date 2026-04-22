import { store } from "../store";
import { clearCurrentNote } from "../store/notesSlice";
import { isShellNoteEditorTabType } from "./first-party/shellWorkspaceIds";
import type { ShellTabsRegistry } from "./registries/ShellTabsRegistry";
import { dispatchShellNoteTabClosed } from "./shellTabUrlSync";

function collectOpenNoteIds(tabs: ShellTabsRegistry): Set<string> {
  const ids = new Set<string>();
  for (const t of tabs.listOpenTabs()) {
    if (!isShellNoteEditorTabType(t.tabTypeId)) continue;
    const nid = (t.state as { noteId?: string } | undefined)?.noteId;
    if (typeof nid === "string" && nid.length > 0) ids.add(nid);
  }
  return ids;
}

/**
 * Close a main-area shell tab, optionally open Welcome when empty, sync URL hash via tabs.emit,
 * and clear Redux current note when its tab is gone. Active note body load is handled by NoteEditorShellView.
 */
export function closeShellTabInstance(tabs: ShellTabsRegistry, instanceId: string): void {
  const normalizedInstanceId = String(instanceId).trim();
  const inst = tabs.listOpenTabs().find((t) => t.instanceId === normalizedInstanceId);
  const closedNoteId =
    inst && isShellNoteEditorTabType(inst.tabTypeId)
      ? (inst.state as { noteId?: string } | undefined)?.noteId
      : undefined;

  tabs.closeTab(normalizedInstanceId);

  if (typeof closedNoteId === "string" && closedNoteId) {
    dispatchShellNoteTabClosed(closedNoteId);
  }

  const openNoteIds = collectOpenNoteIds(tabs);
  const curId = store.getState().notes.currentNote?.id;
  if (
    curId &&
    typeof closedNoteId === "string" &&
    curId === closedNoteId &&
    !openNoteIds.has(curId)
  ) {
    store.dispatch(clearCurrentNote());
  }

  if (tabs.listOpenTabs().length === 0) {
    tabs.openOrReuseTab("shell.tab.welcome", { title: "Welcome", reuseKey: "shell:welcome" });
  }
}

/**
 * Close every main-area note tab whose `state.noteId` is in `noteIds`, then reconcile Redux, URL (via emit),
 * and Welcome — same end state as calling {@link closeShellTabInstance} for each.
 */
export function closeShellTabsForNoteIds(tabs: ShellTabsRegistry, noteIds: readonly string[]): void {
  const idSet = new Set(
    noteIds
      .map((id) => String(id).trim())
      .filter((id) => typeof id === "string" && id.length > 0),
  );
  if (idSet.size === 0) return;

  const open = tabs.listOpenTabs();
  const toClose = open.filter((t) => {
    if (!isShellNoteEditorTabType(t.tabTypeId)) return false;
    const nid = (t.state as { noteId?: string } | undefined)?.noteId;
    return typeof nid === "string" && idSet.has(nid);
  });
  if (toClose.length === 0) return;

  const closedNoteIds = new Set<string>();
  for (const t of toClose) {
    const nid = (t.state as { noteId?: string } | undefined)?.noteId;
    if (typeof nid === "string" && nid.length > 0) closedNoteIds.add(nid);
  }

  for (const t of toClose) {
    tabs.closeTab(t.instanceId);
  }

  for (const nid of closedNoteIds) {
    dispatchShellNoteTabClosed(nid);
  }

  const openNoteIds = collectOpenNoteIds(tabs);
  const curId = store.getState().notes.currentNote?.id;
  if (curId && idSet.has(curId) && !openNoteIds.has(curId)) {
    store.dispatch(clearCurrentNote());
  }

  if (tabs.listOpenTabs().length === 0) {
    tabs.openOrReuseTab("shell.tab.welcome", { title: "Welcome", reuseKey: "shell:welcome" });
  }
}
