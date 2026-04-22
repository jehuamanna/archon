import { ipcMain } from "electron";
import { getNotesDatabase } from "../core/workspace-store";
import { getWpnOwnerId } from "../core/wpn/wpn-owner";
import {
  wpnJsonCreateNote,
  wpnJsonGetDefaultProjectIdForOwner,
  wpnJsonGetNoteById,
  wpnJsonListAllNotesAsNoteListItems,
  wpnJsonUpdateNote,
} from "../core/wpn/wpn-json-notes";
import { wpnJsonApplyVfsRewritesAfterTitleChange } from "../core/wpn/wpn-rename-vfs-rewrite";
import { isWpnOnlyFileVaultEnv } from "../shared/wpn-file-vault-env";
import {
  ensureNotesSeeded,
  createNote as createNoteInStore,
  getFirstNote,
  getNoteById,
  getNotesFlat,
  renameNote as renameNoteInStore,
  setNoteContent as setNoteContentInStore,
  setNotePluginUiState,
  patchNoteMetadata,
} from "../core/notes-store";
import { MAX_NOTE_CONTENT_CHARS } from "../core/notes-store-duplicate-create";
import { registry } from "../core/registry";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { Note } from "../shared/archon-renderer-api";
import {
  PLUGIN_UI_METADATA_KEY,
  validatePluginUiStateSize,
} from "../shared/plugin-state-protocol";
import { normalizeLegacyNoteType } from "../shared/note-type-legacy";
import { isValidNoteId, isValidNoteType } from "../shared/validators";
import { ctx } from "./main-context";
import {
  assertProjectOpenForNotes,
  persistNotes,
} from "./main-helpers";
import { pushNotesUndoSnapshot } from "../core/archon-undo";

