import type { RxJsonSchema } from "rxdb";
import type { CloudNoteDoc } from "../store/cloudNotesTypes";

/** Persisted row: server-shaped note + offline dirty flag (outbox queue). */
export type CloudNoteRow = CloudNoteDoc & { dirty: boolean };

const cloudNoteRxSchemaLiteral = {
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    updatedAt: { type: "number" },
    deleted: { type: "boolean" },
    version: { type: "number", minimum: 0, multipleOf: 1 },
    title: { type: "string" },
    content: { type: "string" },
    type: { type: "string", enum: ["markdown", "text", "code", "image"] },
    dirty: { type: "boolean" },
  },
  required: [
    "id",
    "updatedAt",
    "deleted",
    "version",
    "title",
    "content",
    "type",
    "dirty",
  ],
  additionalProperties: false,
} as const;

export const cloudNoteRxSchema: RxJsonSchema<CloudNoteRow> =
  cloudNoteRxSchemaLiteral as unknown as RxJsonSchema<CloudNoteRow>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbInst: any = null;
let openUserId: string | null = null;

function safeDbNameSegment(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function indexedDbNameForCloudNotesUser(userId: string): string {
  return `archon_cloud_notes__${safeDbNameSegment(userId)}`;
}

/** Close any open RxDB handle and remove the IndexedDB database for this user (e.g. reset web scratch). */
export async function destroyCloudNotesDbForUser(userId: string): Promise<void> {
  if (typeof indexedDB === "undefined") {
    return;
  }
  await closeCloudNotesDb();
  const name = indexedDbNameForCloudNotesUser(userId);
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onblocked = () => {};
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("deleteDatabase failed"));
  });
}

export function getOpenCloudNotesUserId(): string | null {
  return openUserId;
}

export async function openCloudNotesDbForUser(userId: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") {
    return false;
  }
  if (openUserId === userId && dbInst) {
    const { ensureNoStartupErrors } = await import("rxdb");
    await ensureNoStartupErrors(dbInst);
    return true;
  }
  await closeCloudNotesDb();
  const { createRxDatabase, ensureNoStartupErrors } = await import("rxdb");
  const { getRxStorageDexie } = await import("rxdb/plugins/storage-dexie");
  const name = indexedDbNameForCloudNotesUser(userId);
  const db = await createRxDatabase({
    name,
    storage: getRxStorageDexie(),
    multiInstance: true,
    eventReduce: true,
    ignoreDuplicate: true,
  });
  await ensureNoStartupErrors(db);
  await db.addCollections({
    notes: {
      schema: cloudNoteRxSchema,
      migrationStrategies: {
        1: (doc: CloudNoteRow) => doc,
      },
    },
  });
  dbInst = db;
  openUserId = userId;
  return true;
}

export async function closeCloudNotesDb(): Promise<void> {
  if (dbInst) {
    try {
      await dbInst.close();
    } catch {
      /* ignore */
    }
  }
  dbInst = null;
  openUserId = null;
}

export async function rxdbFindAllCloudNotes(): Promise<CloudNoteRow[]> {
  if (!dbInst) {
    return [];
  }
  const docs = await dbInst.notes.find().exec();
  return docs.map((d: { toMutableJSON: (m: boolean) => CloudNoteRow }) =>
    d.toMutableJSON(false),
  );
}

export async function rxdbFindDirtyCloudNotes(): Promise<CloudNoteRow[]> {
  if (!dbInst) {
    return [];
  }
  const docs = await dbInst.notes.find({ selector: { dirty: true } }).exec();
  return docs.map((d: { toMutableJSON: (m: boolean) => CloudNoteRow }) =>
    d.toMutableJSON(false),
  );
}

export async function rxdbUpsertCloudNoteRow(row: CloudNoteRow): Promise<void> {
  if (!dbInst) {
    return;
  }
  await dbInst.notes.upsert(row);
}

export async function rxdbMarkCloudNotesClean(ids: string[]): Promise<void> {
  if (!dbInst || ids.length === 0) {
    return;
  }
  for (const id of ids) {
    const d = await dbInst.notes.findOne(id).exec();
    if (d) {
      await d.incrementalPatch({ dirty: false });
    }
  }
}

export function cloudNoteDocFromRow(row: CloudNoteRow): CloudNoteDoc {
  const { dirty: _d, ...rest } = row;
  return rest;
}
