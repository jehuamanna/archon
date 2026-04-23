import type { Db, ClientSession } from "mongodb";
import {
  CHUNK_SIZE_BYTES,
  INLINE_THRESHOLD_BYTES,
  KEY_MAX_BYTES,
  MAX_KEYS_PER_PROJECT,
  getMdxStateChunks,
  getMdxStateHead,
  serializedSize,
  type MdxStateHeadDoc,
} from "./schema.js";

export interface Actor {
  userId: string;
  email: string;
}

export class MdxStateConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("version conflict");
    this.name = "MdxStateConflictError";
  }
}

export class MdxStateTooLargeError extends Error {
  constructor(readonly totalBytes: number) {
    super("state value exceeds per-key cap");
    this.name = "MdxStateTooLargeError";
  }
}

export class MdxStateKeyLimitError extends Error {
  constructor(readonly keyCount: number) {
    super("project state key-count cap reached");
    this.name = "MdxStateKeyLimitError";
  }
}

export interface GetResult<T = unknown> {
  value: T | undefined;
  version: number;
  mode: "inline" | "chunked" | "absent";
}

export interface KeyMeta {
  key: string;
  version: number;
  mode: "inline" | "chunked";
  totalBytes: number;
  updatedAt: Date;
}

export interface PutResult {
  version: number;
  mode: "inline" | "chunked";
  totalBytes: number;
}

export class MdxStateService {
  constructor(private readonly db: Db) {}

  async list(projectId: string): Promise<KeyMeta[]> {
    const head = getMdxStateHead(this.db);
    const docs = await head
      .find(
        { projectId },
        {
          projection: {
            _id: 0,
            key: 1,
            version: 1,
            mode: 1,
            totalBytes: 1,
            updatedAt: 1,
          },
        },
      )
      .toArray();
    return docs.map((d) => ({
      key: d.key as string,
      version: d.version as number,
      mode: d.mode as "inline" | "chunked",
      totalBytes: d.totalBytes as number,
      updatedAt: d.updatedAt as Date,
    }));
  }

  async get<T = unknown>(projectId: string, key: string): Promise<GetResult<T>> {
    const head = getMdxStateHead(this.db);
    const doc = await head.findOne({ projectId, key });
    if (!doc) {
      return { value: undefined, version: 0, mode: "absent" };
    }
    if (doc.mode === "inline") {
      return { value: doc.value as T, version: doc.version, mode: "inline" };
    }
    const chunks = getMdxStateChunks(this.db);
    const list = await chunks
      .find({ projectId, key, headVersion: doc.version })
      .sort({ chunkIndex: 1 })
      .toArray();
    const buf = Buffer.concat(list.map((c) => c.data));
    const parsed = JSON.parse(buf.toString("utf8")) as { v: T };
    return { value: parsed.v, version: doc.version, mode: "chunked" };
  }

  async put<T>(
    projectId: string,
    key: string,
    value: T,
    expectedVersion: number,
    actor: Actor,
  ): Promise<PutResult> {
    const size = serializedSize(value);
    if (size > KEY_MAX_BYTES) {
      throw new MdxStateTooLargeError(size);
    }

    const client = this.db.client ?? null;
    if (!client) {
      throw new Error("Mongo client not reachable from Db");
    }
    const session: ClientSession = client.startSession();
    try {
      let result: PutResult | undefined;
      await session.withTransaction(async () => {
        const head = getMdxStateHead(this.db);
        const chunks = getMdxStateChunks(this.db);

        const current = await head.findOne({ projectId, key }, { session });
        const currentVersion = current?.version ?? 0;
        if (currentVersion !== expectedVersion) {
          throw new MdxStateConflictError(currentVersion);
        }

        if (!current) {
          const keyCount = await head.countDocuments(
            { projectId },
            { session },
          );
          if (keyCount >= MAX_KEYS_PER_PROJECT) {
            throw new MdxStateKeyLimitError(keyCount);
          }
        }

        const version = currentVersion + 1;
        const updatedAt = new Date();

        if (size <= INLINE_THRESHOLD_BYTES) {
          const doc: MdxStateHeadDoc = {
            projectId,
            key,
            mode: "inline",
            value,
            totalBytes: size,
            version,
            updatedAt,
            updatedBy: actor,
          };
          await head.replaceOne(
            { projectId, key },
            doc,
            { upsert: true, session },
          );
          await chunks.deleteMany({ projectId, key }, { session });
          result = { version, mode: "inline", totalBytes: size };
          return;
        }

        const serialized = Buffer.from(
          JSON.stringify({ v: value }),
          "utf8",
        );
        const totalChunks = Math.ceil(serialized.length / CHUNK_SIZE_BYTES);
        const doc: MdxStateHeadDoc = {
          projectId,
          key,
          mode: "chunked",
          totalChunks,
          totalBytes: size,
          version,
          updatedAt,
          updatedBy: actor,
        };
        await head.replaceOne(
          { projectId, key },
          doc,
          { upsert: true, session },
        );
        const chunkDocs = [];
        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE_BYTES;
          const end = Math.min(start + CHUNK_SIZE_BYTES, serialized.length);
          chunkDocs.push({
            projectId,
            key,
            chunkIndex: i,
            headVersion: version,
            data: serialized.subarray(start, end),
          });
        }
        if (chunkDocs.length > 0) {
          await chunks.insertMany(chunkDocs, { session, ordered: true });
        }
        await chunks.deleteMany(
          { projectId, key, headVersion: { $lt: version } },
          { session },
        );
        result = { version, mode: "chunked", totalBytes: size };
      });
      if (!result) {
        throw new Error("Transaction returned no result");
      }
      return result;
    } finally {
      await session.endSession();
    }
  }
}
