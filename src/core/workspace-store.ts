import * as fs from "fs";
import * as path from "path";
import {
  exportSerializedState,
  importSerializedState,
  ROOT_KEY,
  type SerializedNotesState,
} from "./notes-store";
import { isWpnOnlyFileVaultEnv } from "../shared/wpn-file-vault-env";
import { isWorkspaceRxdbAuthorityEnvEnabled } from "../shared/workspace-rxdb-env";
import type { WorkspaceRxdbMirrorPayloadV1 } from "../shared/workspace-rxdb-mirror-payload";
import { WPN_SCHEMA_VERSION } from "./wpn/wpn-types";
import type {
  WpnNoteRow,
  WpnProjectRow,
  WpnWorkspaceRow,
} from "./wpn/wpn-types";

const WORKSPACE_JSON = "archon-workspace.json";
const FILE_VERSION = 1;

const APP_META_HOME_WELCOME_MD_KEY = "home_welcome_markdown_v1";

const DEFAULT_HOME_WELCOME_MARKDOWN = `# Welcome to Archon

This **Home** note is the workspace root — use it as your documentation landing page.

## Tips

- Add child notes for topics, specs, and runbooks.
- Use **Markdown** notes for readable docs; other note types showcase plugins.
- The tree on the left is your single outline for everything in this workspace.

---

_Edit this page anytime to match your project._`;

/** Workspace row including owner (persisted in JSON workspace alongside WPN rows). */
export type WpnWorkspaceStored = WpnWorkspaceRow & { owner_id: string };

export type WorkspaceExplorerRow = {
  project_id: string;
  expanded_ids: string[];
};

export type WorkspacePersistedSlot = {
  appMeta: Record<string, string>;
  legacy: SerializedNotesState;
  wpnMeta: Array<{ key: string; value: string }>;
  workspaces: WpnWorkspaceStored[];
  projects: WpnProjectRow[];
  notes: WpnNoteRow[];
  explorer: WorkspaceExplorerRow[];
  /** Per-workspace arbitrary JSON settings (WPN), keyed by workspace id. */
  wpnWorkspaceSettings: Record<string, Record<string, unknown>>;
  /** Per-project arbitrary JSON settings (WPN), keyed by project id. */
  wpnProjectSettings: Record<string, Record<string, unknown>>;
};

function emptyLegacy(): SerializedNotesState {
  return { v: 1, records: [], order: {} };
}

function emptySlot(): WorkspacePersistedSlot {
  return {
    appMeta: {
      [APP_META_HOME_WELCOME_MD_KEY]: DEFAULT_HOME_WELCOME_MARKDOWN,
    },
    legacy: emptyLegacy(),
    wpnMeta: [{ key: "schema_version", value: String(WPN_SCHEMA_VERSION) }],
    workspaces: [],
    projects: [],
    notes: [],
    explorer: [],
    wpnWorkspaceSettings: {},
    wpnProjectSettings: {},
  };
}

