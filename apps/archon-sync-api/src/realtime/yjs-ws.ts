/**
 * Hocuspocus mount at `GET /v1/ws/yjs`. The Y.Doc selector ("documentName")
 * arrives in the Hocuspocus auth protocol message — the client does NOT
 * carry the noteId in the URL. Each documentName maps to its own Y.Doc;
 * the Postgres adapter from `yjs-pg-adapter.ts` provides the snapshot +
 * incremental log persistence.
 *
 * Auth: short-TTL `typ: "wsClient"` JWT in the WS query string proves identity.
 * Authorisation resolves the note's project (`notes.projectId`) and gates on
 * `effectiveRoleInProject`, matching the rest of the post-squash auth model
 * (`spaces` was dropped — projects are the canonical access scope now).
 *
 * Initial state seeding: when the snapshot is empty (first connection ever
 * on a note), we seed the Y.Text channel `content` with the existing
 * `notes.content` so the first editor sees the body they expect.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Server } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import IORedis from "ioredis";
import * as Y from "yjs";
import { eq, sql } from "drizzle-orm";
import { verifyAndTranslate } from "../auth-translate.js";
import { effectiveAccessRoleInProject } from "../permission-resolver.js";
import { getDb, withTx } from "../pg.js";
import { notes } from "../db/schema.js";
import { createYjsPgAdapter, type YjsPgAdapter } from "./yjs-pg-adapter.js";

let _sharedAdapter: YjsPgAdapter | null = null;
export function getYjsAdapter(): YjsPgAdapter {
  if (!_sharedAdapter) _sharedAdapter = createYjsPgAdapter();
  return _sharedAdapter;
}

const REVOKE_REVERIFY_INTERVAL_MS = 10_000;

/**
 * Per-connection revoke-reverify timers, keyed by Hocuspocus socketId. The
 * `connected` hook attaches an interval that re-checks `effectiveRoleInProject`
 * and force-closes the connection when the role disappears; `onDisconnect`
 * clears it so closed sockets don't leak timers.
 */
const revokeReverifyTimers = new Map<string, NodeJS.Timeout>();

/**
 * Per-user open Yjs WS sockets, keyed by user id → socketId set. Bounded
 * by `ARCHON_YJS_MAX_CONNS_PER_USER` so a single account can't tie up an
 * unbounded slice of the Hocuspocus instance with parallel tabs.
 */
const userConnections = new Map<string, Set<string>>();

/**
 * Y.Map("metadata") keys that flow live across the Hocuspocus connection.
 * Confined to user-editable text fields so structural / asset fields
 * (`r2Key`, `mimeType`, `sizeBytes`, thumbs) keep their REST-managed
 * last-write-wins semantics — those are set by single-actor flows
 * (upload, thumbnail regen) and don't benefit from CRDT merge.
 */
const COLLABORATIVE_METADATA_KEYS = ["altText", "caption"] as const;
type CollaborativeMetadataKey = (typeof COLLABORATIVE_METADATA_KEYS)[number];

let _sharedServer: ReturnType<typeof Server.configure> | null = null;
/**
 * Test helper: tear down the shared Hocuspocus server so its internal
 * timers stop and the test process can exit cleanly.
 */
export async function _shutdownYjsServerForTests(): Promise<void> {
  for (const t of revokeReverifyTimers.values()) clearInterval(t);
  revokeReverifyTimers.clear();
  userConnections.clear();
  if (_sharedServer) {
    try {
      await _sharedServer.destroy();
    } catch {
      /* ignore */
    }
    _sharedServer = null;
  }
}

