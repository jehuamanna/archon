import * as fs from "fs";
import * as path from "path";
import {
  ensureNotesSeeded,
  getNotesFlat,
  importSerializedState,
  mergeAttachedSerializedIntoStore,
  mergeMultipleRootsIfNeeded,
  resetNotesStore,
  seedAttachedWorkspaceIfEmpty,
} from "./notes-store";
import { seedBundledDocumentationNotesFromDir } from "./bundled-docs-seed";
import {
  releaseWorkspaceStore,
  getNotesDatabase,
  initWorkspaceNotesDatabase,
  type WorkspaceStore,
} from "./workspace-store";
import { migrateLegacyFlatToWpnInPrimarySlot } from "./wpn/legacy-flat-to-wpn-migrate";

function trySeedBundledDocsAndSave(store: WorkspaceStore | null): void {
  if (!store) {
    return;
  }
  try {
    if (seedBundledDocumentationNotesFromDir()) {
      store.persist();
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[Archon] bundled documentation seed failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

export type NotesLoadResult = "ok" | "missing" | "invalid";

/** Load notes from legacy `notes-tree.json` into memory (migration only). */
export function loadNotesStateFromJsonFile(filePath: string): NotesLoadResult {
  if (!fs.existsSync(filePath)) {
    return "missing";
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const ok = importSerializedState(JSON.parse(raw) as unknown);
    if (!ok) {
      return "invalid";
    }
    mergeMultipleRootsIfNeeded();
    return "ok";
  } catch {
    return "invalid";
  }
}

export function saveNotesState(): void {
  const store = getNotesDatabase();
  if (!store) {
    throw new Error("Notes workspace store not initialized");
  }
  store.persist();
}

/**
 * Load primary + attached project data into memory. `legacyJsonPath` is for the first root only.
 */
export function bootstrapWorkspaceNotes(
  roots: string[],
  legacyJsonPath: string,
  registeredTypes: string[],
  options?: { diskPersistence?: boolean; scratchSession?: boolean },
): void {
  for (const r of roots) {
    const root = path.resolve(r);
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  }

  const store = initWorkspaceNotesDatabase(roots, {
    diskPersistence: options?.diskPersistence,
    scratchSession: options?.scratchSession,
  });

  if (store.countLegacyNotesInSlot(0) === 0 && fs.existsSync(legacyJsonPath)) {
    resetNotesStore();
    const migrated = loadNotesStateFromJsonFile(legacyJsonPath);
    if (migrated === "ok" && getNotesFlat().length > 0) {
      store.persist();
      try {
        fs.renameSync(legacyJsonPath, `${legacyJsonPath}.migrated.bak`);
      } catch {
        /* non-fatal */
      }
    }
  }

  resetNotesStore();

  const mainEmpty = store.countLegacyNotesInSlot(0) === 0;
  const slot0 = store.slots[0]!;
  const primaryWpnEmpty =
    slot0.workspaces.length === 0 &&
    slot0.projects.length === 0 &&
    slot0.notes.length === 0;
  let allAttachedEmpty = true;
  for (let i = 1; i < roots.length; i++) {
    const st = store.readSerializedFromSlot(i);
    if (st.records.length > 0) {
      allAttachedEmpty = false;
    }
  }

  if (mainEmpty && allAttachedEmpty && primaryWpnEmpty) {
    ensureNotesSeeded(registeredTypes, {
      homeMarkdown: store.getHomeWelcomeMarkdown(0),
    });
    mergeMultipleRootsIfNeeded();
    store.persist();
    trySeedBundledDocsAndSave(store);
    return;
  }

  if (!store.loadPrimaryLegacyIntoMemory()) {
    if (primaryWpnEmpty) {
      resetNotesStore();
      ensureNotesSeeded(registeredTypes, {
        homeMarkdown: store.getHomeWelcomeMarkdown(0),
      });
      mergeMultipleRootsIfNeeded();
      store.persist();
      trySeedBundledDocsAndSave(store);
      return;
    }
    resetNotesStore();
    mergeMultipleRootsIfNeeded();
    trySeedBundledDocsAndSave(store);
    return;
  }

  mergeMultipleRootsIfNeeded();

  for (let i = 1; i < roots.length; i++) {
    const data = store.readSerializedFromSlot(i);
    mergeAttachedSerializedIntoStore(i, roots[i]!, data, registeredTypes);
    seedAttachedWorkspaceIfEmpty(i, registeredTypes);
  }
  mergeMultipleRootsIfNeeded();

  if (roots.length > 1) {
    store.persist();
  }

  if (getNotesFlat().length === 0 && registeredTypes.length > 0) {
    resetNotesStore();
    ensureNotesSeeded(registeredTypes, {
      homeMarkdown: store.getHomeWelcomeMarkdown(0),
    });
    mergeMultipleRootsIfNeeded();
    store.persist();
    trySeedBundledDocsAndSave(store);
    return;
  }

  mergeMultipleRootsIfNeeded();
  trySeedBundledDocsAndSave(store);
  let legacyFlatMigrated = false;
  try {
    legacyFlatMigrated = migrateLegacyFlatToWpnInPrimarySlot(store);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[Archon] legacy→WPN migration:",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!legacyFlatMigrated) {
    trySeedBundledDocsAndSave(store);
  }
}

/**
 * Open workspace JSON store; migrate from legacy `notes-tree.json` in data/ if empty.
 * `dbPath` should be `project/data/archon-workspace.json` (or any file under `project/data/`); parent folders resolve the project root.
 */
export function bootstrapNotesTree(
  dbPath: string,
  legacyJsonPath: string,
  registeredTypes: string[],
): void {
  const root = path.dirname(path.dirname(path.resolve(dbPath)));
  bootstrapWorkspaceNotes([root], legacyJsonPath, registeredTypes);
}

export { releaseWorkspaceStore };