function normalizeSlot(raw: unknown): WorkspacePersistedSlot {
  if (!raw || typeof raw !== "object") {
    return emptySlot();
  }
  const o = raw as Record<string, unknown>;
  if (o.fileVersion !== FILE_VERSION && o.version !== FILE_VERSION) {
    /* tolerate missing version for hand-authored files */
  }
  const legacy =
    o.legacy && typeof o.legacy === "object"
      ? (o.legacy as SerializedNotesState)
      : emptyLegacy();
  if (!legacy.records) {
    legacy.records = [];
  }
  if (!legacy.order) {
    legacy.order = {};
  }
  const appMeta =
    o.appMeta && typeof o.appMeta === "object" && !Array.isArray(o.appMeta)
      ? (o.appMeta as Record<string, string>)
      : {};
  if (!appMeta[APP_META_HOME_WELCOME_MD_KEY]) {
    appMeta[APP_META_HOME_WELCOME_MD_KEY] = DEFAULT_HOME_WELCOME_MARKDOWN;
  }
  const wpnMeta = Array.isArray(o.wpnMeta)
    ? (o.wpnMeta as Array<{ key: string; value: string }>)
    : [{ key: "schema_version", value: String(WPN_SCHEMA_VERSION) }];
  const workspaces = Array.isArray(o.workspaces)
    ? (o.workspaces as WpnWorkspaceStored[])
    : [];
  const projects = Array.isArray(o.projects)
    ? (o.projects as WpnProjectRow[])
    : [];
  const notes = Array.isArray(o.notes) ? (o.notes as WpnNoteRow[]) : [];
  const explorer = Array.isArray(o.explorer)
    ? (o.explorer as WorkspaceExplorerRow[])
    : [];
  const wpnWorkspaceSettings =
    o.wpnWorkspaceSettings &&
    typeof o.wpnWorkspaceSettings === "object" &&
    !Array.isArray(o.wpnWorkspaceSettings)
      ? (o.wpnWorkspaceSettings as Record<string, Record<string, unknown>>)
      : {};
  const wpnProjectSettings =
    o.wpnProjectSettings &&
    typeof o.wpnProjectSettings === "object" &&
    !Array.isArray(o.wpnProjectSettings)
      ? (o.wpnProjectSettings as Record<string, Record<string, unknown>>)
      : {};
  return {
    appMeta,
    legacy,
    wpnMeta,
    workspaces,
    projects,
    notes,
    explorer,
    wpnWorkspaceSettings,
    wpnProjectSettings,
  };
}

export function workspaceDataJsonPath(root: string): string {
  return path.join(path.resolve(root), "data", WORKSPACE_JSON);
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, filePath);
}

/** Validate JSON and persist raw UTF-8 (ADR-016 renderer → disk flush). */
export function writeWorkspaceJsonFileRawUtf8(filePath: string, utf8: string): void {
  JSON.parse(utf8);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, utf8, "utf8");
  fs.renameSync(tmp, filePath);
}

type WorkspacePersistHook = () => void;

let workspacePersistHook: WorkspacePersistHook | null = null;

/** Main registers ADR-016 mirror broadcast (debounced) after JSON persist. */
export function setWorkspaceStorePersistHook(hook: WorkspacePersistHook | null): void {
  workspacePersistHook = hook;
}

/**
 * ADR-016 Phase 4: apply a renderer-built mirror payload to disk and reload in-memory slots.
 * Caller must hold the same `WorkspaceStore` instance as `getNotesDatabase()`.
 */
export function flushWorkspaceStoreFromMirrorPayload(
  store: WorkspaceStore,
  payload: WorkspaceRxdbMirrorPayloadV1,
): void {
  for (let i = 0; i < payload.slots.length && i < store.roots.length; i++) {
    const s = payload.slots[i]!;
    if (path.resolve(s.root) !== path.resolve(store.roots[i]!)) {
      throw new Error(`Workspace mirror flush: root mismatch at slot ${i}`);
    }
    const fp = store.filePathForSlot(i);
    if (path.resolve(s.path) !== path.resolve(fp)) {
      throw new Error(`Workspace mirror flush: path mismatch at slot ${i}`);
    }
    writeWorkspaceJsonFileRawUtf8(fp, s.json);
    store.slots[i] = readSlotFile(fp);
  }
}

function readSlotFile(filePath: string): WorkspacePersistedSlot {
  if (!fs.existsSync(filePath)) {
    return emptySlot();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeSlot(raw);
  } catch {
    return emptySlot();
  }
}

function filterOrderForMain(
  order: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(order)) {
    if (!Array.isArray(ids)) {
      continue;
    }
    if (/^r\d+_/.test(k)) {
      continue;
    }
    out[k] = ids.filter((id) => !/^r\d+_/.test(id));
  }
  return out;
}

function buildAttachedOrder(
  order: Record<string, string[]>,
  slot: number,
  mountId: string,
  pref: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(order)) {
    if (!Array.isArray(ids)) {
      continue;
    }
    if (k === mountId) {
      out[ROOT_KEY] = ids
        .filter((id) => id.startsWith(pref))
        .map((id) => id.slice(pref.length));
      continue;
    }
    if (!k.startsWith(pref)) {
      continue;
    }
    const nk = k.slice(pref.length);
    out[nk] = ids
      .filter((id) => id.startsWith(pref))
      .map((id) => id.slice(pref.length));
  }
  return out;
}