export function registerStaticIpcNotesRegistryHandlers(): void {
ipcMain.handle(IPC_CHANNELS.GET_NOTE, async (_event, noteId?: string) => {
  if (!ctx.projectRootPath) {
    if (noteId !== undefined) {
      throw new Error("Open a project folder first (Notes → Open project).");
    }
    return null;
  }
  const registeredTypes = registry.getRegisteredTypes();
  ensureNotesSeeded(registeredTypes);

  if (noteId) {
    if (!isValidNoteId(noteId)) {
      throw new Error("Invalid note id");
    }
    const db = getNotesDatabase();
    if (db) {
      const ownerId = getWpnOwnerId();
      const wpn = wpnJsonGetNoteById(db, ownerId, noteId);
      if (wpn) {
        return {
          id: wpn.id,
          type: wpn.type,
          title: wpn.title,
          content: wpn.content,
          metadata: wpn.metadata,
        };
      }
      if (isWpnOnlyFileVaultEnv()) {
        throw new Error("Note not found");
      }
    }
    const note = getNoteById(noteId);
    if (!note) {
      throw new Error("Note not found");
    }
    const { id, type, title, content, metadata } = note;
    return { id, type, title, content, metadata };
  }

  const db = getNotesDatabase();
  if (db && isWpnOnlyFileVaultEnv()) {
    const ownerId = getWpnOwnerId();
    const list = wpnJsonListAllNotesAsNoteListItems(db, ownerId);
    if (list.length === 0) {
      return null;
    }
    const wpn = wpnJsonGetNoteById(db, ownerId, list[0]!.id);
    if (!wpn) {
      return null;
    }
    return {
      id: wpn.id,
      type: wpn.type,
      title: wpn.title,
      content: wpn.content,
      metadata: wpn.metadata,
    };
  }

  const first = getFirstNote();
  if (!first) {
    return null;
  }
  const { id, type, title, content, metadata } = first;
  return { id, type, title, content, metadata };
});

ipcMain.handle(IPC_CHANNELS.GET_ALL_NOTES, async () => {
  if (!ctx.projectRootPath) {
    return [];
  }
  const db = getNotesDatabase();
  if (db && isWpnOnlyFileVaultEnv()) {
    return wpnJsonListAllNotesAsNoteListItems(db, getWpnOwnerId());
  }
  const registeredTypes = registry.getRegisteredTypes();
  ensureNotesSeeded(registeredTypes);
  return getNotesFlat();
});

const MAX_NOTE_TITLE_CHARS = 4_000;

ipcMain.handle(
  IPC_CHANNELS.CREATE_NOTE,
  async (
    _event,
    payload: {
      anchorId?: string;
      relation: string;
      type: string;
      content?: string;
      title?: string;
    },
  ) => {
    assertProjectOpenForNotes();
    const registeredTypes = registry.getRegisteredTypes();
    ensureNotesSeeded(registeredTypes);

    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const rawType = payload.type;
    const type =
      typeof rawType === "string" ? normalizeLegacyNoteType(rawType) : rawType;
    const selectable = registry.getSelectableNoteTypes();
    if (!isValidNoteType(type) || !selectable.includes(type)) {
      throw new Error("Invalid note type");
    }
    const rel = payload.relation;
    if (rel !== "child" && rel !== "sibling" && rel !== "root") {
      throw new Error("Invalid relation");
    }
    let anchorId = payload.anchorId;
    if (anchorId !== undefined && !isValidNoteId(anchorId)) {
      throw new Error("Invalid anchor id");
    }
    if (rel === "root") {
      anchorId = undefined;
    }
    if (payload.content !== undefined) {
      if (typeof payload.content !== "string") {
        throw new Error("Invalid content");
      }
      if (payload.content.length > MAX_NOTE_CONTENT_CHARS) {
        throw new Error("Content too large");
      }
    }
    if (payload.title !== undefined) {
      if (typeof payload.title !== "string") {
        throw new Error("Invalid title");
      }
      if (payload.title.length > MAX_NOTE_TITLE_CHARS) {
        throw new Error("Title too long");
      }
    }
    pushNotesUndoSnapshot();
    const db = getNotesDatabase();
    if (db && isWpnOnlyFileVaultEnv()) {
      const ownerId = getWpnOwnerId();
      const projectId = wpnJsonGetDefaultProjectIdForOwner(db, ownerId);
      if (!projectId) {
        throw new Error("No WPN project; create a workspace first.");
      }
      const created = wpnJsonCreateNote(db, ownerId, projectId, {
        anchorId,
        relation: rel,
        type,
        content: payload.content,
        title: payload.title,
      });
      return { id: created.id };
    }
    const created = createNoteInStore({
      anchorId,
      relation: rel,
      type,
      content: payload.content,
      title: payload.title,
    });
    persistNotes();
    return { id: created.id };
  },
);

ipcMain.handle(
  IPC_CHANNELS.RENAME_NOTE,
  async (_event, id: string, title: string, options?: { updateVfsDependentLinks?: boolean }) => {
  assertProjectOpenForNotes();
  if (!isValidNoteId(id)) {
    throw new Error("Invalid note id");
  }
  if (typeof title !== "string") {
    throw new Error("Invalid title");
  }
  const updateVfsDependentLinks = options?.updateVfsDependentLinks !== false;
  const db = getNotesDatabase();
  const ownerId = getWpnOwnerId();
  if (db && wpnJsonGetNoteById(db, ownerId, id)) {
    const before = wpnJsonGetNoteById(db, ownerId, id);
    if (!before) {
      throw new Error("Note not found");
    }
    try {
      const after = wpnJsonUpdateNote(db, ownerId, id, { title });
      if (!after) {
        throw new Error("Note not found");
      }
      if (
        updateVfsDependentLinks &&
        before.title !== after.title
      ) {
        wpnJsonApplyVfsRewritesAfterTitleChange(
          db,
          ownerId,
          id,
          before.title,
          after.title,
        );
      }
    } catch (e) {
      console.error("[RENAME_NOTE] failed (title or VFS link rewrite):", e);
      throw e instanceof Error ? e : new Error(String(e));
    }
    return;
  }
  if (isWpnOnlyFileVaultEnv()) {
    throw new Error("Note not found");
  }
  const registeredTypes = registry.getRegisteredTypes();
  ensureNotesSeeded(registeredTypes);
  pushNotesUndoSnapshot();
  renameNoteInStore(id, title);
  persistNotes();
  },
);

ipcMain.handle(
  IPC_CHANNELS.SAVE_NOTE_PLUGIN_UI_STATE,
  async (_event, noteId: string, state: unknown) => {
    assertProjectOpenForNotes();
    if (!isValidNoteId(noteId)) {
      throw new Error("Invalid note id");
    }
    const db = getNotesDatabase();
    if (db) {
      const ownerId = getWpnOwnerId();
      const wpn = wpnJsonGetNoteById(db, ownerId, noteId);
      if (wpn) {
        const err = validatePluginUiStateSize(state);
        if (err) throw new Error(err);
        const meta: Record<string, unknown> = { ...(wpn.metadata ?? {}) };
        meta[PLUGIN_UI_METADATA_KEY] = state;
        wpnJsonUpdateNote(db, ownerId, noteId, { metadata: meta });
        return;
      }
      if (isWpnOnlyFileVaultEnv()) {
        throw new Error("Note not found");
      }
    } else if (isWpnOnlyFileVaultEnv()) {
      throw new Error("Notes workspace not initialized");
    }
    const registeredTypes = registry.getRegisteredTypes();
    ensureNotesSeeded(registeredTypes);
    setNotePluginUiState(noteId, state);
    persistNotes();
  },
);

ipcMain.handle(
  IPC_CHANNELS.SAVE_NOTE_CONTENT,
  async (_event, noteId: string, content: string) => {
    assertProjectOpenForNotes();
    if (!isValidNoteId(noteId)) {
      throw new Error("Invalid note id");
    }
    if (typeof content !== "string") {
      throw new Error("Invalid content");
    }
    const db = getNotesDatabase();
    const ownerId = getWpnOwnerId();
    if (db && wpnJsonGetNoteById(db, ownerId, noteId)) {
      wpnJsonUpdateNote(db, ownerId, noteId, { content });
      return;
    }
    if (isWpnOnlyFileVaultEnv()) {
      throw new Error("Note not found");
    }
    const registeredTypes = registry.getRegisteredTypes();
    ensureNotesSeeded(registeredTypes);
    setNoteContentInStore(noteId, content);
    persistNotes();
  },
);

ipcMain.handle(
  IPC_CHANNELS.PATCH_NOTE_METADATA,
  async (_event, noteId: string, patch: Record<string, unknown>) => {
    assertProjectOpenForNotes();
    if (!isValidNoteId(noteId)) {
      throw new Error("Invalid note id");
    }
    if (!patch || typeof patch !== "object") {
      throw new Error("Invalid metadata patch");
    }
    const db = getNotesDatabase();
    if (db) {
      const ownerId = getWpnOwnerId();
      const wpn = wpnJsonGetNoteById(db, ownerId, noteId);
      if (wpn) {
        const meta: Record<string, unknown> = { ...(wpn.metadata ?? {}) };
        for (const [k, v] of Object.entries(patch)) {
          meta[k] = v;
        }
        wpnJsonUpdateNote(db, ownerId, noteId, { metadata: meta });
        return;
      }
      if (isWpnOnlyFileVaultEnv()) {
        throw new Error("Note not found");
      }
    } else if (isWpnOnlyFileVaultEnv()) {
      throw new Error("Notes workspace not initialized");
    }
    const registeredTypes = registry.getRegisteredTypes();
    ensureNotesSeeded(registeredTypes);
    patchNoteMetadata(noteId, patch);
    persistNotes();
  },
);

ipcMain.handle(
  IPC_CHANNELS.GET_PLUGIN_HTML,
  async (_event, type: string, note: Note) => {
    if (!isValidNoteType(type)) {
      throw new Error("Invalid note type");
    }

    const renderer = registry.getRenderer(type);
    if (!renderer) {
      return null;
    }

    try {
      const html = await Promise.resolve(renderer.render(note));
      return html;
    } catch (error) {
      console.error(
        `[Main] Error rendering plugin HTML for type ${type}:`,
        error,
      );
      throw error;
    }
  },
);

ipcMain.handle(IPC_CHANNELS.GET_REGISTERED_TYPES, async () => {
  return registry.getRegisteredTypes();
});

ipcMain.handle(IPC_CHANNELS.GET_SELECTABLE_NOTE_TYPES, async () => {
  return registry.getSelectableNoteTypes();
});
}
