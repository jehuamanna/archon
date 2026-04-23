import type { Db } from "mongodb";
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

/**
 * Cached replica-set detection. `null` = unknown (haven't checked yet or check
 * failed); true/false = known. Populated on the first put(); subsequent writes
 * short-circuit the check.
 */
let replicaSetAvailable: boolean | null = null;

async function detectReplicaSet(db: Db): Promise<boolean> {
  try {
    // Note: `hello` returns `setName` on replica-set members. On standalone
    // Mongo, `setName` is absent.
    const info = (await db.command({ hello: 1 })) as { setName?: string };
    return typeof info.setName === "string" && info.setName.length > 0;
  } catch {
    return false;
  }
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
    const t0 = Date.now();
    const doc = await head.findOne({ projectId, key });
    const t1 = Date.now();
    if (!doc) {
      // eslint-disable-next-line no-console
      console.info(
        `[mdx-state] svc.get key=${key} headLookup=${t1 - t0}ms result=absent`,
      );
      return { value: undefined, version: 0, mode: "absent" };
    }
    if (doc.mode === "inline") {
      // eslint-disable-next-line no-console
      console.info(
        `[mdx-state] svc.get key=${key} headLookup=${t1 - t0}ms mode=inline version=${doc.version}`,
      );
      return { value: doc.value as T, version: doc.version, mode: "inline" };
    }
    const chunks = getMdxStateChunks(this.db);
    const list = await chunks
      .find({ projectId, key, headVersion: doc.version })
      .sort({ chunkIndex: 1 })
      .toArray();
    const t2 = Date.now();
    // Defensive: an orphaned chunked head (chunks deleted but head not flipped)
    // used to throw `JSON.parse("")` SyntaxError, which Fastify's error
    // serializer can mishandle behind app.inject and leave the reply stalled.
    // Treat as absent and log — readers already filter chunks on headVersion
    // per the "torn state invisible" contract (plan 4), so this is safe.
    if (list.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mdx-state] svc.get key=${key} headLookup=${t1 - t0}ms chunksLookup=${t2 - t1}ms mode=chunked version=${doc.version} — NO CHUNKS FOUND, returning absent`,
      );
      return { value: undefined, version: 0, mode: "absent" };
    }
    // Mongo returns `data` as a `Binary` wrapper in the v6 driver. Accept both
    // Buffer and Binary by coercing through `.buffer`/`Uint8Array` as needed.
    const bufs = list.map((c) => {
      const d = c.data as unknown;
      if (Buffer.isBuffer(d)) return d;
      if (d && typeof d === "object" && "buffer" in d) {
        return Buffer.from((d as { buffer: Buffer | Uint8Array }).buffer);
      }
      if (d instanceof Uint8Array) return Buffer.from(d);
      return Buffer.alloc(0);
    });
    const buf = Buffer.concat(bufs);
    const text = buf.toString("utf8");
    const t3 = Date.now();
    if (text.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mdx-state] svc.get key=${key} mode=chunked version=${doc.version} — EMPTY chunk payload, returning absent`,
      );
      return { value: undefined, version: 0, mode: "absent" };
    }
    let parsed: { v: T };
    try {
      parsed = JSON.parse(text) as { v: T };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mdx-state] svc.get key=${key} mode=chunked version=${doc.version} — JSON.parse failed (${(err as Error).message}), returning absent`,
      );
      return { value: undefined, version: 0, mode: "absent" };
    }
    // eslint-disable-next-line no-console
    console.info(
      `[mdx-state] svc.get key=${key} headLookup=${t1 - t0}ms chunksLookup=${t2 - t1}ms parse=${t3 - t2}ms mode=chunked version=${doc.version} bytes=${buf.length}`,
    );
    return { value: parsed.v, version: doc.version, mode: "chunked" };
  }

  /**
   * Write a value, optionally chunking oversize payloads. The Mongo transaction
   * path is used only when the server is a replica set; on standalone Mongo
   * (common in local dev) we fall back to a non-transactional sequence.
   *
   * The inline path is a single-document upsert — atomic on standalone Mongo
   * without a transaction. The chunked path is a multi-doc sequence; readers
   * filter chunks by `headVersion` so torn state is never observed (only the
   * fully-written previous version or the new one becomes visible).
   */
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

    if (replicaSetAvailable === null) {
      replicaSetAvailable = await detectReplicaSet(this.db);
    }

    const head = getMdxStateHead(this.db);
    const chunks = getMdxStateChunks(this.db);

    const current = await head.findOne({ projectId, key });
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      throw new MdxStateConflictError(currentVersion);
    }
    if (!current) {
      const keyCount = await head.countDocuments({ projectId });
      if (keyCount >= MAX_KEYS_PER_PROJECT) {
        throw new MdxStateKeyLimitError(keyCount);
      }
    }

    const nextVersion = currentVersion + 1;
    const updatedAt = new Date();

    if (size <= INLINE_THRESHOLD_BYTES) {
      const doc: MdxStateHeadDoc = {
        projectId,
        key,
        mode: "inline",
        value,
        totalBytes: size,
        version: nextVersion,
        updatedAt,
        updatedBy: actor,
      };
      // Conditional replace on (projectId, key, version) protects against
      // concurrent writers — if another writer committed between our read and
      // write, matchedCount is 0 and we surface a conflict.
      const res = await head.replaceOne(
        { projectId, key, version: currentVersion },
        doc,
        { upsert: currentVersion === 0 },
      );
      if (res.matchedCount === 0 && !res.upsertedId) {
        const racerCurrent = await head.findOne({ projectId, key });
        throw new MdxStateConflictError(racerCurrent?.version ?? 0);
      }
      // GC any stale chunks (transition from chunked → inline). Independent
      // single-doc deletes; a failure here is cosmetic (stale chunks are
      // filtered by headVersion on read anyway).
      await chunks.deleteMany({ projectId, key });
      return { version: nextVersion, mode: "inline", totalBytes: size };
    }

    // Chunked path. Prefer a transaction on replica-set Mongo; otherwise fall
    // back to a non-transactional write sequence. Readers protect themselves
    // by filtering chunks on `headVersion`, so even torn state during a
    // crash is invisible to GET.
    const serialized = Buffer.from(JSON.stringify({ v: value }), "utf8");
    const totalChunks = Math.ceil(serialized.length / CHUNK_SIZE_BYTES);
    const chunkDocs: Array<{
      projectId: string;
      key: string;
      chunkIndex: number;
      headVersion: number;
      data: Buffer;
    }> = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE_BYTES;
      const end = Math.min(start + CHUNK_SIZE_BYTES, serialized.length);
      chunkDocs.push({
        projectId,
        key,
        chunkIndex: i,
        headVersion: nextVersion,
        data: serialized.subarray(start, end),
      });
    }
    const newHead: MdxStateHeadDoc = {
      projectId,
      key,
      mode: "chunked",
      totalChunks,
      totalBytes: size,
      version: nextVersion,
      updatedAt,
      updatedBy: actor,
    };

    if (replicaSetAvailable) {
      const client = this.db.client;
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const res = await head.replaceOne(
            { projectId, key, version: currentVersion },
            newHead,
            { upsert: currentVersion === 0, session },
          );
          if (res.matchedCount === 0 && !res.upsertedId) {
            const racer = await head.findOne({ projectId, key }, { session });
            throw new MdxStateConflictError(racer?.version ?? 0);
          }
          if (chunkDocs.length > 0) {
            await chunks.insertMany(chunkDocs, { session, ordered: true });
          }
          await chunks.deleteMany(
            { projectId, key, headVersion: { $lt: nextVersion } },
            { session },
          );
        });
      } finally {
        await session.endSession();
      }
    } else {
      // Non-replica-set fallback: write chunks FIRST (stamped with nextVersion),
      // then flip the head. Readers stay on the old version until the head
      // update commits; once flipped, they see the fully-written new chunks.
      if (chunkDocs.length > 0) {
        await chunks.insertMany(chunkDocs, { ordered: true });
      }
      const res = await head.replaceOne(
        { projectId, key, version: currentVersion },
        newHead,
        { upsert: currentVersion === 0 },
      );
      if (res.matchedCount === 0 && !res.upsertedId) {
        // Race lost — someone else bumped the version. Orphan chunks will be
        // GC'd by the next successful write (deleteMany below) or stay
        // inaccessible because their headVersion doesn't match any head.
        await chunks.deleteMany({
          projectId,
          key,
          headVersion: nextVersion,
        });
        const racer = await head.findOne({ projectId, key });
        throw new MdxStateConflictError(racer?.version ?? 0);
      }
      await chunks.deleteMany({
        projectId,
        key,
        headVersion: { $lt: nextVersion },
      });
    }

    return { version: nextVersion, mode: "chunked", totalBytes: size };
  }
}

/** Test hook — reset the replica-set detection cache. */
export function __resetMdxStateReplicaDetectionForTests(): void {
  replicaSetAvailable = null;
}