let workspaceStore: WorkspaceStore | null = null;

export type InitWorkspaceNotesOptions = {
  /** When false, `persist()` is a no-op (ephemeral temp-dir scratch). Default: true when not scratch. */
  diskPersistence?: boolean;
  /** Temp-dir Electron scratch: in-memory + optional on-disk JSON only after save-to-folder. */
  scratchSession?: boolean;
};

export class WorkspaceStore {
  /** Mutable: `saveScratchWorkspaceToFolder` replaces the scratch root with a real folder path. */
  roots: string[];

  readonly slots: WorkspacePersistedSlot[];

  scratchSession: boolean;

  diskPersistence: boolean;

  /** Timer handle for trailing-edge debounced `persistDebounced()`. */
  private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Trailing-edge debounce window for `persistDebounced()`. Small enough that rapid edits coalesce, short enough to bound data-loss on crash. */
  private static readonly PERSIST_DEBOUNCE_MS = 50;

  private constructor(
    roots: string[],
    slots: WorkspacePersistedSlot[],
    scratchSession: boolean,
    diskPersistence: boolean,
  ) {
    this.roots = roots;
    this.slots = slots;
    this.scratchSession = scratchSession;
    this.diskPersistence = diskPersistence;
  }

  static open(roots: string[], options?: InitWorkspaceNotesOptions): WorkspaceStore {
    const resolved = roots.map((r) => path.resolve(r));
    const scratchSession = options?.scratchSession === true;
    const diskPersistence =
      options?.diskPersistence !== undefined
        ? options.diskPersistence
        : !scratchSession;
    const slots = resolved.map((root) =>
      readSlotFile(workspaceDataJsonPath(root)),
    );
    return new WorkspaceStore(resolved, slots, scratchSession, diskPersistence);
  }

  filePathForSlot(slotIndex: number): string {
    return workspaceDataJsonPath(this.roots[slotIndex]!);
  }

  getAppMeta(slotIndex: number, key: string): string | null {
    return this.slots[slotIndex]?.appMeta[key] ?? null;
  }

  setAppMeta(slotIndex: number, key: string, value: string): void {
    const s = this.slots[slotIndex];
    if (!s) {
      return;
    }
    s.appMeta[key] = value;
  }

  getHomeWelcomeMarkdown(slotIndex = 0): string {
    return (
      this.getAppMeta(slotIndex, APP_META_HOME_WELCOME_MD_KEY) ??
      DEFAULT_HOME_WELCOME_MARKDOWN
    );
  }

  countLegacyNotesInSlot(slotIndex: number): number {
    return this.slots[slotIndex]?.legacy.records.length ?? 0;
  }

  /** Load primary slot legacy tree into in-memory notes-store. */
  loadPrimaryLegacyIntoMemory(): boolean {
    const slot = this.slots[0];
    if (!slot || slot.legacy.records.length === 0) {
      return false;
    }
    return importSerializedState(slot.legacy);
  }

  readSerializedFromSlot(slotIndex: number): SerializedNotesState {
    const slot = this.slots[slotIndex];
    if (!slot) {
      return emptyLegacy();
    }
    const { records, order } = slot.legacy;
    return {
      v: 1,
      records: records.map((r) => ({ ...r })),
      order: { ...order },
    };
  }

