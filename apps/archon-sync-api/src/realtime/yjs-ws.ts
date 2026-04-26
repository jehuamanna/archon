/**
 * Hocuspocus mount at `GET /v1/ws/yjs`. The Y.Doc selector ("documentName")
 * arrives in the Hocuspocus auth protocol message — the client does NOT
 * carry the noteId in the URL. Each documentName maps to its own Y.Doc;
 * the Postgres adapter from `yjs-pg-adapter.ts` provides the snapshot +
 * incremental log persistence.
 *
 * Auth: short-TTL `typ: "spaceWs"` JWT token in the WS query string. We
 * resolve the note's space (directly from `wpn_notes.spaceId`, falling back
 * to its project's workspace's space for older rows that pre-date the
 * denormalised column) and gate on `effectiveRoleInSpace`.
 *
 * Initial state seeding: when the snapshot is empty (first connection ever
 * on a note), we seed the Y.Text channel `content` with the existing
 * `wpn_notes.content` so the first editor sees the body they expect.
 */
import type { FastifyInstance } from "fastify";
import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { verifyAndTranslate } from "../auth-translate.js";
import { effectiveRoleInSpace } from "../permission-resolver.js";
import { getDb } from "../pg.js";
import { wpnNotes, wpnProjects, wpnWorkspaces } from "../db/schema.js";
import { createYjsPgAdapter, type YjsPgAdapter } from "./yjs-pg-adapter.js";

let _sharedAdapter: YjsPgAdapter | null = null;
export function getYjsAdapter(): YjsPgAdapter {
  if (!_sharedAdapter) _sharedAdapter = createYjsPgAdapter();
  return _sharedAdapter;
}

let _sharedServer: ReturnType<typeof Server.configure> | null = null;
/**
 * Test helper: tear down the shared Hocuspocus server so its internal
 * timers stop and the test process can exit cleanly.
 */
export async function _shutdownYjsServerForTests(): Promise<void> {
  if (_sharedServer) {
    try {
      await _sharedServer.destroy();
    } catch {
      /* ignore */
    }
    _sharedServer = null;
  }
}

async function resolveSpaceForNote(noteId: string): Promise<string | null> {
  const noteRows = await getDb()
    .select({ projectId: wpnNotes.project_id, spaceId: wpnNotes.spaceId })
    .from(wpnNotes)
    .where(eq(wpnNotes.id, noteId))
    .limit(1);
  const note = noteRows[0];
  if (!note) return null;
  if (note.spaceId) return note.spaceId;
  // Fallback through project → workspace for legacy rows.
  const projRows = await getDb()
    .select({ workspaceId: wpnProjects.workspace_id, spaceId: wpnProjects.spaceId })
    .from(wpnProjects)
    .where(eq(wpnProjects.id, note.projectId))
    .limit(1);
  const proj = projRows[0];
  if (!proj) return null;
  if (proj.spaceId) return proj.spaceId;
  const wsRows = await getDb()
    .select({ spaceId: wpnWorkspaces.spaceId })
    .from(wpnWorkspaces)
    .where(eq(wpnWorkspaces.id, proj.workspaceId))
    .limit(1);
  return wsRows[0]?.spaceId ?? null;
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

  _sharedServer = Server.configure({
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    async onAuthenticate({ token, documentName }) {
      const payload = await verifyAndTranslate(jwtSecret, token);
      if (payload.typ !== "spaceWs") {
        throw new Error("wrong token typ");
      }
      const spaceId = await resolveSpaceForNote(documentName);
      if (!spaceId) {
        throw new Error("note has no resolvable space");
      }
      const role = await effectiveRoleInSpace(payload.sub, spaceId);
      if (!role) throw new Error("no access to space");
      return { user: { id: payload.sub, email: payload.email, role } };
    },
    async onLoadDocument({ documentName, document }) {
      const noteId = documentName;
      const stored = await adapter.loadDoc(noteId);
      if (stored && stored.length > 0) {
        Y.applyUpdate(document, stored);
        return document;
      }
      // Q4 default: seed Y.Text 'content' from wpn_notes.content if any.
      const noteRows = await getDb()
        .select({ content: wpnNotes.content })
        .from(wpnNotes)
        .where(eq(wpnNotes.id, noteId))
        .limit(1);
      const seedText = noteRows[0]?.content ?? "";
      if (seedText.length > 0) {
        document.getText("content").insert(0, seedText);
      }
      return document;
    },
    async onStoreDocument({ documentName, document, context }) {
      const noteId = documentName;
      const fullState = Buffer.from(Y.encodeStateAsUpdate(document));
      await adapter.storeDoc(noteId, fullState);
      // Bridge Yjs body state → `wpn_notes.content` so the legacy HTTP
      // detail / list / export endpoints (which read from `wpn_notes`,
      // not `yjs_state`) stay in sync. Without this, switching the
      // editor to push edits over Yjs would freeze `wpn_notes.content`
      // at the seed value forever.
      const text = document.getText("content").toString();
      try {
        const editorUserId =
          (context as { user?: { id?: string } } | undefined)?.user?.id;
        const t = Date.now();
        const setFields: Record<string, unknown> = {
          content: text,
          updated_at_ms: t,
        };
        if (editorUserId) setFields.updated_by_user_id = editorUserId;
        await getDb()
          .update(wpnNotes)
          .set(setFields)
          .where(eq(wpnNotes.id, noteId));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[yjs-ws] bridge wpn_notes.content failed:",
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