/**
 * Apply a server-side rewrite of `Y.Text("content")` for `noteId` so that
 * REST writes (e.g. `PATCH /notes/:id` from the MCP tool) reach the
 * live Yjs document instead of being clobbered by the next autosave.
 *
 * Without this, `onStoreDocument` periodically flushes the connected
 * editor's *current* in-memory Y.Doc state back to `notes.content`,
 * silently overwriting any HTTP PATCH that landed in between.
 *
 * Routing the REST write through `openDirectConnection` instead:
 *   - loads the Y.Doc (from `yjs_state` snapshot or the seeded `content`),
 *   - replaces `Y.Text("content")` inside one transaction,
 *   - causes Hocuspocus to broadcast the diff to every connected editor,
 *   - schedules the bridge in `onStoreDocument` to write the matching
 *     content to `notes.content` (so the persisted snapshot and the
 *     row stay in sync).
 *
 * No-ops when the Hocuspocus server isn't configured (the same process
 * may host non-realtime API instances or run in tests that don't mount
 * `/v1/ws/yjs`). Errors are swallowed: a failed direct-doc update must
 * not fail the underlying REST PATCH that already succeeded against
 * `notes`.
 */
export async function applyContentToYjsDoc(
  noteId: string,
  content: string,
): Promise<void> {
  if (!_sharedServer) return;
  try {
    const conn = await _sharedServer.openDirectConnection(noteId);
    try {
      await conn.transact((document) => {
        const ytext = document.getText("content");
        const current = ytext.toString();
        if (current === content) return;
        ytext.delete(0, ytext.length);
        if (content.length > 0) ytext.insert(0, content);
      });
    } finally {
      await conn.disconnect();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[yjs-ws] applyContentToYjsDoc failed:",
      noteId,
      (err as Error).message,
    );
  }
}

async function resolveProjectForNote(noteId: string): Promise<string | null> {
  const noteRows = await getDb()
    .select({ projectId: notes.projectId })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  return noteRows[0]?.projectId ?? null;
}

