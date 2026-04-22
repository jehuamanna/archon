import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import archiver from "archiver";
import unzipper from "unzipper";
import { requireAuth } from "./auth.js";
import {
  getWpnWorkspacesCollection,
  getWpnProjectsCollection,
  getWpnNotesCollection,
} from "./db.js";
import type {
  WpnWorkspaceDoc,
  WpnProjectDoc,
  WpnNoteDoc,
} from "./db.js";
import {
  buildExportManifest,
  ExportBytesCapExceededError,
  type AssetStreamPlan,
  type ExportWorkspaceInput,
  type WpnExportMetadata,
  type WpnExportNoteEntry,
} from "./export-import-helpers.js";
import { exportMaxAssetBytes, isImageNotesFeatureEnabled } from "./server-env.js";
import { getR2Client, type R2ClientLike } from "./r2-client.js";

type WpnImportResult = {
  workspaces: number;
  projects: number;
  notes: number;
};

function sendErr(reply: FastifyReply, status: number, msg: string) {
  return reply.status(status).send({ error: msg });
}

function nowMs(): number {
  return Date.now();
}

export type RegisterWpnImportExportRoutesOptions = {
  jwtSecret: string;
  /** Test injection point. Production uses {@link getR2Client}. */
  r2Client?: R2ClientLike;
};

