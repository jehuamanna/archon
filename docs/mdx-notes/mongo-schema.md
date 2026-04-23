# MongoDB Schema — Per-Project Mini-App State (KV + transparent chunking)

Database: `archon_sync` (existing). Two new collections: `mdx_state_head`, `mdx_state_chunks`.

## Prerequisites

- **Replica set required.** Change Streams and multi-document transactions both depend on it. Startup check (see `apps/archon-sync-api/src/mdx-state/schema.ts`) logs a warning if `replicaSet` is unset.

## Collections

### `mdx_state_head` (one doc per `(projectId, key)`)

```ts
interface MdxStateHeadDoc {
  _id: ObjectId;
  projectId: string;
  key: string;
  mode: "inline" | "chunked";
  value?: unknown;            // present iff mode === "inline"
  totalChunks?: number;       // present iff mode === "chunked"
  totalBytes: number;
  version: number;            // monotonic per (projectId, key)
  updatedAt: Date;
  updatedBy: { userId: string; email: string };
}
```

**Indexes** (idempotent on connect, same pattern as `ensureIndexes` in `apps/archon-sync-api/src/db.ts:178`):

- `{ projectId: 1, key: 1 }`, unique
- `{ projectId: 1, updatedAt: -1 }`

### `mdx_state_chunks` (only when `mode === "chunked"`)

```ts
interface MdxStateChunkDoc {
  _id: ObjectId;
  projectId: string;
  key: string;
  chunkIndex: number;         // 0..totalChunks-1
  headVersion: number;        // stale chunks have older headVersion
  data: Buffer;               // BSON binary; ≤ 8MB
}
```

**Indexes**:

- `{ projectId: 1, key: 1, chunkIndex: 1, headVersion: 1 }`, unique
- `{ projectId: 1, key: 1, headVersion: 1 }` (for GC)

## Thresholds

| Constant | Value | Purpose |
|---|---|---|
| `INLINE_THRESHOLD_BYTES` | `4 * 1024 * 1024` | Below this, value stays in head doc. |
| `CHUNK_SIZE_BYTES` | `8 * 1024 * 1024` | Each chunk doc holds ≤ 8MB of serialized bytes. |
| `KEY_MAX_BYTES` | `256 * 1024 * 1024` | Soft cap per key (413 past). |
| `MAX_KEYS_PER_PROJECT` | `1000` | Guard against accidental key explosion (422 past). |

## Write algorithm (transactional)

```pseudo
async function put({ projectId, key, value, expectedVersion, actor }):
  let size = serializedSize(value)
  if size > KEY_MAX_BYTES: throw 413

  await withTransaction(async session => {
    const head = await head.findOne({ projectId, key }, { session })
    if head and head.version !== expectedVersion: throw 409
    if !head and expectedVersion !== 0: throw 409

    const version = (head?.version ?? 0) + 1

    if size <= INLINE_THRESHOLD_BYTES:
      await head.replaceOne({ projectId, key }, {
        projectId, key, mode: "inline", value, totalBytes: size,
        version, updatedAt: new Date(), updatedBy: actor,
      }, { upsert: true, session })
      await chunks.deleteMany({ projectId, key }, { session })
    else:
      const serialized = BSON.serialize({ v: value })  // or JSON + utf-8 encode
      const chunkCount = Math.ceil(serialized.length / CHUNK_SIZE_BYTES)
      await head.replaceOne({ projectId, key }, {
        projectId, key, mode: "chunked",
        totalChunks: chunkCount, totalBytes: size,
        version, updatedAt: new Date(), updatedBy: actor,
      }, { upsert: true, session })
      for i in 0..chunkCount-1:
        const data = serialized.subarray(i * CHUNK_SIZE_BYTES, (i+1) * CHUNK_SIZE_BYTES)
        await chunks.insertOne({
          projectId, key, chunkIndex: i, headVersion: version, data,
        }, { session })
      await chunks.deleteMany(
        { projectId, key, headVersion: { $lt: version } },
        { session })
  })
```

Up to 3 retries on `WriteConflict` (transient transaction error); final failure surfaces as 409.

## Read algorithm

```pseudo
const head = await head.findOne({ projectId, key })
if !head: return { value: undefined, version: 0 }
if head.mode === "inline": return { value: head.value, version: head.version }
const chunks = await chunks.find({
  projectId, key, headVersion: head.version
}).sort({ chunkIndex: 1 }).toArray()
const buffer = Buffer.concat(chunks.map(c => c.data))
return { value: BSON.deserialize(buffer).v, version: head.version }
```

## List algorithm

```pseudo
return head.find({ projectId }).project({
  key: 1, version: 1, mode: 1, totalBytes: 1, updatedAt: 1
}).toArray()
```

## Live update fan-out

- Backend opens **one Change Stream per WS connection**, filtered to `project_state_head` with `match: { "fullDocument.projectId": projectId }`.
- Each CS event → one push frame over WS: `{ projectId, key, version, mode, updatedAt, updatedBy, value? }`. The `value` is included only for `mode: "inline"` (avoids hauling chunked blobs over WS).
- Client drops stale frames by `version`.
- Resume tokens stored per connection; on reconnect, client sends `lastSeenVersionPerKey` so server can replay missing versions (direct `head` read, bounded by `lastSeenVersion`).

## Top 3 risks

1. **Torn reads during re-chunk** — a reader mid-swap could fetch `head.version = N` but still-written chunks for `N-1`. Mitigation: chunks carry `headVersion`; reader filters by `headVersion === head.version`. Stale chunks survive briefly but are never fetched.
2. **Change-Stream resume token loss on backend restart** — clients lose the tail. Mitigation: store resume tokens in a small `mdx_state_ws_cursors` collection keyed by `connectionId`; on reconnect, resume from there, fall back to `now`.
3. **Hot-key write storms** — 50 rapid `setState` calls fight on one doc. Mitigation: 50ms client-side coalescing, plus server-side token-bucket rate limit (20/s, burst 50).

## Migration path

If single-doc-per-key ever proves inadequate (e.g. 100k keys in one project causing slow `find({projectId})`), shard by `projectId` via Mongo sharding. API remains `useProjectState(key)` — zero client change.

## No TTL for v1

State sticks with the project. When a project is deleted, state docs should be cleaned in the same transaction as project deletion (future work — not in v1 because project deletion flow has not yet been audited).