  /**
   * Persist in-memory notes tree + all WPN data to per-root JSON files.
   * Skipped for ephemeral scratch until `diskPersistence` is enabled (save-to-folder).
   */
  persist(): void {
    if (!this.diskPersistence) {
      return;
    }
    if (isWorkspaceRxdbAuthorityEnvEnabled()) {
      return;
    }
    const state = exportSerializedState();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (isWpnOnlyFileVaultEnv()) {
        slot.legacy = { v: 1, records: [], order: {} };
      } else if (i === 0) {
        const mainRecs = state.records.filter((r) => !/^r\d+_/.test(r.id));
        const mainOrder = filterOrderForMain(state.order);
        slot.legacy = {
          v: 1,
          records: mainRecs.map((r) => ({ ...r })),
          order: { ...mainOrder },
        };
      } else {
        const pref = `r${i}_`;
        const mountId = `__archon_mount_${i}`;
        const attachedRecs = state.records
          .filter((r) => r.id.startsWith(pref))
          .map((r) => ({
            ...r,
            id: r.id.slice(pref.length),
            parentId:
              r.parentId === mountId
                ? null
                : r.parentId != null && r.parentId.startsWith(pref)
                  ? r.parentId.slice(pref.length)
                  : null,
          }));
        const attOrder = buildAttachedOrder(state.order, i, mountId, pref);
        slot.legacy = {
          v: 1,
          records: attachedRecs,
          order: { ...attOrder },
        };
      }
      writeJsonAtomic(this.filePathForSlot(i), {
        fileVersion: FILE_VERSION,
        appMeta: { ...slot.appMeta },
        legacy: slot.legacy,
        wpnMeta: [...slot.wpnMeta],
        workspaces: slot.workspaces.map((w) => ({ ...w })),
        projects: slot.projects.map((p) => ({ ...p })),
        notes: slot.notes.map((n) => ({ ...n })),
        explorer: slot.explorer.map((e) => ({
          project_id: e.project_id,
          expanded_ids: [...e.expanded_ids],
        })),
        wpnWorkspaceSettings: { ...slot.wpnWorkspaceSettings },
        wpnProjectSettings: { ...slot.wpnProjectSettings },
      });
    }
    if (workspacePersistHook) {
      try {
        workspacePersistHook();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Coalesces rapid mutations into a single disk write. Callers that need synchronous
   * durability (tests, app-exit handlers) must call `flushPendingPersist()` after mutating.
   */
  persistDebounced(): void {
    if (!this.diskPersistence) {
      return;
    }
    if (this.persistDebounceTimer != null) {
      clearTimeout(this.persistDebounceTimer);
    }
    this.persistDebounceTimer = setTimeout(() => {
      this.persistDebounceTimer = null;
      this.persist();
    }, WorkspaceStore.PERSIST_DEBOUNCE_MS);
  }

  /** Force-flush any pending debounced persist immediately. Safe to call when no persist is pending. */
  flushPendingPersist(): void {
    if (this.persistDebounceTimer == null) {
      return;
    }
    clearTimeout(this.persistDebounceTimer);
    this.persistDebounceTimer = null;
    this.persist();
  }
}

export function initWorkspaceNotesDatabase(
  rootPaths: string[],
  options?: InitWorkspaceNotesOptions,
): WorkspaceStore {
  if (rootPaths.length === 0) {
    throw new Error("initWorkspaceNotesDatabase: no roots");
  }
  if (workspaceStore) {
    workspaceStore = null;
  }
  workspaceStore = WorkspaceStore.open(rootPaths, options);
  return workspaceStore;
}

/** Read persisted primary slot from disk (for one-off migration; does not open the global store). */
export function readWorkspacePersistedSlotForRoot(root: string): WorkspacePersistedSlot {
  return readSlotFile(workspaceDataJsonPath(root));
}

export function getNotesDatabase(): WorkspaceStore | null {
  return workspaceStore;
}

/** Drop the in-memory `WorkspaceStore` singleton (e.g. before opening another project). */
export function releaseWorkspaceStore(): void {
  workspaceStore?.flushPendingPersist();
  workspaceStore = null;
}

/** Flush any debounced persist on the singleton store. No-op when no store is open. */
export function flushWorkspaceStorePendingPersist(): void {
  workspaceStore?.flushPendingPersist();
}

export function getAttachedDatabaseAliases(): string[] {
  if (!workspaceStore || workspaceStore.roots.length < 2) {
    return [];
  }
  return workspaceStore.roots.slice(1).map((_, i) => `ext${i + 1}`);
}

/** @deprecated Use `WorkspaceStore` / `getNotesDatabase()`. */
export type NotesDatabase = WorkspaceStore;
