/**
 * ADR-016 — Local workspace / WPN mirror in RxDB (renderer, Dexie).
 * Phase 1–2: snapshot collection + import; authoritative JSON + IPC remain in the main process until Phase 4.
 * Phase 4 (thin main): this module becomes the primary local SoT; main shrinks to filesystem/sync bridge.
 */
import type { RxJsonSchema } from "rxdb";
import type { WorkspaceRxdbMirrorPayloadV1 } from "../../shared/workspace-rxdb-mirror-payload";
import { isWorkspaceRxdbMirrorPayloadV1 } from "../../shared/workspace-rxdb-mirror-payload";
import { isLocalRxdbWpnMirrorEnabled } from "./flags";
import {
  hydrateWpnLocalMirrorFromPayload,
  LOCAL_WPN_MIRROR_COLLECTIONS,
} from "./wpn-local-rxdb-mirror";
import { scheduleDebouncedNotesRefetchAfterWpnPersist } from "./wpn-persist-refetch";

export type WorkspaceSnapshotRow = {
  id: string;
  vaultKey: string;
  workspaceJson: string;
  importedAt: number;
};

const workspaceSnapshotRxSchemaLiteral = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 256 },
    vaultKey: { type: "string", maxLength: 512 },
    workspaceJson: { type: "string" },
    importedAt: { type: "number" },
  },
  required: ["id", "vaultKey", "workspaceJson", "importedAt"],
  additionalProperties: false,
} as const;

export const workspaceSnapshotRxSchema: RxJsonSchema<WorkspaceSnapshotRow> =
  workspaceSnapshotRxSchemaLiteral as unknown as RxJsonSchema<WorkspaceSnapshotRow>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbInst: any = null;
let openVaultKey: string | null = null;

function safeVaultSegment(vaultKey: string): string {
  return vaultKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function indexedDbNameForWorkspaceVault(vaultKey: string): string {
  return `archon_workspace_wpn__${safeVaultSegment(vaultKey)}`;
}

export async function closeWorkspaceWpnRxDb(): Promise<void> {
  if (dbInst) {
    try {
      await dbInst.close();
    } catch {
      /* ignore */
    }
  }
  dbInst = null;
  openVaultKey = null;
}

/**
 * Opens (or reopens) the RxDB for this vault key when `ARCHON_LOCAL_RXDB_WPN` is set.
 * No-op when the flag is off or IndexedDB is unavailable.
 */
export async function touchWorkspaceRxDbForVaultKey(vaultKey: string): Promise<boolean> {
  if (!isLocalRxdbWpnMirrorEnabled()) {
    return false;
  }
  if (typeof indexedDB === "undefined") {
    return false;
  }
  const key = vaultKey.trim();
  if (!key) {
    return false;
  }
  if (openVaultKey === key && dbInst) {
    const { ensureNoStartupErrors } = await import("rxdb");
    await ensureNoStartupErrors(dbInst);
    return true;
  }
  await closeWorkspaceWpnRxDb();
  const { createRxDatabase, ensureNoStartupErrors } = await import("rxdb");
  const { getRxStorageDexie } = await import("rxdb/plugins/storage-dexie");
  const name = indexedDbNameForWorkspaceVault(key);
  const db = await createRxDatabase({
    name,
    storage: getRxStorageDexie(),
    multiInstance: true,
    eventReduce: true,
    ignoreDuplicate: true,
  });
  await ensureNoStartupErrors(db);
  const desiredCollections: Record<string, { schema: RxJsonSchema<unknown> }> = {
    workspace_snapshots: { schema: workspaceSnapshotRxSchema as RxJsonSchema<unknown> },
    ...(LOCAL_WPN_MIRROR_COLLECTIONS as unknown as Record<string, { schema: RxJsonSchema<unknown> }>),
  };
  const toAdd = Object.fromEntries(
    Object.entries(desiredCollections).filter(([name]) => !(name in db.collections)),
  );
  if (Object.keys(toAdd).length > 0) {
    await db.addCollections(toAdd);
  }
  dbInst = db;
  openVaultKey = key;
  return true;
}

/** ADR-016 Phase 3: store a full `archon-workspace.json` payload for migration / audit. */
export async function importWorkspaceJsonSnapshot(
  vaultKey: string,
  workspaceJson: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const opened = await touchWorkspaceRxDbForVaultKey(vaultKey);
  if (!opened || !dbInst) {
    return { ok: false, error: "RxDB workspace mirror not available" };
  }
  const trimmed = workspaceJson.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty workspace JSON" };
  }
  const row: WorkspaceSnapshotRow = {
    id: "latest",
    vaultKey: vaultKey.trim(),
    workspaceJson: trimmed,
    importedAt: Date.now(),
  };
  await dbInst.workspace_snapshots.upsert(row);
  return { ok: true };
}

export async function readLatestWorkspaceJsonSnapshot(
  vaultKey: string,
): Promise<string | null> {
  const opened = await touchWorkspaceRxDbForVaultKey(vaultKey);
  if (!opened || !dbInst) {
    return null;
  }
  const doc = await dbInst.workspace_snapshots.findOne("latest").exec();
  if (!doc) {
    return null;
  }
  const j = doc.toMutableJSON(false) as WorkspaceSnapshotRow;
  return typeof j.workspaceJson === "string" ? j.workspaceJson : null;
}

/** Open RxDB instance for ADR-016 overlay reads (null if mirror disabled or not opened). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getOpenWorkspaceWpnRxDb(): any {
  return dbInst;
}

export async function importWorkspaceMirrorFromMainPayload(
  payload: WorkspaceRxdbMirrorPayloadV1,
): Promise<void> {
  const r = await importWorkspaceJsonSnapshot(payload.vaultKey, JSON.stringify(payload));
  if (!r.ok || !dbInst) {
    return;
  }
  await hydrateWpnLocalMirrorFromPayload(dbInst, payload);
  scheduleDebouncedNotesRefetchAfterWpnPersist();
}

export async function readLatestMirrorPayload(
  vaultKey: string,
): Promise<WorkspaceRxdbMirrorPayloadV1 | null> {
  const raw = await readLatestWorkspaceJsonSnapshot(vaultKey);
  if (!raw) {
    return null;
  }
  try {
    const j = JSON.parse(raw) as unknown;
    return isWorkspaceRxdbMirrorPayloadV1(j) ? j : null;
  } catch {
    return null;
  }
}