export async function registerWpnImportExportRoutes(
  app: FastifyInstance,
  opts: RegisterWpnImportExportRoutesOptions,
): Promise<void> {
  const { jwtSecret } = opts;

  await app.register(import("@fastify/multipart"), {
    limits: { fileSize: 200 * 1024 * 1024 },
  });

  // ── EXPORT ────────────────────────────────────────────────────────────
  app.post("/wpn/export", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const userId = auth.sub;

    const body = request.body as { workspaceIds?: string[] } | undefined;
    const filterIds =
      Array.isArray(body?.workspaceIds) && body!.workspaceIds.length > 0
        ? body!.workspaceIds.filter((x): x is string => typeof x === "string")
        : null;

    const wsCol = getWpnWorkspacesCollection();
    const projCol = getWpnProjectsCollection();
    const noteCol = getWpnNotesCollection();

    const wsQuery: Record<string, unknown> = { userId };
    if (filterIds) wsQuery.id = { $in: filterIds };

    const wsDocs = await wsCol.find(wsQuery).sort({ sort_index: 1, name: 1 }).toArray();
    if (wsDocs.length === 0) {
      return sendErr(reply, 404, "No workspaces found to export");
    }

    const wsIds = wsDocs.map((w) => w.id);
    const projDocs = await projCol
      .find({ userId, workspace_id: { $in: wsIds } })
      .sort({ sort_index: 1, name: 1 })
      .toArray();
    const projIds = projDocs.map((p) => p.id);
    const noteDocs = await noteCol
      .find({ userId, project_id: { $in: projIds }, deleted: { $ne: true } })
      .toArray();

    const notesByProject = new Map<string, WpnNoteDoc[]>();
    for (const n of noteDocs) {
      const arr = notesByProject.get(n.project_id) ?? [];
      arr.push(n as WpnNoteDoc);
      notesByProject.set(n.project_id, arr);
    }

    const workspacesInput: ExportWorkspaceInput[] = wsDocs.map((ws) => {
      const wsProjects = projDocs.filter((p) => p.workspace_id === ws.id);
      return {
        id: ws.id,
        name: ws.name,
        sort_index: ws.sort_index,
        color_token: ws.color_token,
        projects: wsProjects.map((proj) => ({
          id: proj.id,
          name: proj.name,
          sort_index: proj.sort_index,
          color_token: proj.color_token,
          notes: (notesByProject.get(proj.id) ?? []).map((n) => ({
            id: n.id,
            parent_id: n.parent_id,
            type: n.type,
            title: n.title,
            sibling_index: n.sibling_index,
            metadata: n.metadata,
          })),
        })),
      };
    });

    let manifest: { metadata: WpnExportMetadata; assets: AssetStreamPlan[] };
    try {
      manifest = buildExportManifest({
        workspaces: workspacesInput,
        exportedAtMs: nowMs(),
        maxAssetBytes: exportMaxAssetBytes(),
      });
    } catch (e) {
      if (e instanceof ExportBytesCapExceededError) {
        return sendErr(reply, 413, e.message);
      }
      throw e;
    }

    // Streaming binaries requires the image-notes feature + R2 creds.
    // When the flag is off, v2 is still emitted but every image note's
    // metadata lacks `r2Key`, so `manifest.assets` is empty and no R2
    // fetches are attempted.
    let r2: R2ClientLike | null = null;
    if (manifest.assets.length > 0) {
      if (!isImageNotesFeatureEnabled()) {
        return sendErr(
          reply,
          501,
          "Bundle contains image assets but image-notes feature is disabled on this server.",
        );
      }
      try {
        r2 = opts.r2Client ?? getR2Client();
      } catch (e) {
        return sendErr(
          reply,
          500,
          e instanceof Error ? e.message : "R2 client unavailable",
        );
      }
    }

    const archive = archiver("zip", { zlib: { level: 6 } });
    const passthrough = new PassThrough();
    archive.pipe(passthrough);

    archive.on("error", (err) => {
      request.log.error({ err }, "Export archive error");
      passthrough.destroy(err);
    });

    archive.append(JSON.stringify(manifest.metadata, null, 2), {
      name: "metadata.json",
    });

    for (const n of noteDocs) {
      archive.append(n.content ?? "", { name: `notes/${n.id}.md` });
    }

    reply.raw.setHeader("Content-Type", "application/zip");
    reply.raw.setHeader(
      "Content-Disposition",
      'attachment; filename="archon-export.zip"',
    );

    // Kick off the reply before we start fetching R2 bytes so clients see
    // data immediately. Asset streaming fails closed: on any R2 error we
    // destroy both the archive and the passthrough so the client receives
    // a truncated download instead of a silently-incomplete ZIP.
    const response = reply.send(passthrough);

    void (async () => {
      try {
        for (const asset of manifest.assets) {
          if (!r2) {
            throw new Error("R2 client not initialized for asset streaming");
          }
          const bytes = await r2.getObjectBytes({ key: asset.r2Key });
          archive.append(bytes, { name: asset.zipPath });
        }
        await archive.finalize();
      } catch (err) {
        request.log.error(
          { err, assetCount: manifest.assets.length },
          "Export asset streaming failed; aborting archive",
        );
        archive.abort();
        passthrough.destroy(err as Error);
      }
    })();

    return response;
  });

  // ── IMPORT ────────────────────────────────────────────────────────────
  app.post("/wpn/import", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const userId = auth.sub;

    let file: Awaited<ReturnType<typeof request.file>>;
    try {
      file = await request.file();
    } catch {
      return sendErr(reply, 400, "Expected multipart file upload");
    }
    if (!file) {
      return sendErr(reply, 400, "No file uploaded");
    }

    let metadataJson: WpnExportMetadata | null = null;
    const noteContents = new Map<string, string>();

    const directory = await unzipper.Open.buffer(await file.toBuffer());
    for (const entry of directory.files) {
      if (entry.path === "metadata.json") {
        const buf = await entry.buffer();
        metadataJson = JSON.parse(buf.toString("utf-8")) as WpnExportMetadata;
      } else if (entry.path.startsWith("notes/") && entry.path.endsWith(".md")) {
        const noteId = entry.path.slice(6, -3); // strip "notes/" and ".md"
        const buf = await entry.buffer();
        noteContents.set(noteId, buf.toString("utf-8"));
      }
    }

    if (!metadataJson || metadataJson.version !== 1) {
      return sendErr(reply, 400, "Invalid or missing metadata.json in ZIP");
    }

    const wsCol = getWpnWorkspacesCollection();
    const projCol = getWpnProjectsCollection();
    const noteCol = getWpnNotesCollection();

    const existingWs = await wsCol.find({ userId }).toArray();
    const existingNames = new Set(existingWs.map((w) => w.name));

    let importedWs = 0;
    let importedProj = 0;
    let importedNotes = 0;
    const t = nowMs();

    const lastWs = await wsCol.find({ userId }).sort({ sort_index: -1 }).limit(1).toArray();
    let nextWsSortIndex = (lastWs[0]?.sort_index ?? -1) + 1;

    for (const wsEntry of metadataJson.workspaces) {
      let wsName = wsEntry.name;
      if (existingNames.has(wsName)) {
        let suffix = 1;
        while (existingNames.has(`${wsEntry.name} ${suffix}`)) {
          suffix++;
        }
        wsName = `${wsEntry.name} ${suffix}`;
      }
      existingNames.add(wsName);

      const newWsId = randomUUID();
      const wsDoc: WpnWorkspaceDoc = {
        id: newWsId,
        userId,
        name: wsName,
        sort_index: nextWsSortIndex++,
        color_token: wsEntry.color_token,
        created_at_ms: t,
        updated_at_ms: t,
        settings: {},
      };
      await wsCol.insertOne(wsDoc);
      importedWs++;

      let nextProjSortIndex = 0;
      for (const projEntry of wsEntry.projects) {
        const newProjId = randomUUID();
        const projDoc: WpnProjectDoc = {
          id: newProjId,
          userId,
          workspace_id: newWsId,
          name: projEntry.name,
          sort_index: nextProjSortIndex++,
          color_token: projEntry.color_token,
          created_at_ms: t,
          updated_at_ms: t,
          settings: {},
        };
        await projCol.insertOne(projDoc);
        importedProj++;

        // Build old→new ID map for parent_id remapping
        const idMap = new Map<string, string>();
        for (const noteEntry of projEntry.notes) {
          idMap.set(noteEntry.id, randomUUID());
        }

        for (const noteEntry of projEntry.notes) {
          const newNoteId = idMap.get(noteEntry.id)!;
          const newParentId =
            noteEntry.parent_id !== null
              ? idMap.get(noteEntry.parent_id) ?? null
              : null;
          const content = noteContents.get(noteEntry.id) ?? "";
          const noteDoc: WpnNoteDoc = {
            id: newNoteId,
            userId,
            project_id: newProjId,
            parent_id: newParentId,
            type: noteEntry.type,
            title: noteEntry.title,
            content,
            metadata: noteEntry.metadata,
            sibling_index: noteEntry.sibling_index,
            created_at_ms: t,
            updated_at_ms: t,
          };
          await noteCol.insertOne(noteDoc);
          importedNotes++;
        }
      }
    }

    return reply.send({
      imported: {
        workspaces: importedWs,
        projects: importedProj,
        notes: importedNotes,
      } satisfies WpnImportResult,
    });
  });
}