export function registerYjsWsRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(app as any).websocketServer) {
    app.log.info(
      "realtime: skipping /v1/ws/yjs (@fastify/websocket not registered on this instance)",
    );
    return;
  }

  const { jwtSecret } = opts;
  const adapter = getYjsAdapter();
  const debounceMs = Number(process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS ?? 400);
  const maxDebounceMs = Number(
    process.env.ARCHON_YJS_AUTOSAVE_MAX_DEBOUNCE_MS ?? 1500,
  );
  const maxConnsPerUser = Number(
    process.env.ARCHON_YJS_MAX_CONNS_PER_USER ?? 20,
  );
  // 5 MB Y.Text upper bound. Pasting a megabyte-scale doc is the realistic
  // upper edge; anything above this is almost always a runaway / abuse
  // signal. Configurable so support can raise it for one-off cases.
  const maxDocBytes = Number(
    process.env.ARCHON_YJS_MAX_DOC_BYTES ?? 5 * 1024 * 1024,
  );

  // Cross-replica fanout: if REDIS_URL is set, the Hocuspocus Redis extension
  // pub/subs Yjs updates and awareness across every sync-api replica. Without
  // it (single-process deployments, dev, tests), Hocuspocus runs in-memory
  // only — clients on the same replica still collaborate, but two clients on
  // different replicas would split-brain.
  const extensions: import("@hocuspocus/server").Extension[] = [];
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const replicaId =
      process.env.ARCHON_REPLICA_ID || `archon-sync-${randomUUID()}`;
    const prefix = process.env.ARCHON_YJS_REDIS_PREFIX || "archon-yjs";
    extensions.push(
      new RedisExtension({
        identifier: replicaId,
        prefix,
        // ioredis honors connection strings (redis://, rediss://, with auth).
        // We pass createClient so the extension can spin its own pub + sub
        // duplexes from the same URL.
        createClient: () => new IORedis(redisUrl, { lazyConnect: false }),
      }),
    );
    app.log.info(
      { replicaId, prefix },
      "realtime: Hocuspocus Redis pub/sub enabled",
    );
  }

  _sharedServer = Server.configure({
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    extensions,
    async onAuthenticate({ token, documentName }) {
      const payload = await verifyAndTranslate(jwtSecret, token);
      if (payload.typ !== "wsClient") {
        throw new Error("wrong token typ");
      }
      const projectId = await resolveProjectForNote(documentName);
      if (!projectId) {
        throw new Error("note has no resolvable project");
      }
      // Use the access-role variant: master admin / org admin must be allowed
      // here for parity with REST. The raw team-grant lookup would reject
      // the bootstrap admin (no team_projects row) even though every REST
      // PATCH from the same principal succeeds — the bug manifests as
      // `permission-denied` on the Yjs WS while the editor silently falls
      // back to debounced PATCH on every keystroke.
      const role = await effectiveAccessRoleInProject(payload.sub, projectId);
      if (!role) throw new Error("no access to project");
      // Stash projectId in the connection context so the `connected` hook can
      // attach a periodic revocation check tied to the same role evaluation.
      return {
        user: { id: payload.sub, email: payload.email, role },
        projectId,
      };
    },
    async connected({ context, socketId, connectionInstance }) {
      // Mid-session permission revocation. Mirrors the 10s reverify loop in
      // `ws-skeleton.ts` for the space WS so a user whose project access is
      // revoked mid-edit can't keep writing through their open Yjs socket
      // until the browser disconnects on its own.
      const ctx = context as
        | { user?: { id?: string }; projectId?: string }
        | undefined;
      const userId = ctx?.user?.id;
      const projectId = ctx?.projectId;
      if (!userId || !projectId) return;
      // Per-user connection cap. Closing here (rather than in `onAuthenticate`)
      // is intentional: socketId is allocated by Hocuspocus on accept, so we
      // can only key the user's slot table reliably once the connection has
      // crossed the auth boundary. Tabs over the cap get 4429.
      let userSet = userConnections.get(userId);
      if (!userSet) {
        userSet = new Set<string>();
        userConnections.set(userId, userSet);
      }
      if (userSet.size >= maxConnsPerUser) {
        connectionInstance.close({
          code: 4429,
          reason: "too many connections",
        });
        return;
      }
      userSet.add(socketId);
      const interval = setInterval(() => {
        void (async () => {
          try {
            // Same bypass-aware check as `onAuthenticate`; otherwise an
            // org / master admin would get force-closed every 10 s.
            const role = await effectiveAccessRoleInProject(userId, projectId);
            if (!role) {
              connectionInstance.close({
                code: 4403,
                reason: "access revoked",
              });
            }
          } catch {
            /* ignore — reverify failures shouldn't tear the socket down */
          }
        })();
      }, REVOKE_REVERIFY_INTERVAL_MS);
      interval.unref?.();
      revokeReverifyTimers.set(socketId, interval);
    },
    async onDisconnect({ socketId, context }) {
      const t = revokeReverifyTimers.get(socketId);
      if (t) {
        clearInterval(t);
        revokeReverifyTimers.delete(socketId);
      }
      const userId = (context as { user?: { id?: string } } | undefined)?.user
        ?.id;
      if (userId) {
        const set = userConnections.get(userId);
        if (set) {
          set.delete(socketId);
          if (set.size === 0) userConnections.delete(userId);
        }
      }
    },
    async onLoadDocument({ documentName, document }) {
      const noteId = documentName;
      const stored = await adapter.loadDoc(noteId);
      if (stored && stored.length > 0) {
        Y.applyUpdate(document, stored);
        return document;
      }
      // Q4 default: seed Y.Text 'content' from notes.content if any, and
      // seed the collaborative subset of `metadata` into Y.Map("metadata") so
      // image notes pick up their existing alt/caption on first WS open.
      const noteRows = await getDb()
        .select({
          content: notes.content,
          metadata: notes.metadata,
        })
        .from(notes)
        .where(eq(notes.id, noteId))
        .limit(1);
      const seedText = noteRows[0]?.content ?? "";
      if (seedText.length > 0) {
        document.getText("content").insert(0, seedText);
      }
      const seedMeta = noteRows[0]?.metadata as
        | Record<string, unknown>
        | null
        | undefined;
      if (seedMeta) {
        const ymap = document.getMap<unknown>("metadata");
        for (const key of COLLABORATIVE_METADATA_KEYS) {
          const v = seedMeta[key];
          if (typeof v === "string") ymap.set(key, v);
        }
      }
      return document;
    },
    async onStoreDocument({ documentName, document, context }) {
      const noteId = documentName;
      const text = document.getText("content").toString();
      // Refuse to persist an empty Y.Doc that would clobber existing
      // `notes.content`. Hocuspocus may invoke onStoreDocument early
      // in the connection lifecycle (before sync completes) or after a
      // client mounted with an empty Y.Text shadow; persisting the empty
      // state then would replace the seed with "" both in `yjs_state`
      // and in `notes.content`, and the next open would `applyUpdate`
      // the 2-byte empty state and skip the seed branch — losing content
      // forever. If the editor genuinely cleared the note, that is
      // expressed as a non-empty Y.Doc with delete-set entries, so the
      // empty-string check here is a strict guard, not a false positive.
      if (text.length === 0) {
        const noteRows = await getDb()
          .select({ content: notes.content })
          .from(notes)
          .where(eq(notes.id, noteId))
          .limit(1);
        if ((noteRows[0]?.content ?? "").length > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            "[yjs-ws] skip store: empty Y.Doc would clobber non-empty content",
            { noteId },
          );
          return;
        }
      }
      const fullState = Buffer.from(Y.encodeStateAsUpdate(document));
      if (fullState.byteLength > maxDocBytes) {
        // Refuse to persist a runaway document. Yjs CRDT state grows with
        // history, so this catches both genuine large docs and pathological
        // edit storms. We log loudly because hitting the cap silently would
        // strand edits in memory; raising the cap or compacting is an ops
        // decision, not a protocol-level recovery.
        // eslint-disable-next-line no-console
        console.warn("[yjs-ws] doc exceeds size cap — not persisting", {
          noteId,
          bytes: fullState.byteLength,
          cap: maxDocBytes,
        });
        return;
      }
      // Pull the collaborative subset of Y.Map("metadata") for merge-back
      // into `wpn_notes.metadata`. We merge rather than overwrite so REST-
      // managed fields (r2Key, thumbKey, sizeBytes, …) survive a Yjs flush.
      const ymeta = document.getMap<unknown>("metadata");
      const metaPatch: Partial<Record<CollaborativeMetadataKey, string>> = {};
      let metaPatchHasKeys = false;
      for (const key of COLLABORATIVE_METADATA_KEYS) {
        if (!ymeta.has(key)) continue;
        const v = ymeta.get(key);
        if (typeof v !== "string") continue;
        metaPatch[key] = v;
        metaPatchHasKeys = true;
      }

      // Persist the Yjs snapshot AND the materialised `notes.content`
      // view (and any collab-flow metadata) in a single transaction. If any
      // side fails, all roll back and the next debounced `onStoreDocument`
      // tick retries cleanly — preventing a silent split where `yjs_state`
      // advances but the legacy HTTP readers (detail / list / export) keep
      // returning stale text.
      try {
        const editorUserId =
          (context as { user?: { id?: string } } | undefined)?.user?.id;
        const t = Date.now();
        const setFields: Record<string, unknown> = {
          content: text,
          updatedAtMs: t,
        };
        if (editorUserId) setFields.updatedByUserId = editorUserId;
        await withTx(async (tx) => {
          await adapter.storeDoc(noteId, fullState, tx);
          if (metaPatchHasKeys) {
            // jsonb merge keeps existing keys (r2Key, etc.) intact; the
            // patch overwrites only the collaborative subset.
            await tx.execute(sql`
              UPDATE notes
              SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(metaPatch)}::jsonb,
                  content = ${text},
                  updated_at_ms = ${t}
                  ${editorUserId ? sql`, updated_by_user_id = ${editorUserId}::uuid` : sql``}
              WHERE id = ${noteId}::uuid
            `);
          } else {
            await tx
              .update(notes)
              .set(setFields)
              .where(eq(notes.id, noteId));
          }
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[yjs-ws] persist tx failed (will retry on next debounce):",
          noteId,
          (err as Error).message,
        );
      }
    },
  });

  const server = _sharedServer;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/ws/yjs",
    { websocket: true },
    (socket: unknown, request: { raw: unknown }) => {
      // Hocuspocus reads the document name + token from the protocol auth
      // message; we just hand it the raw socket + request.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.handleConnection(socket as any, request.raw as any);
    },
  );
}
